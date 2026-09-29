import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const panel = readFileSync(new URL("../src/research/ReplayPanel.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/research/operator.css", import.meta.url), "utf8");
const guard = panel.slice(panel.indexOf("function checkedReport(report)"), panel.indexOf("export default function ReplayPanel"));
const checkedReport = runInNewContext(`${guard}\ncheckedReport`, {
  MODES: { baseline: "baseline", patient: "patient", streaming: "streaming" }, MAX_REPORT_BYTES: 750000, TextEncoder,
});
const report = () => ({ schema: 1, protocol: "public-fixed-three-replay-v1", interpretation: "transport_observations_only",
  mode: "baseline", status: "inconclusive", inputComplete: false, cleanEnd: false,
  source: { sourceSha256: "a".repeat(64) }, events: [], replay: null });

test("panel retains only a detached schema-checked terminal report envelope", () => {
  const input = report();
  const output = checkedReport(input);
  input.source.sourceSha256 = "b".repeat(64);
  assert.equal(output.source.sourceSha256, "a".repeat(64));
  for (const patch of [{ schema: "1" }, { mode: "unknown" }, { status: "running" },
    { inputComplete: "true" }, { cleanEnd: 1 }, { protocol: "other" }, { interpretation: "heard_audio_verified" },
    { source: { sourceSha256: "filename.wav" } }, { events: null }, { replay: {} }]) {
    assert.throws(() => checkedReport({ ...report(), ...patch }), /Report unavailable/);
  }
});

test("report retention rejects event, pacing, and serialized-byte overflow", () => {
  assert.throws(() => checkedReport({ ...report(), events: Array(4097).fill({}) }), /Report unavailable/);
  assert.throws(() => checkedReport({ ...report(), replay: { sendObservations: Array(1401).fill({}) } }), /Report unavailable/);
  assert.throws(() => checkedReport({ ...report(), events: [{ kind: "x".repeat(750000) }] }), /Report unavailable/);
  assert.throws(() => checkedReport({ ...report(), events: [{ kind: "中".repeat(250000) }] }), /Report unavailable/);
});

test("file size is checked before reading, with no retained filename or implicit upload", () => {
  const load = panel.slice(panel.indexOf("async function loadSource"), panel.indexOf("async function startRun"));
  assert.ok(load.indexOf("file.size > MAX_FILE_BYTES") < load.indexOf("file.arrayBuffer()"));
  assert.match(panel, /const MAX_FILE_BYTES = 6_000_000/);
  assert.match(load, /event\.currentTarget\.value = ""/);
  assert.equal(load.match(/generation !== generationRef\.current/g)?.length, 3);
  assert.doesNotMatch(panel, /file\.name|localStorage|sessionStorage|getUserMedia|fetch\(/);
});

test("start is an explicit single-arm event with new consent and no automatic retry", () => {
  const start = panel.slice(panel.indexOf("async function startRun"), panel.indexOf("function stopRun"));
  assert.match(start, /!consent \|\| !validCode\(accessCode\)/);
  assert.match(start, /new ReplayRun\(\{ mode, source: sourceRef\.current, accessCode: code, consent: true/);
  assert.match(start, /setAccessCode\(""\)/);
  assert.match(start, /setConsent\(false\)/);
  assert.equal(start.match(/await run\.start\(\)/g)?.length, 1);
  assert.match(panel, /const MAX_REPORTS = 6/);
  assert.match(start, /reports\.length >= MAX_REPORTS/);
});

test("stop is immediate and clear/unmount invalidate async generations without state updates in cleanup", () => {
  const stop = panel.slice(panel.indexOf("function stopRun"), panel.indexOf("function downloadReports"));
  assert.match(stop, /runRef\.current\?\.stop\(\)/);
  assert.doesNotMatch(stop, /await|setTimeout/);
  assert.match(panel, /generationRef\.current \+= 1/);
  assert.match(panel, /run\?\.dispose\(\)/);
  assert.match(panel, /sourceRef\.current = null/);
  assert.match(panel, /window\.addEventListener\("pagehide", clearAll\)/);
  const cleanup = panel.slice(panel.indexOf("return () => {"), panel.indexOf("}, [clearAll, releaseMemory]);"));
  assert.match(cleanup, /releaseMemory\(\)/);
  assert.doesNotMatch(cleanup, /set[A-Z]\w*\(/);
});

test("diagnostic export stays bounded, local, explicitly clicked and fingerprint-labelled", () => {
  const download = panel.slice(panel.indexOf("function downloadReports"), panel.indexOf("return <section"));
  assert.match(download, /reports\.map\(checkedReport\)/);
  assert.match(download, /MAX_REPORT_BYTES \* MAX_REPORTS \+ 256/);
  assert.match(download, /URL\.createObjectURL/);
  assert.match(download, /URL\.revokeObjectURL/);
  assert.match(panel, /fingerprint, not anonymization/);
  assert.match(panel, /cannot isolate a calibration effect/);
  assert.match(panel, /not source-pause joins, audible onset/);
  assert.match(panel, /checked=\{consent\}/);
  assert.match(panel, /provider processing, possible recording and charges/);
});

test("controls have explicit labels and the replay-only style includes keyboard and mobile treatment", () => {
  for (const id of ["replay-file", "replay-mode", "replay-access", "replay-consent"]) {
    assert.ok(panel.includes(`htmlFor="${id}"`));
    assert.ok(panel.includes(`id="${id}"`));
  }
  assert.match(panel, /type="password"/);
  assert.match(panel, /aria-live="polite"/);
  assert.match(css, /\.replay-panel :is\(button, input, select, summary\):focus-visible/);
  assert.match(css, /@media \(max-width: 520px\)/);
});
