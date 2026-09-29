import { createReplayClient, queueReplayFrame } from "./replayClient.js";
import { replayFrames, REPLAY_ERROR_CODES } from "./replayPacer.js";

const TAIL_CHUNKS = 200;
const ERRORS = new Set(["cancelled", "connection", "configuration", "audio", "speech", "access", "capacity", "token", "generic", "start_timeout", "greeting_timeout", "output_timeout", "no_final_transcript", "unclean_end", "event_limit", "clock_invalid", "pacing_failed"]);
const TIMINGS = new Set(["run_started", "ready", "speech_started_received", "speech_stopped_received", "reply_started_received", "first_audio_received", "provider_interrupted", "playback_queue_drained", "playback_scheduled", "playback_flushed", "failure", "ended"]);
const OBSERVATIONS = new Set(["configuration_received", "local_tts_start_callback", "local_tts_interrupted", "local_tts_end_callback", "user_final_received", "provider_receipt:input.speech.started", "provider_receipt:input.speech.stopped", "provider_receipt:reply.started", "provider_receipt:reply.audio", "provider_receipt:reply.done", "provider_receipt:session.ended", "provider_receipt:SpeechStarted", "provider_receipt:Turn.final", "provider_receipt:Turn.partial", "provider_receipt:Termination"]);
const fail = (kind) => { const error = new Error(kind); error.kind = kind; throw error; };

export function replaySleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); reject(Object.assign(new Error("cancelled"), { kind: "cancelled" })); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
  });
}

export function awaitReplayStart(operation, signal, timeoutMs = 35000) {
  // AudioContext.resume() and browser platform work may ignore cancellation.
  // Settle the operator run anyway; its finally disposes the actual client.
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = () => finish(Object.assign(new Error("cancelled"), { kind: "cancelled" }));
    const timer = setTimeout(() => finish(Object.assign(new Error("start_timeout"), { kind: "start_timeout" })), timeoutMs);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    Promise.resolve().then(() => {
      if (!settled) return operation();
    }).then(() => finish(), (error) => finish(error));
  });
}

function withSilenceTail(source) {
  const count = source.metadata.chunkCount;
  return Object.freeze({
    metadata: Object.freeze({ ...source.metadata, chunkCount: count + TAIL_CHUNKS, sourceFrames: (count + TAIL_CHUNKS) * 2400 }),
    frameAt(rate, index) {
      if (![16000, 24000].includes(rate) || !Number.isInteger(index) || index < 0 || index >= count + TAIL_CHUNKS) fail("configuration");
      return index < count ? source.frameAt(rate, index) : new ArrayBuffer(rate / 10);
    },
  });
}

// One explicit run, no automatic next arm, retries or persistence. The three
// production paths have different output stacks; this is not a causal ablation.
export class ReplayRun {
  constructor({ mode, source, accessCode, consent, onUpdate = () => {}, now = () => performance.now(), sleep = replaySleep,
    clientFactory = createReplayClient, send = queueReplayFrame, replay = replayFrames } = {}) {
    const meta = source?.metadata;
    if (consent !== true || !["baseline", "patient", "streaming"].includes(mode) ||
        typeof accessCode !== "string" || !/^[!-~]{16,128}$/.test(accessCode) ||
        meta?.schema !== 1 || !/^[a-f0-9]{64}$/.test(meta.sourceSha256 || "") || meta.sourceRateHz !== 48000 ||
        !Number.isInteger(meta.chunkCount) || meta.chunkCount < 1 || meta.chunkCount > 1200 ||
        meta.chunkMs !== 50 || meta.sourceFrames !== meta.chunkCount * 2400 || meta.durationMs !== meta.chunkCount * 50 ||
        meta.conversion !== "fir63-hamming-causal-v1" || meta.filterDelaySourceFrames !== 31 || typeof source.frameAt !== "function" ||
        ![onUpdate, now, sleep, clientFactory, send, replay].every((value) => typeof value === "function")) fail("configuration");
    this.mode = mode;
    this.source = source;
    this.accessCode = accessCode;
    this.onUpdate = onUpdate;
    this.now = now; this.sleep = sleep; this.clientFactory = clientFactory; this.send = send; this.replay = replay;
    this.controller = new AbortController(); this.client = null; this.started = false; this.finished = false;
    this.origin = null; this.lastClock = null; this.cursor = 0;
    this.report = {
      schema: 1, mode, protocol: "public-fixed-three-replay-v1",
      source: { schema: 1, sourceSha256: meta.sourceSha256, sourceRateHz: 48000, sourceFrames: meta.sourceFrames,
        durationMs: meta.durationMs, chunkMs: 50, chunkCount: meta.chunkCount, conversion: meta.conversion, filterDelaySourceFrames: 31 },
      appendedSilenceFrames: 480000, targetRateHz: mode === "streaming" ? 16000 : 24000,
      inputComplete: false, cleanEnd: false, greetingObserved: false, userFinals: 0, error: null, status: "inconclusive",
      configuration: null, replay: null, replayOriginAtMs: null, pacingError: null,
      events: [], eventsTruncated: false, interpretation: "transport_observations_only",
    };
  }

  clock() {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0 || (this.lastClock !== null && value < this.lastClock)) fail("clock_invalid");
    this.lastClock = value;
    return value;
  }
  update(phase, extra = {}) {
    try { this.onUpdate({ phase, ...extra }); } catch { /* UI diagnostics cannot strand transport. */ }
  }
  observe(kind) {
    if (this.finished || this.origin === null || !OBSERVATIONS.has(kind) && !kind.startsWith("timing:")) return;
    if (kind.startsWith("timing:") && !TIMINGS.has(kind.slice(7))) return;
    // Count nonempty final receipts only after local exposure started. This is
    // still not a transcript/source alignment or proof of recognition accuracy.
    if (kind === "user_final_received" && this.cursor > 0) this.report.userFinals += 1;
    if (this.report.events.length >= 4096) { this.report.eventsTruncated = true; return; }
    try {
      this.report.events.push({ kind, atMs: Math.round((this.clock() - this.origin) * 1000) / 1000, submittedSourceFrames: this.cursor });
    } catch { this.controller.abort(); this.report.error = "clock_invalid"; }
  }
  healthy() {
    if (this.controller.signal.aborted) fail(this.report.error || "cancelled");
    if (this.client?.failureKind) fail(ERRORS.has(this.client.failureKind) ? this.client.failureKind : "generic");
    if (this.client?.isEnding || this.client?.isCleanedUp) fail("connection");
  }
  captureReplay(snapshot) {
    if (!snapshot) return null;
    const { originMs, ...relative } = snapshot;
    this.report.replayOriginAtMs = Number.isFinite(originMs) ? originMs - this.origin : null;
    return relative;
  }
  async waitFor(predicate, timeout, kind, checkTransport = true) {
    const deadline = this.clock() + timeout;
    while (true) {
      if (this.controller.signal.aborted) fail(this.report.error || "cancelled");
      if (checkTransport) this.healthy();
      if (predicate()) return;
      if (this.clock() >= deadline) fail(kind);
      await this.sleep(20, this.controller.signal);
    }
  }
  async start() {
    if (this.started || this.finished || this.controller.signal.aborted) fail("cancelled");
    this.started = true;
    try {
      this.origin = this.clock();
      this.client = this.clientFactory({ mode: this.mode, accessCode: this.accessCode, personalised: false,
        now: () => this.clock(), observe: (kind) => this.observe(kind), onEvent: () => {},
        onTiming: (event) => this.observe(`timing:${event.type}`) });
      this.accessCode = "";
      this.update("connecting");
      await awaitReplayStart(() => this.client.start(), this.controller.signal);
      this.healthy();
      this.update("greeting");
      await this.waitFor(() => this.client.replayGreetingIdle, 45000, "greeting_timeout");
      // Require a continuous quiet interval, not merely a stale greeting flag.
      let quietSince = this.clock();
      await this.waitFor(() => {
        if (!this.client.replayGreetingIdle) quietSince = this.clock();
        return this.client.replayGreetingIdle && this.clock() - quietSince >= 500;
      }, 10000, "greeting_timeout");
      this.report.greetingObserved = true;
      this.report.configuration = this.client.replayConfiguration;
      if (!this.report.configuration) fail("configuration");
      const source = withSilenceTail(this.source);
      this.update("replaying", { framesSent: 0, totalFrames: source.metadata.chunkCount });
      try {
        const replay = await this.replay({ source, rateHz: this.report.targetRateHz, now: () => this.clock(),
          sleep: this.sleep, signal: this.controller.signal,
          sendFrame: (frame) => { this.healthy(); return this.send(this.client, frame); },
          onProgress: (snapshot) => {
            this.cursor = snapshot.submittedSourceFrames;
            if (snapshot.framesSent % 10 === 0) this.update("replaying", { framesSent: snapshot.framesSent, totalFrames: source.metadata.chunkCount });
          } });
        this.report.replay = this.captureReplay(replay);
      } catch (error) {
        this.report.replay = this.captureReplay(error?.snapshot);
        this.report.pacingError = REPLAY_ERROR_CODES.includes(error?.code) ? error.code : "replay_failure";
        if (this.controller.signal.aborted) fail(this.report.error || "cancelled");
        fail("pacing_failed");
      }
      this.report.inputComplete = this.report.replay.inputComplete === true;
      this.cursor = this.report.replay.submittedSourceFrames;
      // Silence already travelled through the same PCM path. This final bounded
      // wait observes output drainage only; it adds no hidden source exposure.
      await this.waitFor(() => !this.client.replyInProgress && this.client.playbackSources.size === 0 &&
        !this.client.speech && !this.client.pendingQuestion, 10000, "output_timeout");
      this.update("ending");
      await this.client.end("user");
      await this.waitFor(() => this.client.isCleanedUp, 3000, "unclean_end", false);
      this.report.cleanEnd = this.client.providerEnded === true;
      if (!this.report.cleanEnd) fail("unclean_end");
      if (!this.report.userFinals) fail("no_final_transcript");
      if (this.report.eventsTruncated) fail("event_limit");
      this.report.status = "complete";
    } catch (error) {
      this.report.error ||= ERRORS.has(error?.kind) ? error.kind : "generic";
    } finally {
      this.finished = true;
      this.accessCode = ""; this.source = null;
      this.client?.dispose();
      this.client = null;
      this.controller.abort();
    }
    const report = structuredClone(this.report);
    this.update(report.status === "complete" ? "complete" : "failed", { error: report.error });
    return report;
  }
  stop() { this.controller.abort(); this.client?.dispose(); }
  dispose() { this.stop(); this.source = null; this.accessCode = ""; this.onUpdate = () => {}; }
}
