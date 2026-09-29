// Private operator diagnostics. This module owns no network, storage, or audio API.
export const MAX_TIMING_EVENTS = 2_000;
export const TIMING_LIMITATIONS = Object.freeze([
  "Manual scripted operator canary; not a controlled replay or participant study.",
  "Times describe browser receipt and scheduling, not acoustic speech boundaries or human intent.",
  "Post-detection reply gaps exclude unknown turn-detection delay and include transport and browser scheduling.",
  "Resumption soon after scheduled playback is a diagnostic pattern, not proof of unintended interruption.",
  "The resumption count requires earlier detected user speech and a new detected start within 2000 ms of scheduled output, before queue drain or flush.",
  "Manual observations have human timing error. No counterfactual baseline or older-adult benefit is inferred.",
  "The baseline request flag records omitted silence thresholds in the sent configuration, not independent verification of the provider's adaptive state.",
  "This export contains no story content; AssemblyAI may retain the underlying voice session separately.",
]);

const MODES = ["baseline", "patient"];
const FIXTURES = ["english-food-v1", "mandarin-food-v1", "code-switch-food-v1"];
const OUTCOMES = ["held", "spoke_during_intended_pause", "uncertain", "invalid"];
const MARKERS = ["pause_start", "resume", "completed_turn", "heard_reply"];
const COMPLETIONS = ["provider_ended", "end_timeout", "disposed"];
const ERROR_KINDS = ["access", "capacity", "token", "microphone", "audio", "connection", "configuration", "generic"];
const SIMPLE_EVENTS = ["run_started", "speech_started_received", "speech_stopped_received", "reply_started_received", "first_audio_received", "playback_queue_drained", "provider_interrupted"];
const time = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 3_600_000;
const nullableNumber = (value, max) => value === null || (time(value) && value <= max);
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function cleanEvent(raw, allowMarker = false) {
  if (!raw || !time(raw.atMs) || typeof raw.type !== "string") return null;
  const base = { type: raw.type, atMs: raw.atMs };
  if (SIMPLE_EVENTS.includes(raw.type)) return exactKeys(raw, ["type", "atMs"]) ? base : null;
  if (raw.type === "ready") {
    const keys = ["type", "atMs", "mode", "silenceThresholdsRequested", "minSilenceMs", "maxSilenceMs", "interruptResponse", "vadThreshold", "interruptionDelayMs", "transcriptionMode", "voice"];
    if (!exactKeys(raw, keys) || !MODES.includes(raw.mode) || ![true, false, null].includes(raw.silenceThresholdsRequested) ||
        !nullableNumber(raw.minSilenceMs, 60_000) || !nullableNumber(raw.maxSilenceMs, 60_000) ||
        ![true, false, null].includes(raw.interruptResponse) || !nullableNumber(raw.vadThreshold, 1) ||
        !nullableNumber(raw.interruptionDelayMs, 1_000) ||
        !["min_latency", "balanced", "max_accuracy", null].includes(raw.transcriptionMode) || !["alba", null].includes(raw.voice)) return null;
    return Object.fromEntries(keys.map((key) => [key, raw[key]]));
  }
  if (raw.type === "playback_scheduled") {
    return exactKeys(raw, ["type", "atMs", "scheduleLeadMs", "outputStartEstimateMs"]) &&
      time(raw.scheduleLeadMs) && nullableNumber(raw.outputStartEstimateMs, 3_600_000)
      ? { ...base, scheduleLeadMs: raw.scheduleLeadMs, outputStartEstimateMs: raw.outputStartEstimateMs } : null;
  }
  if (raw.type === "playback_flushed") return exactKeys(raw, ["type", "atMs", "reason"]) &&
    ["speech_started", "provider_interrupted", "end", "cleanup"].includes(raw.reason) ? { ...base, reason: raw.reason } : null;
  if (raw.type === "ended") return exactKeys(raw, ["type", "atMs", "completion"]) && COMPLETIONS.includes(raw.completion)
    ? { ...base, completion: raw.completion } : null;
  if (raw.type === "failure") return exactKeys(raw, ["type", "atMs", "kind"]) && ERROR_KINDS.includes(raw.kind)
    ? { ...base, kind: raw.kind } : null;
  if (allowMarker && raw.type === "manual_marker") return exactKeys(raw, ["type", "atMs", "marker"]) && MARKERS.includes(raw.marker)
    ? { ...base, marker: raw.marker } : null;
  return null;
}

export class TimingTrace {
  #events = [];
  #mode;
  #fixture;
  #now;
  #origin = null;
  #lastAt = 0;
  #terminal = null;
  #truncated = false;
  #outcome = null;

  constructor({ consent = false, mode, fixture, now = () => performance.now() } = {}) {
    if (consent !== true || !MODES.includes(mode) || !FIXTURES.includes(fixture) || typeof now !== "function") {
      throw new TypeError("Explicit operator consent, a valid mode and a fixed fixture are required");
    }
    this.#mode = mode;
    this.#fixture = fixture;
    this.#now = now;
  }

  #append(event) {
    if (event.atMs < this.#lastAt) return false;
    this.#lastAt = event.atMs;
    if (this.#events.length >= MAX_TIMING_EVENTS) {
      this.#truncated = true;
      return false;
    }
    this.#events.push(event);
    return true;
  }

  record(raw) {
    const event = cleanEvent(raw);
    if (!event || this.#terminal || (event.type === "ready" && event.mode !== this.#mode)) return false;
    if (event.type === "run_started") {
      if (this.#origin !== null || event.atMs !== 0) return false;
      const origin = this.#now();
      if (!Number.isFinite(origin)) return false;
      this.#origin = origin;
    } else if (this.#origin === null) return false;
    if (event.atMs < this.#lastAt) return false;
    if (event.type === "ended") this.#terminal = event.completion;
    if (event.type === "failure") this.#terminal = "failure";
    return this.#append(event);
  }

  mark(marker) {
    if (!MARKERS.includes(marker) || this.#origin === null || this.#terminal) return false;
    const atMs = Math.round(this.#now() - this.#origin);
    if (!time(atMs)) return false;
    return this.#append({ type: "manual_marker", atMs, marker });
  }

  setOutcome(outcome) {
    if (!OUTCOMES.includes(outcome)) return false;
    this.#outcome = outcome;
    return true;
  }

  snapshot() {
    return {
      schemaVersion: 1,
      evidenceClass: "manual_operator_canary",
      mode: this.#mode,
      fixture: this.#fixture,
      clock: "relative_performance_now",
      playbackPolicy: "flush_on_speech_started",
      truncated: this.#truncated,
      terminal: this.#terminal,
      manualOutcome: this.#outcome,
      events: this.#events.map((event) => ({ ...event })),
    };
  }
}

function cleanSnapshot(raw) {
  const keys = ["schemaVersion", "evidenceClass", "mode", "fixture", "clock", "playbackPolicy", "truncated", "terminal", "manualOutcome", "events"];
  if (!exactKeys(raw, keys) || raw.schemaVersion !== 1 || raw.evidenceClass !== "manual_operator_canary" ||
      !MODES.includes(raw.mode) || !FIXTURES.includes(raw.fixture) || raw.clock !== "relative_performance_now" ||
      raw.playbackPolicy !== "flush_on_speech_started" || typeof raw.truncated !== "boolean" ||
      ![...COMPLETIONS, "failure", null].includes(raw.terminal) || ![...OUTCOMES, null].includes(raw.manualOutcome) ||
      !Array.isArray(raw.events) || raw.events.length > MAX_TIMING_EVENTS) return null;
  const events = [];
  let terminal = null;
  for (const item of raw.events) {
    const event = cleanEvent(item, true);
    if (!event || terminal || (events.length && event.atMs < events.at(-1).atMs) ||
        (!events.length && (event.type !== "run_started" || event.atMs !== 0)) ||
        (events.length && event.type === "run_started") || (event.type === "ready" && event.mode !== raw.mode)) return null;
    events.push(event);
    if (event.type === "ended") terminal = event.completion;
    if (event.type === "failure") terminal = "failure";
  }
  if ((!raw.truncated && terminal !== raw.terminal) || (terminal && terminal !== raw.terminal)) return null;
  return { ...Object.fromEntries(keys.filter((key) => key !== "events").map((key) => [key, raw[key]])), events };
}

export function summarizeTiming(raw) {
  const trace = cleanSnapshot(raw);
  if (!trace) throw new TypeError("Invalid content-free timing trace");
  const gaps = [];
  let pendingStop = null;
  let playbackStart = null;
  let resumeAfterPlaybackCount = 0;
  let hadDetectedSpeech = false;
  for (const event of trace.events) {
    if (event.type === "speech_stopped_received") pendingStop = pendingStop === null ? event.atMs : "ambiguous";
    if (event.type === "reply_started_received") {
      if (typeof pendingStop === "number") gaps.push(event.atMs - pendingStop);
      pendingStop = null;
      playbackStart = null;
    }
    if (event.type === "playback_scheduled") playbackStart = event.atMs + event.scheduleLeadMs;
    if (event.type === "speech_started_received") {
      if (hadDetectedSpeech && playbackStart !== null && event.atMs >= playbackStart && event.atMs - playbackStart <= 2_000) resumeAfterPlaybackCount += 1;
      hadDetectedSpeech = true;
      playbackStart = null;
      pendingStop = null;
    }
    if (event.type === "playback_flushed" || event.type === "playback_queue_drained") playbackStart = null;
  }
  return {
    eventCount: trace.events.length,
    completed: trace.terminal === "provider_ended",
    terminal: trace.terminal,
    truncated: trace.truncated,
    postDetectionReplyGapsMs: gaps,
    resumeAfterPlaybackCount,
    manualOutcome: trace.manualOutcome,
    manualMarkersPresent: trace.events.some((event) => event.type === "manual_marker"),
  };
}

export function compareTiming(baselineRaw, patientRaw, { sameConditionsConfirmed = false } = {}) {
  const baseline = cleanSnapshot(baselineRaw);
  const patient = cleanSnapshot(patientRaw);
  const result = { comparable: false, reason: "invalid_trace", baseline: null, patient: null };
  if (!baseline || !patient) return result;
  result.baseline = summarizeTiming(baseline);
  result.patient = summarizeTiming(patient);
  const reject = (reason) => ({ ...result, reason });
  if (sameConditionsConfirmed !== true) return reject("conditions_not_confirmed");
  if (baseline.mode !== "baseline" || patient.mode !== "patient") return reject("mode_mismatch");
  if (baseline.fixture !== patient.fixture || baseline.playbackPolicy !== patient.playbackPolicy) return reject("conditions_mismatch");
  if (!result.baseline.completed || !result.patient.completed) return reject("clean_end_required");
  if (baseline.truncated || patient.truncated) return reject("truncated_trace");
  if (baseline.manualOutcome === "invalid" || patient.manualOutcome === "invalid") return reject("invalid_manual_trial");
  const aReady = baseline.events.filter((event) => event.type === "ready");
  const bReady = patient.events.filter((event) => event.type === "ready");
  if (aReady.length !== 1 || bReady.length !== 1) return reject("resolved_config_required");
  const a = aReady[0];
  const b = bReady[0];
  if (a.silenceThresholdsRequested !== false) return reject("baseline_omission_required");
  if (b.silenceThresholdsRequested !== true || b.minSilenceMs !== 1_200 || b.maxSilenceMs !== 6_000 || !b.interruptResponse) return reject("patient_config_mismatch");
  for (const field of ["vadThreshold", "interruptionDelayMs", "transcriptionMode", "voice", "interruptResponse"]) {
    if (a[field] === null || b[field] === null) return reject("resolved_config_incomplete");
    if (a[field] !== b[field]) return reject("resolved_config_mismatch");
  }
  return { ...result, comparable: true, reason: "observational_comparison_only" };
}

export function exportTiming(rawSnapshots) {
  if (!Array.isArray(rawSnapshots) || rawSnapshots.length < 1 || rawSnapshots.length > 2) throw new TypeError("Export one or two operator traces");
  const traces = rawSnapshots.map(cleanSnapshot);
  if (traces.some((trace) => !trace)) throw new TypeError("Invalid content-free timing trace");
  return JSON.stringify({ schemaVersion: 1, limitations: TIMING_LIMITATIONS, traces, summaries: traces.map(summarizeTiming) }, null, 2);
}
