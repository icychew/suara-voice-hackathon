import { SESSION_PROMPT, SESSION_QUESTIONS } from "./copy.js";
import processorUrl from "./pcm-processor.js?url&no-inline";

const TOKEN_ENDPOINT = "/api/voice/token";
const SESSION_ENDPOINT = "/api/session";
const VOICE_ENDPOINT = "wss://agents.assemblyai.com/v1/ws";
const TARGET_SAMPLE_RATE = 24_000;
const MAX_SOCKET_AUDIO_BACKLOG_BYTES = 256_000;
export const SESSION_LIMIT_MS = 10 * 60 * 1000;
const PATIENT_TURN_DETECTION = Object.freeze({
  min_silence: 1200,
  max_silence: 6000,
  interrupt_response: true,
});

const INITIAL_GREETING =
  `Hello, I’m Suara. I’ll ask three gentle questions, one at a time. ` +
  `Take all the time you need. ${SESSION_QUESTIONS[0]}`;

export function makeClientError(kind) {
  const error = new Error(kind);
  error.kind = kind;
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw makeClientError("cancelled");
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

function base64ToFloat32(value) {
  if (typeof value !== "string") throw makeClientError("audio");
  const binary = atob(value);
  if (binary.length % 2 !== 0) throw makeClientError("audio");
  const sampleCount = Math.floor(binary.length / 2);
  const samples = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    const low = binary.charCodeAt(index * 2);
    const high = binary.charCodeAt(index * 2 + 1);
    const unsigned = low | (high << 8);
    const signed = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
    samples[index] = signed / 32768;
  }

  return samples;
}

export function buildSessionUpdate(mode = "baseline") {
  const input = {
    format: { encoding: "audio/pcm" },
    language_codes: ["en", "zh"],
    voice_focus: "near-field",
  };

  if (mode === "patient") {
    input.turn_detection = { ...PATIENT_TURN_DETECTION };
  }

  return {
    type: "session.update",
    session: {
      system_prompt: SESSION_PROMPT,
      greeting: INITIAL_GREETING,
      input,
      output: {
        voice: "alba",
        format: { encoding: "audio/pcm" },
        volume: 100,
      },
      tools: [],
    },
  };
}

export async function fetchTemporaryToken(signal, accessCode, endpoint = TOKEN_ENDPOINT, questionOptions = null) {
  if (![TOKEN_ENDPOINT, "/api/streaming/token"].includes(endpoint)) throw makeClientError("token");
  if (questionOptions && (endpoint !== "/api/streaming/token" || questionOptions.policy !== "bank-v1" ||
      typeof questionOptions.acceptGrant !== "function")) throw makeClientError("token");
  let sessionResponse;

  try {
    sessionResponse = await fetch(SESSION_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/json", "X-Suara-Access-Code": accessCode },
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  } catch {
    throw makeClientError("token");
  }
  throwIfAborted(signal);

  if (!sessionResponse.ok) {
    if (sessionResponse.status === 401) throw makeClientError("access");
    if (sessionResponse.status === 429) throw makeClientError("capacity");
    throw makeClientError("token");
  }

  let localBearer;
  try {
    const sessionPayload = await sessionResponse.json();
    throwIfAborted(signal);
    localBearer = sessionPayload?.token;
  } catch {
    throw makeClientError("token");
  }

  if (typeof localBearer !== "string" || localBearer.length < 8) {
    throw makeClientError("token");
  }

  let response;

  try {
    throwIfAborted(signal);
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${localBearer}`,
        ...(questionOptions ? { "X-Suara-Question-Policy": questionOptions.policy } : {}),
      },
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  } catch {
    throw makeClientError("token");
  }
  throwIfAborted(signal);

  if (!response.ok) {
    if (response.status === 429) throw makeClientError("capacity");
    throw makeClientError("token");
  }

  let payload;
  try {
    payload = await response.json();
    throwIfAborted(signal);
  } catch {
    throw makeClientError("token");
  }

  if (!payload || typeof payload.token !== "string" || payload.token.length < 8) {
    throw makeClientError("token");
  }
  if (questionOptions) {
    try { questionOptions.acceptGrant(payload.question_access); } catch { throw makeClientError("token"); }
  }

  return payload.token;
}

export class SuaraVoiceClient {
  constructor({ mode = "baseline", accessCode = "", onEvent = () => {}, onTiming = null, now = () => performance.now() } = {}) {
    this.mode = mode;
    this.accessCode = accessCode;
    this.onEvent = onEvent;
    this.onTiming = typeof onTiming === "function" ? onTiming : null;
    this.timingNow = now;
    this.timingOrigin = null;
    this.timingClosed = false;
    this.firstReplyAudioReceived = false;
    this.firstReplyPlaybackScheduled = false;
    this.providerEnded = false;
    this.silenceThresholdsRequested = null;
    this.audioContext = null;
    this.mediaStream = null;
    this.mediaSource = null;
    this.worklet = null;
    this.captureSink = null;
    this.socket = null;
    this.isReady = false;
    this.isEnding = false;
    this.isCleanedUp = false;
    this.playbackTime = 0;
    this.playbackSources = new Set();
    this.limitTimer = null;
    this.connectTimer = null;
    this.endTimer = null;
    this.resolveStart = null;
    this.rejectStart = null;
    this.startController = null;
    this.failureKind = null;
    this.endReason = "complete";
    this.sessionEndSent = false;
    this.replyInProgress = false;
    this.suppressReplyAudio = false;
  }

  emit(type, detail = {}) {
    this.onEvent({ type, ...detail });
  }

  timing(type, detail = {}) {
    if (!this.onTiming || this.timingOrigin === null || this.timingClosed) return;
    try {
      const atMs = type === "run_started" ? 0 : Math.max(0, Math.round(this.timingNow() - this.timingOrigin));
      if (Number.isFinite(atMs)) this.onTiming({ type, atMs, ...detail });
    } catch {
      // Optional operator diagnostics must never interrupt the voice session.
    }
  }

  get tokenEndpoint() { return TOKEN_ENDPOINT; }
  get captureSampleRate() { return TARGET_SAMPLE_RATE; }
  fetchToken(signal) { return fetchTemporaryToken(signal, this.accessCode, this.tokenEndpoint); }

  socketUrl(token) {
    const url = new URL(VOICE_ENDPOINT);
    url.searchParams.set("token", token);
    return url;
  }

  configureSocket() {
    const update = buildSessionUpdate(this.mode);
    const turnDetection = update.session.input.turn_detection || {};
    this.silenceThresholdsRequested = Object.hasOwn(turnDetection, "min_silence") || Object.hasOwn(turnDetection, "max_silence");
    this.socket.send(JSON.stringify(update));
  }

  sendAudioFrame(data) {
    this.socket.send(JSON.stringify({ type: "input.audio", audio: arrayBufferToBase64(data) }));
  }

  terminationPayload() { return { type: "session.end" }; }

  async start() {
    if (this.startController || this.socket || this.audioContext || this.isEnding || this.isCleanedUp) {
      throw makeClientError("generic");
    }

    const controller = new AbortController();
    this.startController = controller;
    if (this.onTiming) {
      this.timingOrigin = this.timingNow();
      this.timing("run_started");
    }
    this.emit("status", { status: "connecting" });

    try {
      this.throwIfStartCancelled(controller.signal);
      if (typeof this.checkAvailability === "function") await this.checkAvailability(controller.signal);
      this.throwIfStartCancelled(controller.signal);
      await this.prepareAudio(controller.signal);
      this.throwIfStartCancelled(controller.signal);
      const tokenTimer = window.setTimeout(() => {
        if (this.connectTimer === tokenTimer && !this.isEnding && !this.isCleanedUp) this.fail("token");
      }, 15_000);
      this.connectTimer = tokenTimer;
      const token = await this.fetchToken(controller.signal);
      this.accessCode = "";
      this.throwIfStartCancelled(controller.signal);
      window.clearTimeout(this.connectTimer);
      await this.openSocket(token);
    } catch (error) {
      if (this.failureKind) throw makeClientError(this.failureKind);
      if (controller.signal.aborted || this.isEnding || this.isCleanedUp) return;
      const kind = error?.kind || "generic";
      this.fail(kind);
      throw error;
    } finally {
      if (this.startController === controller) this.startController = null;
    }
  }

  throwIfStartCancelled(signal) {
    if (signal.aborted || this.isEnding || this.isCleanedUp) {
      throw makeClientError("cancelled");
    }
  }

  async prepareAudio(signal) {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextConstructor || !navigator.mediaDevices?.getUserMedia) {
      throw makeClientError("audio");
    }

    try {
      this.audioContext = new AudioContextConstructor();
      await this.audioContext.resume();
      this.throwIfStartCancelled(signal);
      this.audioContext.addEventListener("statechange", () => {
        if (this.isReady && !this.isEnding && !this.isCleanedUp && this.audioContext.state !== "running") {
          this.fail("audio");
        }
      });
      await this.audioContext.audioWorklet.addModule(processorUrl);
      this.throwIfStartCancelled(signal);
    } catch {
      this.throwIfStartCancelled(signal);
      throw makeClientError("audio");
    }

    let mediaStream;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: true,
        },
      });
    } catch {
      this.throwIfStartCancelled(signal);
      throw makeClientError("microphone");
    }

    if (signal.aborted || this.isEnding || this.isCleanedUp) {
      mediaStream.getTracks().forEach((track) => track.stop());
      throw makeClientError("cancelled");
    }
    this.mediaStream = mediaStream;
    for (const track of mediaStream.getTracks()) {
      const unavailable = () => {
        if (!this.isEnding && !this.isCleanedUp) this.fail("microphone");
      };
      track.addEventListener("ended", unavailable);
      // A muted capture source cannot currently deliver media. Treat that as
      // capture loss, not narrator silence; late unmute must not revive a run
      // whose words may already have been missed.
      track.addEventListener("mute", unavailable);
      if (track.muted === true || track.readyState === "ended") throw makeClientError("microphone");
    }

    try {
      this.mediaSource = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.worklet = new AudioWorkletNode(this.audioContext, "suara-pcm-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          inputSampleRate: this.audioContext.sampleRate,
          targetSampleRate: this.captureSampleRate,
          frameSamples: this.captureSampleRate / 20,
        },
      });
      this.captureSink = this.audioContext.createGain();
      this.captureSink.gain.value = 0;
      this.mediaSource.connect(this.worklet);
      this.worklet.connect(this.captureSink).connect(this.audioContext.destination);
      this.worklet.addEventListener("processorerror", () => {
        if (!this.isEnding && !this.isCleanedUp) this.fail("audio");
      });

      this.worklet.port.onmessage = ({ data }) => {
        if (!this.isReady || this.isEnding || this.isCleanedUp) {
          return;
        }
        // A stalled uplink cannot preserve a conversation in real time. End visibly
        // instead of silently discarding words or replaying an old backlog in a burst.
        if (this.socket?.readyState !== WebSocket.OPEN ||
            this.socket.bufferedAmount > MAX_SOCKET_AUDIO_BACKLOG_BYTES) {
          this.fail("connection");
          return;
        }
        try {
          this.sendAudioFrame(data);
        } catch {
          this.fail("connection");
        }
      };
    } catch {
      throw makeClientError("audio");
    }
  }

  openSocket(token) {
    return new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;

      this.socket = new WebSocket(this.socketUrl(token));

      this.connectTimer = window.setTimeout(() => {
        if (this.isEnding || this.isCleanedUp || this.isReady) return;
        this.fail("connection");
      }, 15_000);

      this.socket.addEventListener("open", () => {
        if (this.isEnding || this.isCleanedUp) {
          try {
            this.socket.close(1000, "Suara session ended");
          } catch {
            // A defensive retry handles browsers that rejected close() while connecting.
          }
          return;
        }
        try {
          this.configureSocket();
        } catch {
          this.fail("connection");
        }
      });

      this.socket.addEventListener("message", (event) => this.handleMessage(event));
      this.socket.addEventListener("error", () => {
        if (!this.isEnding && !this.isCleanedUp) this.fail("connection");
      });
      this.socket.addEventListener("close", () => {
        if (this.isEnding || this.isCleanedUp) {
          this.cleanup({ emitEnded: !this.isCleanedUp, reason: this.endReason });
          return;
        }

        this.rejectPendingStart(makeClientError("connection"));
        this.fail("connection");
      });
    });
  }

  handleMessage(event) {
    if (this.isCleanedUp) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    // The acknowledgement may finish a deliberate end, but queued provider events
    // must never revive capture, playback, or session timers. Authoritative final
    // transcripts can still drain before the acknowledgement (or end timeout).
    if (this.isEnding) {
      if (message.type === "session.ended") {
        this.providerEnded = true;
        this.cleanup({ emitEnded: true, reason: this.endReason });
        return;
      }
      if (!["transcript.user", "transcript.agent"].includes(message.type)) return;
    }
    if (!this.isEnding && !this.isReady && !["session.ready", "session.ended", "session.error", "error"].includes(message.type)) return;

    switch (message.type) {
      case "session.ready": {
        if (this.isReady) break;
        if (this.audioContext?.state !== "running") {
          this.fail("audio");
          break;
        }
        const appliedTurnDetection = message.config?.input?.turn_detection;
        if (
          this.mode === "patient" &&
          (!appliedTurnDetection ||
            appliedTurnDetection.min_silence !== PATIENT_TURN_DETECTION.min_silence ||
            appliedTurnDetection.max_silence !== PATIENT_TURN_DETECTION.max_silence ||
            appliedTurnDetection.interrupt_response !== PATIENT_TURN_DETECTION.interrupt_response)
        ) {
          const error = makeClientError("configuration");
          this.rejectPendingStart(error);
          this.fail("configuration");
          break;
        }
        this.isReady = true;
        const finite = (value, max) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
        const transcriptionMode = message.config?.input?.transcription_mode;
        this.timing("ready", {
          mode: this.mode === "patient" ? "patient" : "baseline",
          silenceThresholdsRequested: this.silenceThresholdsRequested,
          minSilenceMs: finite(appliedTurnDetection?.min_silence, 60_000),
          maxSilenceMs: finite(appliedTurnDetection?.max_silence, 60_000),
          interruptResponse: typeof appliedTurnDetection?.interrupt_response === "boolean" ? appliedTurnDetection.interrupt_response : null,
          vadThreshold: finite(appliedTurnDetection?.vad_threshold, 1),
          interruptionDelayMs: finite(appliedTurnDetection?.interruption_delay, 1_000),
          transcriptionMode: ["min_latency", "balanced", "max_accuracy"].includes(transcriptionMode) ? transcriptionMode : null,
          voice: message.config?.output?.voice === "alba" ? "alba" : null,
        });
        window.clearTimeout(this.connectTimer);
        this.connectTimer = null;
        const startedAt = Date.now();
        this.limitTimer = window.setTimeout(() => {
          if (this.isEnding || this.isCleanedUp) return;
          this.emit("limit");
          void this.end("limit");
        }, SESSION_LIMIT_MS);
        this.emit("ready", {
          endsAt: startedAt + SESSION_LIMIT_MS,
          mode: this.mode,
          startedAt,
        });
        if (this.isEnding || this.isCleanedUp) break;
        this.emit("status", { status: "listening" });
        this.resolvePendingStart();
        break;
      }
      case "input.speech.started":
        this.timing("speech_started_received");
        this.suppressReplyAudio = true;
        this.replyInProgress = false;
        this.stopPlayback("speech_started");
        this.emit("speech-started");
        this.emit("status", { status: "listening" });
        break;
      case "input.speech.stopped":
        this.timing("speech_stopped_received");
        this.emit("speech-stopped");
        this.emit("status", { status: "thinking" });
        break;
      case "transcript.user.delta":
        this.emit("user-delta", { itemId: message.item_id, text: message.text || "" });
        break;
      case "transcript.user":
        this.emit("user-transcript", { itemId: message.item_id, text: message.text || "" });
        break;
      case "reply.started":
        this.firstReplyAudioReceived = false;
        this.firstReplyPlaybackScheduled = false;
        this.timing("reply_started_received");
        this.replyInProgress = true;
        this.suppressReplyAudio = false;
        this.emit("status", { status: "thinking" });
        break;
      case "reply.audio":
        if (!this.firstReplyAudioReceived) {
          this.firstReplyAudioReceived = true;
          this.timing("first_audio_received");
        }
        if (!this.suppressReplyAudio && this.playAudio(message.data)) {
          this.emit("status", { status: "speaking" });
        }
        break;
      case "transcript.agent.delta":
        this.emit("agent-delta", {
          itemId: message.item_id,
          replyId: message.reply_id,
          delta: message.delta || "",
        });
        break;
      case "transcript.agent":
        this.emit("agent-transcript", {
          itemId: message.item_id,
          replyId: message.reply_id,
          text: message.text || "",
          interrupted: Boolean(message.interrupted),
        });
        break;
      case "reply.done":
        this.replyInProgress = false;
        if (message.status === "interrupted") {
          this.timing("provider_interrupted");
          this.suppressReplyAudio = true;
          this.stopPlayback("provider_interrupted");
          this.emit("interrupted", { replyId: message.reply_id });
        }
        if (this.playbackSources.size === 0) this.emit("status", { status: "listening" });
        break;
      case "session.ended":
        this.providerEnded = true;
        if (!this.isReady) this.fail("connection");
        else this.cleanup({ emitEnded: true });
        break;
      case "session.error":
      case "error":
        this.rejectPendingStart(makeClientError("connection"));
        this.fail("connection");
        break;
      default:
        break;
    }
  }

  playAudio(encodedAudio) {
    if (this.isEnding || this.isCleanedUp || !this.isReady || !this.audioContext) return false;

    try {
      if (this.audioContext.state !== "running") throw makeClientError("audio");
      const samples = base64ToFloat32(encodedAudio);
      if (samples.length === 0) return false;
      const buffer = this.audioContext.createBuffer(1, samples.length, TARGET_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);

      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      source.addEventListener("ended", () => {
        if (!this.playbackSources.delete(source)) return;
        source.disconnect();
        if (this.playbackSources.size === 0 && !this.isCleanedUp && !this.isEnding) this.timing("playback_queue_drained");
        if (!this.isEnding && !this.isCleanedUp && !this.replyInProgress && this.playbackSources.size === 0) {
          this.emit("status", { status: "listening" });
        }
      });
      this.playbackSources.add(source);

      const now = this.audioContext.currentTime;
      this.playbackTime = Math.max(this.playbackTime, now);
      source.start(this.playbackTime);
      if (!this.firstReplyPlaybackScheduled) {
        this.firstReplyPlaybackScheduled = true;
        let outputStartEstimateMs = null;
        if (this.onTiming && this.timingOrigin !== null) {
          try {
            const stamp = this.audioContext.getOutputTimestamp?.();
            const estimate = stamp?.performanceTime + (this.playbackTime - stamp?.contextTime) * 1_000 - this.timingOrigin;
            if (Number.isFinite(estimate) && estimate >= 0) outputStartEstimateMs = Math.round(estimate);
          } catch { /* Unsupported output timestamps remain unknown. */ }
        }
        this.timing("playback_scheduled", {
          scheduleLeadMs: Math.max(0, Math.round((this.playbackTime - now) * 1_000)),
          outputStartEstimateMs,
        });
      }
      this.playbackTime += buffer.duration;
      return true;
    } catch {
      this.fail("audio");
      return false;
    }
  }

  stopPlayback(reason = "cleanup") {
    const sources = [...this.playbackSources];
    if (sources.length) this.timing("playback_flushed", {
      reason: ["speech_started", "provider_interrupted", "end", "cleanup"].includes(reason) ? reason : "cleanup",
    });
    this.playbackSources.clear();
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // The source may already have finished between events.
      }
      source.disconnect();
    }
    this.playbackTime = this.audioContext?.currentTime || 0;
  }

  async end(reason = "user") {
    if (this.isCleanedUp || this.isEnding) return;

    this.isEnding = true;
    this.isReady = false;
    this.endReason = reason;
    this.startController?.abort();
    this.resolvePendingStart();
    window.clearTimeout(this.connectTimer);
    window.clearTimeout(this.limitTimer);
    this.emit("status", { status: "ending" });
    this.stopCapture();
    this.stopPlayback("end");

    if (this.sendSessionEnd()) {
      this.endTimer = window.setTimeout(() => {
        this.cleanup({ emitEnded: true, reason });
      }, 2_000);
      return;
    }

    this.cleanup({ emitEnded: true, reason });
  }

  dispose() {
    this.isEnding = true;
    this.isReady = false;

    this.sendSessionEnd();

    this.cleanup({ emitEnded: false });
  }

  stopCapture() {
    if (this.worklet) this.worklet.port.onmessage = null;
    this.mediaStream?.getTracks().forEach((track) => track.stop());

    for (const node of [this.mediaSource, this.worklet, this.captureSink]) {
      try {
        node?.disconnect();
      } catch {
        // A partially initialized audio graph may already be disconnected.
      }
    }
  }

  fail(kind) {
    if (this.isEnding || this.isCleanedUp) return;
    this.failureKind = kind;
    this.rejectPendingStart(makeClientError(kind));
    this.sendSessionEnd();
    this.cleanup({ emitEnded: false });
    this.emit("error", { kind });
  }

  sendSessionEnd() {
    if (this.sessionEndSent || this.socket?.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(this.terminationPayload()));
      this.sessionEndSent = true;
      return true;
    } catch {
      // A failed transport must not prevent releasing the local microphone.
      return false;
    }
  }

  cleanup({ emitEnded = false, reason = "complete" } = {}) {
    if (this.isCleanedUp) return;
    this.isCleanedUp = true;
    this.isReady = false;
    this.accessCode = "";
    this.startController?.abort();

    window.clearTimeout(this.limitTimer);
    window.clearTimeout(this.connectTimer);
    window.clearTimeout(this.endTimer);
    this.limitTimer = null;
    this.connectTimer = null;
    this.endTimer = null;

    this.stopCapture();
    this.stopPlayback();

    if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
      try {
        this.socket.close(1000, "Suara session ended");
      } catch {
        // Browsers may reject close() while the opening handshake is still pending.
      }
    }

    if (this.audioContext && this.audioContext.state !== "closed") {
      try {
        Promise.resolve(this.audioContext.close()).catch(() => {});
      } catch {
        // Capture tracks and graph have already been stopped.
      }
    }

    this.resolvePendingStart();

    if (this.failureKind) {
      const kind = ["access", "capacity", "token", "microphone", "audio", "connection", "configuration", "generic"].includes(this.failureKind) ? this.failureKind : "generic";
      this.timing("failure", { kind });
    } else {
      this.timing("ended", { completion: this.providerEnded ? "provider_ended" : emitEnded ? "end_timeout" : "disposed" });
    }
    this.timingClosed = true;
    if (emitEnded) {
      this.emit("ended", { reason });
    }
  }

  resolvePendingStart() {
    if (!this.resolveStart) return;
    this.resolveStart();
    this.resolveStart = null;
    this.rejectStart = null;
  }

  rejectPendingStart(error) {
    if (!this.rejectStart) return;
    this.rejectStart(error);
    this.resolveStart = null;
    this.rejectStart = null;
  }
}
