import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { replayFrames } from "../src/research/replayPacer.js";
import { MAX_EXPORT_BYTES, parseReplayExport, runBenchmarkValidationCli, validateMatchedReplayExport } from "../scripts/benchmark-validate.mjs";

const encoded = (value) => Buffer.from(JSON.stringify(value));
const SOURCE = { schema: 1, sourceSha256: "a".repeat(64), sourceRateHz: 48000, sourceFrames: 4800,
  durationMs: 100, chunkMs: 50, chunkCount: 2, conversion: "fir63-hamming-causal-v1", filterDelaySourceFrames: 31 };
async function runFixture(mode) {
  let now = 600;
  const events = [
    { kind: "timing:run_started", atMs: 0, submittedSourceFrames: 0 },
    { kind: "configuration_received", atMs: 20, submittedSourceFrames: 0 },
  ];
  if (mode === "streaming") events.push(
    { kind: "local_tts_start_callback", atMs: 30, submittedSourceFrames: 0 },
    { kind: "local_tts_end_callback", atMs: 40, submittedSourceFrames: 0 },
  );
  else events.push(
    { kind: "provider_receipt:reply.audio", atMs: 30, submittedSourceFrames: 0 },
    { kind: "provider_receipt:reply.done", atMs: 35, submittedSourceFrames: 0 },
    { kind: "timing:playback_queue_drained", atMs: 40, submittedSourceFrames: 0 },
  );
  // Actual production pacer, synthetic zero PCM and a deterministic clock. No
  // audio file, speech, microphone, API, database, browser or provider involved.
  const result = await replayFrames({
    source: { metadata: { ...SOURCE, chunkCount: 202, sourceFrames: 484800 }, frameAt: (rate) => new ArrayBuffer(rate / 10) },
    rateHz: mode === "streaming" ? 16000 : 24000, now: () => now, sleep: async (ms) => { now += ms; },
    sendFrame: () => true,
    onProgress: (snapshot) => {
      if (snapshot.framesSent === 2) events.push({ kind: "user_final_received", atMs: now, submittedSourceFrames: 4800 });
    },
  });
  const { originMs, ...replay } = result;
  events.push({ kind: `provider_receipt:${mode === "streaming" ? "Termination" : "session.ended"}`, atMs: now + 20, submittedSourceFrames: 484800 });
  return {
    schema: 1, mode, protocol: "public-fixed-three-replay-v1", source: { ...SOURCE }, appendedSilenceFrames: 480000,
    targetRateHz: mode === "streaming" ? 16000 : 24000, inputComplete: true, cleanEnd: true, greetingObserved: true,
    userFinals: 1, error: null, status: "complete", configuration: mode === "streaming"
      ? { protocol: "streaming_v3", model: "universal-3-5-pro", mode: "max_accuracy", minSilenceMs: null, maxSilenceMs: null,
        controlApplication: "unconfirmed", voice: "browser_reported_local_english" }
      : { protocol: "managed_voice_agent", minSilenceMs: mode === "patient" ? 1200 : null, maxSilenceMs: mode === "patient" ? 6000 : null,
        interruptResponse: mode === "patient" ? true : null, vadThreshold: null, interruptionDelayMs: null, transcriptionMode: null, voice: "alba" },
    replay, replayOriginAtMs: originMs, pacingError: null, events, eventsTruncated: false, interpretation: "transport_observations_only",
  };
}
const fixture = { schema: 1, purpose: "local_transport_diagnostics", reports: await Promise.all(["baseline", "patient", "streaming"].map(runFixture)) };
const runCode = (await readFile(new URL("../src/research/replayRun.js", import.meta.url), "utf8"))
  .replace('import { createReplayClient, queueReplayFrame } from "./replayClient.js";', 'const createReplayClient = () => { throw new Error("live client prohibited"); }; const queueReplayFrame = () => false;')
  .replace('"./replayPacer.js"', JSON.stringify(new URL("../src/research/replayPacer.js", import.meta.url).href));
const { ReplayRun } = await import(`data:text/javascript;base64,${Buffer.from(runCode).toString("base64")}`);
function changed(change) { const bundle = structuredClone(fixture); change(bundle); return validateMatchedReplayExport(encoded(bundle)); }
function rejected(change, code) {
  const receipt = changed(change);
  assert.equal(receipt.transportMatched, false);
  assert.equal(receipt.benchmarkConclusion, "inconclusive");
  assert.equal(receipt.patientBenefitValidated, false);
  assert.ok(receipt.issues.some((issue) => issue.code === code), JSON.stringify(receipt.issues));
  return receipt;
}

test("production-pacer triplet yields deterministic transport validation, never a benefit score", () => {
  const bytes = encoded(fixture); const result = validateMatchedReplayExport(bytes);
  assert.equal(result.status, "matched_transport_ready_for_external_review");
  assert.equal(result.transportMatched, true); assert.equal(result.benchmarkConclusion, "inconclusive");
  assert.equal(result.patientBenefitValidated, false); assert.deepEqual(result.issues, []);
  assert.deepEqual(result.inputOrder, ["baseline", "patient", "streaming"]);
  assert.deepEqual(result.arms.map((arm) => arm.framesSent), [202, 202, 202]);
  assert.equal(result.source.sourceFrames, 4800);
  assert.deepEqual(result.arms.map((arm) => arm.submittedSourceFrames), [484800, 484800, 484800]);
  assert.equal(result.exportSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(validateMatchedReplayExport(bytes), result);
  assert.ok(result.remainingGates.includes("independently_validated_acoustic_alignment_with_uncertainty"));
  assert.doesNotMatch(JSON.stringify(result), /interruptionRate|waitMs|prematureResponse|winner/);
});

test("input order is retained while arm summaries have a stable order", () => {
  const receipt = changed((bundle) => bundle.reports.reverse());
  assert.equal(receipt.transportMatched, true);
  assert.deepEqual(receipt.inputOrder, ["streaming", "patient", "baseline"]);
  assert.deepEqual(receipt.arms.map((arm) => [arm.mode, arm.reportIndex]), [["baseline", 2], ["patient", 1], ["streaming", 0]]);
});

test("current production ReplayRun reports are consumed without a schema conversion or invented timing join", async () => {
  const reports = [];
  for (const mode of ["baseline", "patient", "streaming"]) {
    let now = 100; let sends = 0; let observed;
    const run = new ReplayRun({ mode, source: { metadata: SOURCE, frameAt: (rate) => new ArrayBuffer(rate / 10) },
      accessCode: "synthetic-test-access-only", consent: true,
      now: () => now, sleep: async (ms) => { now += ms; },
      clientFactory(args) {
        observed = args.observe;
        return {
          isReady: true, isEnding: false, isCleanedUp: false, providerEnded: false, replyInProgress: false,
          playbackSources: new Set(), speech: null, pendingQuestion: null, replayGreetingIdle: true,
          replayConfiguration: structuredClone(fixture.reports.find((row) => row.mode === mode).configuration),
          async start() { observed("configuration_received"); },
          async end() { this.isEnding = true; this.isCleanedUp = true; this.providerEnded = true;
            observed(`provider_receipt:${mode === "streaming" ? "Termination" : "session.ended"}`); },
          dispose() { this.isCleanedUp = true; },
        };
      },
      send() { sends += 1; if (sends === 2) observed("user_final_received"); return true; },
    });
    reports.push(await run.start());
  }
  const receipt = validateMatchedReplayExport(encoded({ schema: 1, purpose: "local_transport_diagnostics", reports }));
  assert.equal(receipt.transportMatched, true, JSON.stringify(receipt.issues));
  assert.equal(receipt.benchmarkConclusion, "inconclusive");
  assert.doesNotMatch(JSON.stringify(receipt), /synthetic-test-access-only/);
});

test("missing arms, duplicate arms and six retained attempts are not silently cherry-picked", () => {
  rejected((bundle) => bundle.reports.pop(), "expected_exact_triplet");
  rejected((bundle) => { bundle.reports[2] = structuredClone(bundle.reports[0]); }, "duplicate_or_missing_arm");
  rejected((bundle) => bundle.reports.push(...structuredClone(bundle.reports)), "expected_exact_triplet");
});

test("same duration but different source fingerprints never establish matched source", () => {
  rejected((bundle) => { bundle.reports[1].source.sourceSha256 = "b".repeat(64); }, "source_or_conversion_mismatch");
});

for (const [name, mutate, code] of [
  ["bank protocol", (run) => { run.protocol = "bank-v1"; }, "unsupported_protocol"],
  ["different conversion", (run) => { run.source.conversion = "linear"; }, "invalid_source_metadata"],
  ["wrong source rate", (run) => { run.source.sourceRateHz = 24000; }, "invalid_source_metadata"],
  ["truncated source", (run) => { run.source.sourceFrames -= 1; }, "invalid_source_metadata"],
  ["omitted causal filter delay", (run) => { run.source.filterDelaySourceFrames = 0; }, "invalid_source_metadata"],
  ["different tail", (run) => { run.appendedSilenceFrames -= 2400; }, "input_contract_mismatch"],
  ["wrong transport rate", (run) => { run.targetRateHz = 16000; }, "input_contract_mismatch"],
  ["inconclusive run", (run) => { run.status = "inconclusive"; }, "run_incomplete"],
  ["missing acknowledgement", (run) => { run.cleanEnd = false; }, "run_incomplete"],
  ["truncated events", (run) => { run.eventsTruncated = true; }, "run_incomplete"],
  ["missing nonempty final", (run) => { run.userFinals = 0; }, "invalid_event_receipts"],
  ["provider error details", (run) => { run.error = "PRIVATE provider error"; }, "run_incomplete"],
]) {
  test(`rejects ${name}`, () => { rejected((bundle) => mutate(bundle.reports[0]), code); });
}

test("patient resolved thresholds must still be exact; Streaming application stays unconfirmed", () => {
  rejected((bundle) => { bundle.reports[1].configuration.maxSilenceMs = 5000; }, "patient_configuration_mismatch");
  rejected((bundle) => { bundle.reports[2].configuration.controlApplication = "confirmed"; }, "invalid_configuration");
  rejected((bundle) => { bundle.reports[2].configuration.model = "PRIVATE MODEL"; }, "invalid_configuration");
});

test("provider unknown configuration is retained as unknown, not filled from another arm", () => {
  const result = validateMatchedReplayExport(encoded(fixture));
  assert.equal(result.arms[0].configuration.transcriptionMode, null);
  assert.equal(result.arms[0].configuration.minSilenceMs, null);
  assert.equal(result.arms[2].configuration.controlApplication, "unconfirmed");
});

test("every source frame and every 50ms slot must agree with its array position", () => {
  rejected((bundle) => { bundle.reports[0].replay.sendObservations[4].sourceStartFrame = 0; }, "invalid_send_observation");
  rejected((bundle) => { bundle.reports[0].replay.sendObservations[4].index = 3; }, "invalid_send_observation");
  rejected((bundle) => { bundle.reports[0].replay.sendObservations[4].scheduledAtMs += 1; }, "invalid_send_observation");
  rejected((bundle) => { bundle.reports[0].replay.sendObservations.pop(); }, "incomplete_input_exposure");
});

test("burst spacing and forged pacing aggregates cannot hide an invalid schedule", () => {
  rejected((bundle) => { bundle.reports[0].replay.sendObservations[4].spacingMs = 1; }, "pacing_mismatch");
  rejected((bundle) => { bundle.reports[0].replay.maxLatenessMs = 1; }, "pacing_summary_mismatch");
  rejected((bundle) => { bundle.reports[0].replay.minSpacingMs = 49; }, "pacing_summary_mismatch");
  rejected((bundle) => { bundle.reports[0].replay.elapsedMs -= 1; }, "pacing_mismatch");
  rejected((bundle) => { bundle.reports[0].replay.elapsedMs += 101; }, "pacing_mismatch");
});

test("a valid fractional send schedule keeps full precision and tolerates only receipt rounding", () => {
  const result = changed((bundle) => {
    const replay = bundle.reports[0].replay;
    for (let i = 1; i < replay.sendObservations.length; i += 1) {
      const send = replay.sendObservations[i]; send.sentAtMs += 0.125; send.latenessMs = 0.125;
      if (i === 1) send.spacingMs += 0.125;
    }
    replay.maxLatenessMs = 0.125; replay.elapsedMs += 0.125;
    bundle.reports[0].events.find((event) => event.kind === "user_final_received").atMs += 0.125;
  });
  assert.equal(result.transportMatched, true);
});

test("premature or missing provider end and impossible event cursor are rejected", () => {
  rejected((bundle) => { bundle.reports[0].events.at(-1).atMs -= 100; }, "event_clock_mismatch");
  rejected((bundle) => { bundle.reports[0].events.at(-1).atMs -= 30; }, "premature_provider_end");
  rejected((bundle) => { bundle.reports[0].events.pop(); }, "missing_or_inconsistent_receipts");
  rejected((bundle) => { bundle.reports[0].events.at(-1).submittedSourceFrames += 2400; }, "invalid_event_receipts");
});

test("duplicate configuration receipts and mismatched final counts are rejected", () => {
  rejected((bundle) => { bundle.reports[0].events.splice(2, 0, { ...bundle.reports[0].events[1] }); }, "missing_or_inconsistent_receipts");
  rejected((bundle) => { bundle.reports[0].userFinals += 1; }, "missing_or_inconsistent_receipts");
});

test("events after the terminal provider acknowledgement cannot supply missing evidence", () => {
  rejected((bundle) => {
    const run = bundle.reports[0];
    run.events.push({ kind: "user_final_received", atMs: run.events.at(-1).atMs + 1, submittedSourceFrames: 484800 });
    run.userFinals += 1;
  }, "terminal_event_mismatch");
});

test("unknown fields at every envelope level are rejected without copying private values", () => {
  for (const target of [
    (bundle) => bundle, (bundle) => bundle.reports[0], (bundle) => bundle.reports[0].source,
    (bundle) => bundle.reports[0].configuration, (bundle) => bundle.reports[0].replay,
    (bundle) => bundle.reports[0].replay.sendObservations[0], (bundle) => bundle.reports[0].events[0],
  ]) {
    const receipt = changed((bundle) => { target(bundle).PRIVATE = "PRIVATE transcript, token or path"; });
    assert.equal(receipt.transportMatched, false);
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|transcript, token or path/);
  }
});

test("strict JSON rejects duplicate fields, invalid syntax, nonfinite and oversized exports", () => {
  for (const [text, code] of [
    ['{"schema":0,"schema":1}', "duplicate_json_key"], ['{"schema":0,"\\u0073chema":1}', "duplicate_json_key"],
    ['{"a":[1,]}', "invalid_json"], ['{"a":1,}', "invalid_json"], ['{"a":1e999}', "invalid_json"],
    ['{"a":"unterminated}', "invalid_json"], ['{} extra', "invalid_json"],
    ["[".repeat(25) + "0" + "]".repeat(25), "invalid_json"],
  ]) assert.throws(() => parseReplayExport(Buffer.from(text)), { code });
  assert.throws(() => parseReplayExport(Buffer.from([0xc0, 0xaf])), { code: "invalid_json" });
  assert.throws(() => parseReplayExport(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), { code: "invalid_json" });
  assert.throws(() => parseReplayExport(Buffer.alloc(MAX_EXPORT_BYTES + 1)), { code: "invalid_export_size" });
  const parsed = parseReplayExport(Buffer.from('{"__proto__":{"safe":true},"value":"escaped \\\" text"}'));
  assert.equal(Object.getPrototypeOf(parsed), null); assert.equal(parsed.__proto__.safe, true);
});

test("CLI reports deterministic JSON and distinct structural acceptance without writing files", async () => {
  const writes = []; const reads = [];
  const dependencies = { read: async (path) => { reads.push(path); return encoded(fixture); }, write: (text) => writes.push(text) };
  assert.equal(await runBenchmarkValidationCli(["--input", "synthetic-export.json"], dependencies), 0);
  assert.deepEqual(reads, ["synthetic-export.json"]);
  assert.equal(JSON.parse(writes[0]).benchmarkConclusion, "inconclusive");
  assert.equal(await runBenchmarkValidationCli(["--best", "synthetic-export.json"], dependencies), 2);
  assert.equal(reads.length, 1);
});

test("CLI filesystem and malformed JSON errors never echo private paths or exception messages", async () => {
  const writes = [];
  assert.equal(await runBenchmarkValidationCli(["--input", "PRIVATE-path"], {
    read: async () => { throw new Error("PRIVATE provider key or participant filename"); }, write: (text) => writes.push(text),
  }), 2);
  assert.doesNotMatch(writes.join(""), /PRIVATE|provider key|participant filename/);
});

test("validator has no provider, participant file discovery, durable write, or scoring route", async () => {
  const script = await readFile(new URL("../scripts/benchmark-validate.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(script, /\bfetch\s*\(|\bwriteFile\s*\(|\bmkdir\s*\(|process\.env|readdir\s*\(/);
});
