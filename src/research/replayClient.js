// Operator-only adapter: retain the production token exchange, protocols,
// turn controller, output and cleanup. Replace microphone capture only.
import { SuaraVoiceClient, makeClientError } from "../voice/voiceClient.js";
import { SuaraStreamingClient, waitForLocalVoice } from "../voice/streamingClient.js";

const MANAGED_EVENTS = new Set(["input.speech.started", "input.speech.stopped", "reply.started", "reply.audio", "reply.done", "session.ended"]);
const STREAMING_EVENTS = new Set(["SpeechStarted", "Turn", "Termination"]);
const number = (value, max = 60000) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;

function replayAdapter(Base) {
  return class extends Base {
    constructor(options) {
      super({ ...options, personalised: false });
      this.replayObserve = options.observe || (() => {});
      this.replayGreetingDone = false;
      this.replayOutputObserved = false;
      this.replayConfiguration = null;
    }

    async prepareAudio(signal) {
      // Output is real; input is supplied only by queueReplayFrame. In particular
      // this path never calls getUserMedia, decodeAudioData, or an AudioWorklet.
      if (this.mode === "streaming") {
        if (typeof window.SpeechSynthesisUtterance !== "function") throw makeClientError("speech");
        this.localVoice = await waitForLocalVoice(window.speechSynthesis, signal);
        this.throwIfStartCancelled(signal);
        if (window.speechSynthesis.speaking || window.speechSynthesis.pending) throw makeClientError("speech");
      }
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw makeClientError("audio");
      this.audioContext = new Context();
      await this.audioContext.resume();
      this.throwIfStartCancelled(signal);
      this.audioContext.addEventListener("statechange", () => {
        if (this.isReady && !this.isEnding && !this.isCleanedUp && this.audioContext.state !== "running") this.fail("audio");
      });
    }

    emit(type, detail = {}) {
      if (type === "agent-delta" && this.mode === "streaming") {
        this.replayOutputObserved = true;
        this.replayObserve?.("local_tts_start_callback");
      }
      if (type === "agent-transcript" && this.mode === "streaming") {
        if (!detail.interrupted && this.replayOutputObserved) this.replayGreetingDone = true;
        this.replayObserve?.(detail.interrupted ? "local_tts_interrupted" : "local_tts_end_callback");
      }
      if (type === "user-transcript" && typeof detail.text === "string" && detail.text.length <= 32000 && detail.text.trim()) {
        this.replayObserve?.("user_final_received");
      }
      super.emit(type, detail);
    }

    handleMessage(event) {
      // Observe only bounded, allowlisted metadata. No transcript, audio,
      // session ID or provider-controlled error string enters the receipt.
      if (this.isCleanedUp) return;
      let message;
      if (typeof event.data === "string" && event.data.length <= 256000) {
        try { message = JSON.parse(event.data); } catch { /* Production handler decides lifecycle. */ }
      }
      const wasReady = this.isReady;
      if (message?.type === "reply.started" && wasReady && !this.isEnding) this.replayOutputObserved = false;
      super.handleMessage(event);
      if (!message || typeof message !== "object") return;
      if (message.type === "session.ready" && !wasReady && this.isReady) {
        const config = message.config;
        const turn = config?.input?.turn_detection;
        this.replayConfiguration = {
          protocol: "managed_voice_agent", minSilenceMs: number(turn?.min_silence), maxSilenceMs: number(turn?.max_silence),
          interruptResponse: typeof turn?.interrupt_response === "boolean" ? turn.interrupt_response : null,
          vadThreshold: number(turn?.vad_threshold, 1), interruptionDelayMs: number(turn?.interruption_delay, 1000),
          transcriptionMode: ["min_latency", "balanced", "max_accuracy"].includes(config?.input?.transcription_mode) ? config.input.transcription_mode : null,
          voice: config?.output?.voice === "alba" ? "alba" : null,
        };
        this.replayObserve("configuration_received");
      }
      if (message.type === "Begin" && !wasReady && this.isReady) {
        const config = message.configuration;
        this.replayConfiguration = {
          protocol: "streaming_v3", model: config?.model === "universal-3-5-pro" ? config.model : null,
          mode: config?.mode === "max_accuracy" ? config.mode : null,
          minSilenceMs: number(config?.min_turn_silence), maxSilenceMs: number(config?.max_turn_silence),
          controlApplication: "unconfirmed", voice: "browser_reported_local_english",
        };
        this.replayObserve("configuration_received");
      }
      const allowed = this.mode === "streaming" ? STREAMING_EVENTS : MANAGED_EVENTS;
      if (allowed.has(message.type)) {
        const suffix = message.type === "Turn" ? (message.end_of_turn === true ? ".final" : ".partial") : "";
        this.replayObserve(`provider_receipt:${message.type}${suffix}`);
      }
      if (message.type === "reply.audio" && this.playbackSources.size) this.replayOutputObserved = true;
      if (message.type === "reply.done" && message.status === "completed" && this.replayOutputObserved) this.replayGreetingDone = true;
    }

    get replayGreetingIdle() {
      return this.isReady && !this.isEnding && !this.isCleanedUp && this.replayGreetingDone &&
        !this.replyInProgress && this.playbackSources.size === 0 && !this.speech && !this.pendingQuestion;
    }
  };
}

const ManagedReplayClient = replayAdapter(SuaraVoiceClient);
const StreamingReplayClient = replayAdapter(SuaraStreamingClient);

export function createReplayClient(options) {
  if (!["baseline", "patient", "streaming"].includes(options?.mode)) throw makeClientError("configuration");
  return options.mode === "streaming" ? new StreamingReplayClient(options) : new ManagedReplayClient(options);
}

export function queueReplayFrame(client, buffer) {
  const rate = client.captureSampleRate;
  if (![16000, 24000].includes(rate) || !(buffer instanceof ArrayBuffer) || buffer.byteLength !== rate / 10 ||
      !client.isReady || client.isEnding || client.isCleanedUp || client.socket?.readyState !== WebSocket.OPEN ||
      !Number.isFinite(client.socket.bufferedAmount) || client.socket.bufferedAmount < 0 || client.socket.bufferedAmount > rate) {
    throw makeClientError("connection");
  }
  client.sendAudioFrame(buffer);
  return true; // Only local send() returned; NOT provider consumption.
}
