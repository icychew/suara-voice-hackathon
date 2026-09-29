import assert from "node:assert/strict";
import test from "node:test";
import { TimingTrace, MAX_TIMING_EVENTS, summarizeTiming, compareTiming, exportTiming } from "../src/research/timing.js";

function ready(mode, atMs = 10) {
  return { type: "ready", atMs, mode, silenceThresholdsRequested: mode === "patient", minSilenceMs: mode === "patient" ? 1200 : null,
    maxSilenceMs: mode === "patient" ? 6000 : null, interruptResponse: true,
    vadThreshold: 0.5, interruptionDelayMs: 500, transcriptionMode: "balanced", voice: "alba" };
}

function create(mode = "baseline", fixture = "english-food-v1") {
  let clock = 10_000;
  const trace = new TimingTrace({ consent: true, mode, fixture, now: () => clock });
  trace.record({ type: "run_started", atMs: 0 });
  trace.record(ready(mode));
  return { trace, advance: (milliseconds) => { clock += milliseconds; } };
}

function ended(mode, overrides = {}) {
  const { trace } = create(mode);
  trace.record({ type: "speech_stopped_received", atMs: 100 });
  trace.record({ type: "reply_started_received", atMs: 300 });
  trace.record({ type: "ended", atMs: 1000, completion: "provider_ended" });
  return { ...trace.snapshot(), ...overrides };
}

test("timing requires affirmative operator consent and an allowlisted fixture", () => {
  assert.throws(() => new TimingTrace({ mode: "baseline", fixture: "english-food-v1" }));
  assert.throws(() => new TimingTrace({ consent: true, mode: "baseline", fixture: "private-family-name" }));
  assert.throws(() => new TimingTrace({ consent: "yes", mode: "baseline", fixture: "english-food-v1" }));
});

test("strict events reject content, ids, full configs, nonfinite clocks and unrecognized fields", () => {
  const { trace } = create();
  const before = trace.snapshot();
  for (const field of ["text", "delta", "data", "audio", "item_id", "replyId", "session_id", "token", "config", "url"]) {
    assert.equal(trace.record({ type: "speech_started_received", atMs: 20, [field]: "SECRET_SENTINEL" }), false);
  }
  for (const atMs of [NaN, Infinity, -1, "20", 3_600_001]) assert.equal(trace.record({ type: "speech_started_received", atMs }), false);
  assert.equal(trace.record({ type: "transcript.user", atMs: 20 }), false);
  assert.equal(trace.record({ ...ready("baseline", 20), voice: "SECRET_SENTINEL" }), false);
  assert.equal(trace.record({ type: "failure", atMs: 20, kind: "SECRET_SENTINEL" }), false);
  assert.deepEqual(trace.snapshot(), before);
});

test("manual markers use the run-relative clock and outcomes remain separate from derived patterns", () => {
  const { trace, advance } = create();
  advance(50);
  assert.equal(trace.mark("pause_start"), true);
  advance(2000);
  trace.mark("resume");
  trace.setOutcome("spoke_during_intended_pause");
  const snapshot = trace.snapshot();
  assert.deepEqual(snapshot.events.slice(-2), [
    { type: "manual_marker", atMs: 50, marker: "pause_start" },
    { type: "manual_marker", atMs: 2050, marker: "resume" },
  ]);
  assert.equal(summarizeTiming(snapshot).resumeAfterPlaybackCount, 0);
  assert.equal(trace.mark("SECRET_SENTINEL"), false);
  assert.equal(trace.setOutcome("proven"), false);
});

test("snapshots are detached copies and terminal traces ignore late callbacks or manual timestamps", () => {
  const { trace } = create();
  const copy = trace.snapshot();
  copy.events[0].type = "SECRET_SENTINEL";
  copy.events.push({ text: "SECRET_SENTINEL" });
  trace.record({ type: "ended", atMs: 500, completion: "provider_ended" });
  assert.equal(trace.record({ type: "reply_started_received", atMs: 600 }), false);
  assert.equal(trace.mark("resume"), false);
  assert.equal(trace.setOutcome("held"), true, "operator can label a finished run");
  assert.equal(exportTiming([trace.snapshot()]).includes("SECRET_SENTINEL"), false);
});

test("bounded collection declares truncation and preserves terminal status without retaining overflow", () => {
  const { trace } = create();
  for (let index = 0; index < MAX_TIMING_EVENTS; index += 1) trace.record({ type: "speech_started_received", atMs: index + 20 });
  trace.record({ type: "ended", atMs: 10_000, completion: "provider_ended" });
  const snapshot = trace.snapshot();
  assert.equal(snapshot.events.length, MAX_TIMING_EVENTS);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.terminal, "provider_ended");
  assert.equal(compareTiming(snapshot, ended("patient"), { sameConditionsConfirmed: true }).reason, "truncated_trace");
});

test("post-detection gaps exclude greeting, ambiguous stops and speech that resumed before a reply", () => {
  const { trace } = create();
  for (const [type, atMs] of [
    ["reply_started_received", 20],
    ["speech_stopped_received", 100], ["reply_started_received", 350],
    ["speech_stopped_received", 500], ["speech_stopped_received", 600], ["reply_started_received", 800],
    ["speech_stopped_received", 1000], ["speech_started_received", 1100], ["reply_started_received", 1200],
  ]) trace.record({ type, atMs });
  const summary = summarizeTiming(trace.snapshot());
  assert.deepEqual(summary.postDetectionReplyGapsMs, [250]);
  assert.equal(Object.hasOwn(summary, "silenceHeldMs"), false);
  assert.equal(Object.hasOwn(summary, "interruptionRate"), false);
});

test("resume diagnostic only counts detected speech within two seconds after scheduled start, once", () => {
  const { trace } = create();
  trace.record({ type: "playback_scheduled", atMs: 100, scheduleLeadMs: 500, outputStartEstimateMs: null });
  trace.record({ type: "speech_started_received", atMs: 200 }); // Not playing yet.
  trace.record({ type: "reply_started_received", atMs: 300 });
  trace.record({ type: "playback_scheduled", atMs: 400, scheduleLeadMs: 0, outputStartEstimateMs: 430 });
  trace.record({ type: "speech_started_received", atMs: 800 });
  trace.record({ type: "speech_started_received", atMs: 900 });
  const summary = summarizeTiming(trace.snapshot());
  assert.equal(summary.resumeAfterPlaybackCount, 1);
  assert.equal(summary.manualOutcome, null, "the diagnostic does not invent an intent label");
});

test("comparison requires matched fixture, clean completion, known resolved settings and confirmed conditions", () => {
  const a = ended("baseline");
  const b = ended("patient");
  assert.equal(compareTiming(a, b).reason, "conditions_not_confirmed");
  assert.equal(compareTiming(a, b, { sameConditionsConfirmed: "true" }).reason, "conditions_not_confirmed");
  assert.equal(compareTiming(a, b, { sameConditionsConfirmed: true }).comparable, true);
  assert.equal(compareTiming(a, b, { sameConditionsConfirmed: true }).reason, "observational_comparison_only");
  assert.equal(summarizeTiming(a).manualMarkersPresent, false);
  assert.equal(summarizeTiming(a).manualOutcome, null);
  assert.equal(compareTiming(a, { ...b, fixture: "mandarin-food-v1" }, { sameConditionsConfirmed: true }).reason, "conditions_mismatch");
  const unknown = structuredClone(b);
  unknown.events.find((event) => event.type === "ready").vadThreshold = null;
  assert.equal(compareTiming(a, unknown, { sameConditionsConfirmed: true }).reason, "resolved_config_incomplete");
  const wrong = structuredClone(b);
  wrong.events.find((event) => event.type === "ready").minSilenceMs = 500;
  assert.equal(compareTiming(a, wrong, { sameConditionsConfirmed: true }).reason, "patient_config_mismatch");
  const mismatch = structuredClone(b);
  mismatch.events.find((event) => event.type === "ready").interruptionDelayMs = 0;
  assert.equal(compareTiming(a, mismatch, { sameConditionsConfirmed: true }).reason, "resolved_config_mismatch");
  const misleadingBaseline = structuredClone(a);
  misleadingBaseline.events.find((event) => event.type === "ready").silenceThresholdsRequested = true;
  assert.equal(compareTiming(misleadingBaseline, b, { sameConditionsConfirmed: true }).reason, "baseline_omission_required");
});

test("failure and end timeout cannot masquerade as successful completed canaries", () => {
  for (const terminal of ["failure", "end_timeout", "disposed"]) {
    const { trace } = create();
    trace.record(terminal === "failure" ? { type: "failure", atMs: 30, kind: "connection" }
      : { type: "ended", atMs: 30, completion: terminal });
    assert.equal(summarizeTiming(trace.snapshot()).completed, false);
    assert.equal(compareTiming(trace.snapshot(), ended("patient"), { sameConditionsConfirmed: true }).reason, "clean_end_required");
  }
});

test("a first user utterance during the greeting is not mislabeled as a resumption", () => {
  const { trace } = create();
  trace.record({ type: "playback_scheduled", atMs: 100, scheduleLeadMs: 0, outputStartEstimateMs: null });
  trace.record({ type: "speech_started_received", atMs: 200 });
  assert.equal(summarizeTiming(trace.snapshot()).resumeAfterPlaybackCount, 0);
});

test("export constructs only whitelisted traces, rejects injected data and states observational limits", () => {
  const snapshot = ended("baseline");
  const exported = JSON.parse(exportTiming([snapshot]));
  assert.equal(exported.traces.length, 1);
  assert.match(exported.limitations.join(" "), /not proof of unintended interruption/);
  assert.match(exported.limitations.join(" "), /No counterfactual/);
  assert.throws(() => exportTiming([{ ...snapshot, text: "SECRET_SENTINEL" }]));
  const bad = structuredClone(snapshot);
  bad.events[1].session_id = "SECRET_SENTINEL";
  assert.throws(() => exportTiming([bad]));
  assert.throws(() => exportTiming([snapshot, snapshot, snapshot]));
});

test("collector, summary and export require no storage or network capability", () => {
  const originals = new Map();
  for (const key of ["fetch", "WebSocket", "localStorage", "sessionStorage", "indexedDB"]) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error(`Unexpected ${key}`); } });
  }
  try {
    const { trace } = create();
    trace.record({ type: "ended", atMs: 20, completion: "provider_ended" });
    assert.doesNotThrow(() => exportTiming([trace.snapshot()]));
    assert.doesNotThrow(() => summarizeTiming(trace.snapshot()));
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
