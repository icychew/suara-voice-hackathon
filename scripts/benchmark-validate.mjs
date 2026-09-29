// Local-only consumer of the operator replay export. No audio, provider calls,
// credentials, scoring, persistence or automatic selection of successful runs.
import { createHash } from "node:crypto";
import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_EXPORT_BYTES = 4_500_256;
const MODES = ["baseline", "patient", "streaming"];
const PROTOCOL = "public-fixed-three-replay-v1";
const REPORT_KEYS = ["schema", "mode", "protocol", "source", "appendedSilenceFrames", "targetRateHz", "inputComplete", "cleanEnd", "greetingObserved", "userFinals", "error", "status", "configuration", "replay", "replayOriginAtMs", "pacingError", "events", "eventsTruncated", "interpretation"];
const SOURCE_KEYS = ["schema", "sourceSha256", "sourceRateHz", "sourceFrames", "durationMs", "chunkMs", "chunkCount", "conversion", "filterDelaySourceFrames"];
const REPLAY_KEYS = ["inputComplete", "submittedSourceFrames", "framesSent", "maxLatenessMs", "minSpacingMs", "elapsedMs", "sendObservations"];
const SEND_KEYS = ["index", "sourceStartFrame", "sourceEndFrame", "scheduledAtMs", "sentAtMs", "latenessMs", "spacingMs"];
const MANAGED_KEYS = ["protocol", "minSilenceMs", "maxSilenceMs", "interruptResponse", "vadThreshold", "interruptionDelayMs", "transcriptionMode", "voice"];
const STREAMING_KEYS = ["protocol", "model", "mode", "minSilenceMs", "maxSilenceMs", "controlApplication", "voice"];
const TIMINGS = ["run_started", "ready", "speech_started_received", "speech_stopped_received", "reply_started_received", "first_audio_received", "provider_interrupted", "playback_queue_drained", "playback_scheduled", "playback_flushed", "failure", "ended"];
const COMMON_EVENTS = ["configuration_received", "user_final_received", ...TIMINGS.map((kind) => `timing:${kind}`)];
const MANAGED_EVENTS = ["input.speech.started", "input.speech.stopped", "reply.started", "reply.audio", "reply.done", "session.ended"].map((kind) => `provider_receipt:${kind}`);
const STREAMING_EVENTS = ["local_tts_start_callback", "local_tts_interrupted", "local_tts_end_callback", "provider_receipt:SpeechStarted", "provider_receipt:Turn.final", "provider_receipt:Turn.partial", "provider_receipt:Termination"];
const REMAINING_GATES = Object.freeze([
  "source_permission_and_provenance", "prespecified_candidate_prompt_configuration_and_run_order",
  "complete_attempt_ledger_no_selective_exclusions", "independent_intent_labels_locked_before_outputs",
  "independently_validated_acoustic_alignment_with_uncertainty", "blinded_output_labels_and_blinding_assessment",
  "interruption_and_responsiveness_analysis_with_uncertainty",
]);

class ValidationError extends Error { constructor(code) { super(code); this.code = code; } }
function demand(condition, code) { if (!condition) throw new ValidationError(code); }
const finite = (value, min = 0, max = 1_000_000) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const near = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= 0.000001;
const nullableNumber = (value, maximum) => value === null || finite(value, 0, maximum);
function exactKeys(value, keys, code) {
  demand(value !== null && typeof value === "object" && !Array.isArray(value), code);
  const own = Object.keys(value);
  demand(own.length === keys.length && own.every((key) => keys.includes(key)), code);
}
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

// JSON.parse alone silently accepts duplicate keys. An edited receipt with two
// conflicting statuses/configurations must not be normalized into a valid run.
export function parseReplayExport(bytes) {
  demand(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= MAX_EXPORT_BYTES, "invalid_export_size");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new ValidationError("invalid_json"); }
  demand(text.charCodeAt(0) !== 0xfeff, "invalid_json");
  let at = 0;
  const white = () => { while (/[\t\n\r ]/.test(text[at] || "x")) at += 1; };
  function string() {
    demand(text[at] === '"', "invalid_json"); const start = at++;
    while (at < text.length) {
      const character = text[at++];
      if (character === "\\") { at += 1; continue; }
      if (character === '"') {
        try { return JSON.parse(text.slice(start, at)); } catch { throw new ValidationError("invalid_json"); }
      }
    }
    throw new ValidationError("invalid_json");
  }
  function value(depth) {
    demand(depth <= 20, "invalid_json"); white();
    if (text[at] === '"') return string();
    if (text[at] === "{" || text[at] === "[") {
      const object = text[at++] === "{"; const end = object ? "}" : "]";
      const result = object ? Object.create(null) : []; const seen = new Set();
      white(); if (text[at] === end) { at += 1; return result; }
      while (at < text.length) {
        if (object) {
          white(); const key = string();
          demand(!seen.has(key), "duplicate_json_key"); seen.add(key); white();
          demand(text[at++] === ":", "invalid_json"); result[key] = value(depth + 1);
        } else result.push(value(depth + 1));
        white(); const next = text[at++];
        if (next === end) return result;
        demand(next === ",", "invalid_json");
      }
      throw new ValidationError("invalid_json");
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    demand(Boolean(token), "invalid_json"); at += token[0].length;
    const result = JSON.parse(token[0]);
    demand(typeof result !== "number" || Number.isFinite(result), "invalid_json");
    return result;
  }
  const result = value(0); white(); demand(at === text.length, "invalid_json"); return result;
}

function validateConfiguration(config, mode) {
  exactKeys(config, mode === "streaming" ? STREAMING_KEYS : MANAGED_KEYS, "invalid_configuration");
  demand(nullableNumber(config.minSilenceMs, 60000) && nullableNumber(config.maxSilenceMs, 60000), "invalid_configuration");
  if (config.minSilenceMs !== null && config.maxSilenceMs !== null)
    demand(config.minSilenceMs <= config.maxSilenceMs, "invalid_configuration");
  if (mode === "streaming") {
    demand(config.protocol === "streaming_v3" && config.model === "universal-3-5-pro" && config.mode === "max_accuracy"
      && config.controlApplication === "unconfirmed" && config.voice === "browser_reported_local_english", "invalid_configuration");
  } else {
    demand(config.protocol === "managed_voice_agent" && [true, false, null].includes(config.interruptResponse)
      && nullableNumber(config.vadThreshold, 1) && nullableNumber(config.interruptionDelayMs, 1000)
      && [null, "min_latency", "balanced", "max_accuracy"].includes(config.transcriptionMode)
      && [null, "alba"].includes(config.voice), "invalid_configuration");
    if (mode === "patient") demand(config.minSilenceMs === 1200 && config.maxSilenceMs === 6000 && config.interruptResponse === true, "patient_configuration_mismatch");
  }
}

function validateRun(run, reportIndex) {
  exactKeys(run, REPORT_KEYS, "invalid_report_shape");
  demand(run.schema === 1 && MODES.includes(run.mode) && run.protocol === PROTOCOL
    && run.interpretation === "transport_observations_only", "unsupported_protocol");
  demand(run.status === "complete" && run.inputComplete === true && run.cleanEnd === true && run.greetingObserved === true
    && run.eventsTruncated === false && run.error === null && run.pacingError === null, "run_incomplete");
  exactKeys(run.source, SOURCE_KEYS, "invalid_source_metadata"); const source = run.source;
  demand(source.schema === 1 && /^[a-f0-9]{64}$/.test(source.sourceSha256) && source.sourceRateHz === 48000
    && integer(source.chunkCount, 1, 1200) && source.chunkMs === 50 && source.sourceFrames === source.chunkCount * 2400
    && source.durationMs === source.chunkCount * 50 && source.conversion === "fir63-hamming-causal-v1"
    && source.filterDelaySourceFrames === 31, "invalid_source_metadata");
  demand(run.appendedSilenceFrames === 480000 && run.targetRateHz === (run.mode === "streaming" ? 16000 : 24000), "input_contract_mismatch");
  validateConfiguration(run.configuration, run.mode);
  exactKeys(run.replay, REPLAY_KEYS, "invalid_replay_shape"); const replay = run.replay;
  const chunks = source.chunkCount + 200; const frames = chunks * 2400;
  demand(replay.inputComplete === true && replay.framesSent === chunks && replay.submittedSourceFrames === frames
    && Array.isArray(replay.sendObservations) && replay.sendObservations.length === chunks
    && finite(run.replayOriginAtMs), "incomplete_input_exposure");
  let prior = null; let maxLate = 0; let minSpacing = Infinity;
  for (let index = 0; index < chunks; index += 1) {
    const send = replay.sendObservations[index]; exactKeys(send, SEND_KEYS, "invalid_send_observation");
    demand(send.index === index && send.sourceStartFrame === index * 2400 && send.sourceEndFrame === (index + 1) * 2400
      && send.scheduledAtMs === index * 50 && finite(send.sentAtMs)
      && finite(send.latenessMs, 0, 100) && near(send.latenessMs, send.sentAtMs - send.scheduledAtMs), "invalid_send_observation");
    if (index === 0) demand(send.sentAtMs === 0 && send.spacingMs === null, "invalid_send_observation");
    else {
      demand(finite(send.spacingMs, 40) && near(send.spacingMs, send.sentAtMs - prior), "pacing_mismatch");
      minSpacing = Math.min(minSpacing, send.spacingMs);
    }
    maxLate = Math.max(maxLate, send.latenessMs); prior = send.sentAtMs;
  }
  demand(finite(replay.elapsedMs, Math.max(chunks * 50, prior + 50), chunks * 50 + 100), "pacing_mismatch");
  maxLate = Math.max(maxLate, replay.elapsedMs - chunks * 50);
  demand(near(replay.maxLatenessMs, maxLate) && near(replay.minSpacingMs, minSpacing), "pacing_summary_mismatch");
  demand(Array.isArray(run.events) && run.events.length > 0 && run.events.length <= 4096
    && integer(run.userFinals, 1, 4096), "invalid_event_receipts");
  const allowed = new Set([...COMMON_EVENTS, ...(run.mode === "streaming" ? STREAMING_EVENTS : MANAGED_EVENTS)]);
  let lastTime = 0; let lastCursor = 0; let finals = 0; let configurations = 0; let endings = 0;
  const endKind = `provider_receipt:${run.mode === "streaming" ? "Termination" : "session.ended"}`;
  for (const [eventIndex, event] of run.events.entries()) {
    exactKeys(event, ["kind", "atMs", "submittedSourceFrames"], "invalid_event_receipts");
    demand(allowed.has(event.kind) && finite(event.atMs, lastTime)
      && integer(event.submittedSourceFrames, lastCursor, frames) && event.submittedSourceFrames % 2400 === 0, "invalid_event_receipts");
    if (event.submittedSourceFrames > 0) {
      const send = replay.sendObservations[event.submittedSourceFrames / 2400 - 1];
      // Event times are rounded to 0.001ms; send times retain clock precision.
      demand(event.atMs + 0.001 >= run.replayOriginAtMs + send.sentAtMs, "event_clock_mismatch");
    }
    if (event.kind === "configuration_received") {
      configurations += 1;
      demand(event.submittedSourceFrames === 0 && event.atMs <= run.replayOriginAtMs + 0.001, "event_clock_mismatch");
    }
    if (event.kind === "user_final_received" && event.submittedSourceFrames > 0) finals += 1;
    if (event.kind === "timing:failure") throw new ValidationError("run_incomplete");
    if (event.kind === endKind) {
      endings += 1;
      demand(event.submittedSourceFrames === frames && event.atMs + 0.001 >= run.replayOriginAtMs + replay.elapsedMs, "premature_provider_end");
      demand(eventIndex === run.events.length - 1, "terminal_event_mismatch");
    }
    lastTime = event.atMs; lastCursor = event.submittedSourceFrames;
  }
  demand(configurations === 1 && endings === 1 && finals === run.userFinals, "missing_or_inconsistent_receipts");
  return {
    reportIndex, mode: run.mode, targetRateHz: run.targetRateHz,
    source: { ...source }, configuration: { ...run.configuration },
    framesSent: replay.framesSent, submittedSourceFrames: replay.submittedSourceFrames,
    elapsedMs: replay.elapsedMs, minSpacingMs: replay.minSpacingMs, maxLatenessMs: replay.maxLatenessMs,
    nonemptyFinalReceipts: run.userFinals,
  };
}

export function validateMatchedReplayExport(bytes) {
  const receipt = {
    schema: "suara.matched_transport_validation/1", protocol: PROTOCOL,
    status: "inconclusive", transportMatched: false, benchmarkConclusion: "inconclusive",
    patientBenefitValidated: false, interpretation: "artifact_consistency_not_acoustic_evidence",
    exportSha256: bytes instanceof Uint8Array && bytes.byteLength <= MAX_EXPORT_BYTES ? hash(bytes) : null,
    source: null, inputOrder: [], arms: [], issues: [], remainingGates: [...REMAINING_GATES],
  };
  try {
    const bundle = parseReplayExport(bytes);
    exactKeys(bundle, ["schema", "purpose", "reports"], "invalid_export_shape");
    demand(bundle.schema === 1 && bundle.purpose === "local_transport_diagnostics" && Array.isArray(bundle.reports), "unsupported_export");
    // Never choose the first/best complete arm from a bag of attempts.
    demand(bundle.reports.length === 3, "expected_exact_triplet");
    const checked = [];
    for (let index = 0; index < bundle.reports.length; index += 1) {
      try { checked.push(validateRun(bundle.reports[index], index)); }
      catch (error) { receipt.issues.push({ reportIndex: index, code: error instanceof ValidationError ? error.code : "invalid_report_shape" }); }
    }
    if (receipt.issues.length) return receipt;
    demand(new Set(checked.map((run) => run.mode)).size === 3, "duplicate_or_missing_arm");
    const first = checked[0].source;
    demand(checked.every((run) => SOURCE_KEYS.every((key) => run.source[key] === first[key])), "source_or_conversion_mismatch");
    receipt.source = first;
    receipt.inputOrder = checked.map((run) => run.mode);
    receipt.arms = MODES.map((mode) => {
      const { source: _source, ...summary } = checked.find((run) => run.mode === mode); return summary;
    });
    receipt.transportMatched = true;
    receipt.status = "matched_transport_ready_for_external_review";
  } catch (error) {
    receipt.issues.push({ reportIndex: null, code: error instanceof ValidationError ? error.code : "invalid_export_shape" });
  }
  return receipt;
}

async function readLocalExport(path) {
  demand(typeof path === "string" && path.length > 0 && !/^(?:\\\\|\/\/|[a-z]+:\/\/)/i.test(path), "invalid_input_path");
  const info = await lstat(path);
  demand(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= MAX_EXPORT_BYTES, "invalid_export_size");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat(); demand(opened.isFile() && opened.size <= MAX_EXPORT_BYTES, "invalid_export_size");
    const bytes = Buffer.alloc(MAX_EXPORT_BYTES + 1); let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead;
    }
    demand(length > 0 && length <= MAX_EXPORT_BYTES, "invalid_export_size"); return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

export async function runBenchmarkValidationCli(args, { read = readLocalExport, write = (value) => process.stdout.write(value) } = {}) {
  try {
    demand(args.length === 2 && args[0] === "--input", "usage_expected_input");
    const receipt = validateMatchedReplayExport(await read(args[1]));
    write(`${JSON.stringify(receipt, null, 2)}\n`); return receipt.transportMatched ? 0 : 2;
  } catch (error) {
    const code = error instanceof ValidationError ? error.code : "input_unavailable";
    write(`${JSON.stringify({ schema: "suara.matched_transport_validation/1", status: "inconclusive", transportMatched: false, benchmarkConclusion: "inconclusive", issues: [{ reportIndex: null, code }] })}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runBenchmarkValidationCli(process.argv.slice(2));
}
