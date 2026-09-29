import { SuaraVoiceClient, SESSION_LIMIT_MS, makeClientError, fetchTemporaryToken } from "./voiceClient.js";
import { SESSION_QUESTIONS } from "./copy.js";
import { createPatienceController } from "./patienceController.js";
import { QUESTION_BY_ID, QUESTION_POLICY, OPENING_QUESTION_ID, fallbackQuestion } from "./questionBank.js";
import { validateQuestionGrant, selectionExcerpt, requestBankQuestion } from "./questionClient.js";
import { fetchVoiceCapabilities } from "./capabilities.js";

// Experimental browser integration, not an acoustically validated benchmark arm.
// Keep the fixed-three comparison path separate from optional AI bank selection.
// Only an explicitly opted-in session sends answer excerpts through our server.
const STREAMING_ENDPOINT = "wss://streaming.assemblyai.com/v3/ws";
const STREAM_RATE = 16_000;
const MAX_FRAME_BACKLOG = 16_000; // at most 0.5 s already queued, not wire evidence
const MAX_MESSAGE_CHARS = 256_000;
const GREETING = `Hello, I’m Suara. This is an experimental interview with three questions. ${SESSION_QUESTIONS[0]}`;
const BANK_GREETING = `Hello, I’m Suara. We can explore up to eight questions. You can stop at any time. ${QUESTION_BY_ID[OPENING_QUESTION_ID].text_en}`;
const CLOSING = "Thank you. Your memory preview still needs your review. This interview is now complete.";

export function buildStreamingUrl(token) {
  if (typeof token !== "string" || token.length < 8 || token.length > 4096) throw makeClientError("token");
  const url = new URL(STREAMING_ENDPOINT);
  for (const [key, value] of Object.entries({
    token, sample_rate: STREAM_RATE, encoding: "pcm_s16le",
    speech_model: "universal-3-5-pro", mode: "max_accuracy",
    min_turn_silence: 1200, max_turn_silence: 6000,
    language_codes: JSON.stringify(["en", "zh"]),
    continuous_partials: true, include_partial_turns: true,
    speaker_labels: false, voice_focus: "near-field",
    session_heartbeat: true, inactivity_timeout: 60,
    agent_context: GREETING,
    prompt: "A Malaysian life-story interview. Accept English or Mandarin input; do not assume mixed-language accuracy. Topics include childhood places, family food, traditions and memories.",
  })) url.searchParams.set(key, String(value));
  return url;
}

export function chooseLocalEnglishVoice(voices) {
  if (!Array.isArray(voices)) return null;
  const local = voices.filter((voice) => voice?.localService === true && /^en(?:[-_]|$)/i.test(voice.lang || ""));
  return local.find((voice) => voice.default) || local[0] || null;
}

// Never fall back to a cloud/default voice: that would silently change who
// receives speech text. Availability is checked before microphone/token work.
export async function waitForLocalVoice(synth, signal, timeoutMs = 2000) {
  if (!synth?.getVoices || !synth.addEventListener || !synth.removeEventListener) throw makeClientError("speech");
  if (signal.aborted) throw makeClientError("cancelled");
  const available = chooseLocalEnglishVoice(synth.getVoices());
  if (available) return available;
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (voice, error) => {
      clearTimeout(timer);
      synth.removeEventListener("voiceschanged", changed);
      signal.removeEventListener("abort", cancelled);
      if (error) reject(makeClientError(error)); else resolve(voice);
    };
    const changed = () => {
      const voice = chooseLocalEnglishVoice(synth.getVoices());
      if (voice) finish(voice);
    };
    const cancelled = () => finish(null, "cancelled");
    synth.addEventListener("voiceschanged", changed);
    signal.addEventListener("abort", cancelled, { once: true });
    timer = setTimeout(() => finish(null, "speech"), timeoutMs);
    if (signal.aborted) cancelled(); else changed();
  });
}

export class SuaraStreamingClient extends SuaraVoiceClient {
  constructor(options = {}) {
    super({ ...options, mode: "streaming" });
    this.patience = createPatienceController({ nowMs: this.timingNow });
    this.localVoice = null;
    this.speech = null;
    this.speechTimer = null;
    this.outputEpoch = 0;
    this.questionIndex = 0;
    this.personalised = options.personalised === true;
    this.questionGrant = null;
    this.selectionController = null;
    this.pendingQuestion = null;
    this.askedIds = [];
    this.recentAnswers = [];
    this.lastFinalOrder = -1;
    this.lastPartialOrder = -1;
    this.inputFramesQueued = 0;
    this.updatesQueued = 0;
  }

  get tokenEndpoint() { return "/api/streaming/token"; }
  get captureSampleRate() { return STREAM_RATE; }
  socketUrl(token) {
    const url = buildStreamingUrl(token);
    if (this.personalised) url.searchParams.set("agent_context", BANK_GREETING);
    return url;
  }
  fetchToken(signal) {
    return fetchTemporaryToken(signal, this.accessCode, this.tokenEndpoint, this.personalised ? {
      policy: QUESTION_POLICY,
      acceptGrant: (grant) => { this.questionGrant = validateQuestionGrant(grant); },
    } : null);
  }
  configureSocket() { /* Streaming configuration is in the connection query. */ }
  terminationPayload() { return { type: "Terminate" }; }

  async checkAvailability(signal) {
    if (typeof window.SpeechSynthesisUtterance !== "function") throw makeClientError("speech");
    this.localVoice = await waitForLocalVoice(window.speechSynthesis, signal);
    this.throwIfStartCancelled(signal);
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) throw makeClientError("speech");
    const capabilities = await fetchVoiceCapabilities({ accessCode: this.accessCode, signal });
    this.throwIfStartCancelled(signal);
    this.emit("capabilities", { capabilities });
    if (!capabilities.streaming) throw makeClientError("streamingUnavailable");
    if (this.personalised && !capabilities.aiQuestions) throw makeClientError("questionsUnavailable");
  }

  sendAudioFrame(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength !== 1600 || this.socket.bufferedAmount > MAX_FRAME_BACKLOG) {
      throw makeClientError("connection");
    }
    this.socket.send(data);
    // Browser WebSocket send() acceptance is queue accounting, not measured
    // provider consumption, matched exposure, or a benchmark source-time join.
    this.inputFramesQueued += data.byteLength / 2;
  }

  emitControlState() {
    if (this.isEnding || this.isCleanedUp) return;
    const snapshot = this.patience.snapshot();
    this.emit("streaming-control", { ...snapshot, updatesQueued: this.updatesQueued,
      inputFramesQueued: this.inputFramesQueued, applicationStatus: "unconfirmed" });
  }

  queueControl(update) {
    if (!update || this.isEnding || this.isCleanedUp) return;
    if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > MAX_FRAME_BACKLOG) {
      throw makeClientError("connection");
    }
    this.socket.send(JSON.stringify({ type: "UpdateConfiguration",
      min_turn_silence: update.minimum, max_turn_silence: update.maximum }));
    this.updatesQueued += 1;
    this.patience.submitted(update);
    this.emitControlState();
  }

  handleMessage(event) {
    if (this.isCleanedUp) return;
    if (typeof event.data !== "string" || event.data.length > MAX_MESSAGE_CHARS) { this.fail("connection"); return; }
    let message;
    try { message = JSON.parse(event.data); } catch { this.fail("connection"); return; }
    if (!message || typeof message !== "object") { this.fail("connection"); return; }
    if (message.type === "Termination") {
      if (!this.isReady && !this.isEnding) { this.fail("connection"); return; }
      this.providerEnded = true;
      if (!this.isEnding) this.endReason = "provider";
      this.cleanup({ emitEnded: true, reason: this.endReason });
      return;
    }
    if (message.type === "Error" || message.type === "error") { this.fail("connection"); return; }
    if (this.isEnding && message.type !== "Turn") return;
    if (!this.isReady && !this.isEnding && message.type !== "Begin") return;
    try {
      switch (message.type) {
        case "Begin":
          if (this.isReady || this.isEnding) return;
          if (this.audioContext?.state !== "running") throw makeClientError("audio");
          this.patience.begin(message.configuration || {});
          this.isReady = true;
          window.clearTimeout(this.connectTimer);
          this.connectTimer = null;
          this.limitTimer = window.setTimeout(() => { void this.end("limit"); }, SESSION_LIMIT_MS);
          this.emit("ready", { mode: "streaming", startedAt: Date.now(), endsAt: Date.now() + SESSION_LIMIT_MS });
          if (this.isEnding || this.isCleanedUp) return;
          this.emitControlState();
          if (this.isEnding || this.isCleanedUp) return;
          this.resolvePendingStart();
          this.scheduleQuestion(this.personalised
            ? { text: BANK_GREETING, questionId: OPENING_QUESTION_ID, source: "bank" }
            : { text: GREETING, fixedIndex: 0 });
          break;
        case "SpeechStarted":
          this.stopPlayback("speech_started");
          if (this.isEnding || this.isCleanedUp) return;
          this.emit("speech-started");
          this.emit("status", { status: "listening" });
          break;
        case "Turn":
          this.handleTurn(message);
          break;
        default:
          // Heartbeat/provider metadata must never be mistaken for a turn,
          // configuration acknowledgement, forced ending or intent label.
          break;
      }
    } catch (error) { this.fail(error?.kind || "configuration"); }
  }

  handleTurn(message) {
    const order = message.turn_order;
    if (!Number.isSafeInteger(order) || order < 0 || typeof message.transcript !== "string" || message.transcript.length > 32000) {
      throw makeClientError("configuration");
    }
    if (order <= this.lastFinalOrder || order < this.lastPartialOrder) return;
    if (message.end_of_turn !== true) {
      if (this.isEnding) return;
      this.lastPartialOrder = order;
      if (message.transcript.trim()) this.stopPlayback("speech_started");
      if (this.isEnding || this.isCleanedUp) return;
      this.queueControl(this.patience.partial(order, message.transcript));
      this.emit("user-delta", { itemId: `stream-${order}`, text: message.transcript });
      this.emit("status", { status: "listening" });
      return;
    }
    if (message.turn_is_formatted !== true) return;
    if (!this.isEnding) {
      const result = this.patience.finishTurn(order, message.words);
      if (!result.accepted) return;
      this.queueControl(result.update);
    }
    this.lastFinalOrder = order;
    this.emit("user-transcript", { itemId: `stream-${order}`, text: message.transcript });
    if (this.isEnding || this.isCleanedUp || !message.transcript.trim()) return;
    this.emitControlState();
    if (this.personalised) this.recentAnswers = [...this.recentAnswers.slice(-1), message.transcript];
    this.chooseNextQuestion();
  }

  chooseNextQuestion() {
    // Preserve any selected question that never started speaking. Advancing at
    // selection/queue time used to skip questions when the narrator barged in.
    const pending = this.pendingQuestion;
    this.stopPlayback("next_question");
    if (this.isEnding || this.isCleanedUp || !this.isReady) return;
    if (pending) { this.scheduleQuestion(pending); return; }
    if (!this.personalised) {
      this.scheduleQuestion(this.questionIndex >= SESSION_QUESTIONS.length
        ? { text: CLOSING, closing: true }
        : { text: this.questionIndex === 0 ? GREETING : SESSION_QUESTIONS[this.questionIndex], fixedIndex: this.questionIndex });
      return;
    }
    const fallback = fallbackQuestion(this.askedIds);
    if (!fallback) { this.scheduleQuestion({ text: CLOSING, closing: true }); return; }
    if (!this.askedIds.length || !this.questionGrant) {
      this.scheduleQuestion({ text: this.askedIds.length ? fallback.text_en : BANK_GREETING,
        questionId: fallback.id, source: this.askedIds.length ? "fallback" : "bank" });
      return;
    }
    const epoch = this.outputEpoch;
    const controller = new AbortController();
    this.selectionController = controller;
    this.emit("question-selection", { source: "pending" });
    this.emit("status", { status: "thinking" });
    // Do not await in the provider reader. One pending selection, no retry or
    // queue, with epoch/abort checks before any model choice can become speech.
    void (async () => {
      let choice = fallback;
      let source = "fallback";
      try {
        const result = await requestBankQuestion({ ...this.questionGrant, transcript: selectionExcerpt(this.recentAnswers),
          askedIds: this.askedIds, signal: controller.signal });
        if (controller.signal.aborted || epoch !== this.outputEpoch || this.isEnding || this.isCleanedUp) return;
        this.questionGrant.sequence = result.nextSequence;
        choice = QUESTION_BY_ID[result.questionId];
        source = "ai";
      } catch {
        // A timeout/abort may have consumed a paid call or committed a choice.
        // Abandon this capability for the session; never automatically replay.
        this.questionGrant = null;
      } finally {
        if (this.selectionController === controller) this.selectionController = null;
      }
      if (controller.signal.aborted || epoch !== this.outputEpoch || this.isEnding || this.isCleanedUp) return;
      this.scheduleQuestion({ text: choice.text_en, questionId: choice.id, source });
    })();
  }

  scheduleQuestion(question) {
    this.stopPlayback("next_question");
    if (this.isEnding || this.isCleanedUp || !this.isReady) return;
    this.pendingQuestion = question;
    const epoch = this.outputEpoch;
    this.emit("status", { status: "thinking" });
    // Leave the event handler before output begins. New speech, stop, reset or
    // a newer final can invalidate this bounded single pending response.
    queueMicrotask(() => {
      if (epoch !== this.outputEpoch || !this.isReady || this.isEnding || this.isCleanedUp) return;
      try { this.speakQuestion(question); } catch { this.fail("speech"); }
    });
  }

  speakQuestion(question) {
    const { text, closing = false } = question;
    if (!this.localVoice || this.localVoice.localService !== true || !/^en(?:[-_]|$)/i.test(this.localVoice.lang || "")) {
      throw makeClientError("speech");
    }
    if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > MAX_FRAME_BACKLOG) throw makeClientError("connection");
    this.socket.send(JSON.stringify({ type: "UpdateConfiguration", agent_context: text }));
    const utterance = new window.SpeechSynthesisUtterance(text);
    utterance.voice = this.localVoice;
    utterance.lang = this.localVoice.lang;
    utterance.rate = 0.9;
    const speech = { utterance, text, replyId: `local-${this.outputEpoch}`, started: false, closing };
    this.speech = speech;
    const current = () => this.speech === speech && !this.isEnding && !this.isCleanedUp;
    const armTimeout = (ms) => {
      window.clearTimeout(this.speechTimer);
      this.speechTimer = window.setTimeout(() => { if (current()) this.fail("speech"); }, ms);
    };
    utterance.onstart = () => {
      if (!current() || speech.started) return;
      speech.started = true;
      if (this.pendingQuestion === question) this.pendingQuestion = null;
      if (question.questionId) this.askedIds.push(question.questionId);
      else if (Number.isInteger(question.fixedIndex)) this.questionIndex = question.fixedIndex + 1;
      if (question.source) this.emit("question-selection", { source: question.source, questionsStarted: this.askedIds.length });
      if (!current()) return;
      armTimeout(30_000);
      this.emit("agent-delta", { replyId: speech.replyId, delta: text });
      this.emit("status", { status: "speaking" });
    };
    utterance.onend = () => {
      if (!current()) return;
      if (!speech.started) { this.fail("speech"); return; }
      window.clearTimeout(this.speechTimer);
      this.speech = null;
      this.emit("agent-transcript", { replyId: speech.replyId, text, interrupted: false });
      if (closing) void this.end("complete");
      else this.emit("status", { status: "listening" });
    };
    utterance.onerror = () => { if (current()) this.fail("speech"); };
    armTimeout(5000);
    window.speechSynthesis.speak(utterance);
  }

  stopPlayback(reason = "cleanup") {
    this.outputEpoch += 1;
    if (this.selectionController) {
      this.questionGrant = null;
      this.selectionController.abort();
      this.selectionController = null;
      if (!this.isEnding && !this.isCleanedUp) this.emit("question-selection", { source: "fallback" });
    }
    window.clearTimeout(this.speechTimer);
    this.speechTimer = null;
    const speech = this.speech;
    this.speech = null;
    if (speech) {
      speech.utterance.onstart = null;
      speech.utterance.onend = null;
      speech.utterance.onerror = null;
      try { window.speechSynthesis.cancel(); } catch {
        // A platform exception must not strand the microphone/socket/context.
        // This is best-effort device cancellation, never acoustic-stop proof.
        this.failureKind ||= "speech";
        if (!this.isEnding && !this.isCleanedUp) { this.fail("speech"); return; }
      }
      if (speech.started && !this.isCleanedUp) this.emit("agent-transcript", { replyId: speech.replyId, text: speech.text, interrupted: true });
    }
    super.stopPlayback(reason);
  }

  cleanup(options = {}) {
    this.patience.close();
    super.cleanup(options);
    this.localVoice = null;
    this.questionGrant = null;
    this.pendingQuestion = null;
    this.recentAnswers = [];
    this.askedIds = [];
  }
}
