import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LANE_FIXTURES, SHOWCASE_CONTRACT } from "../src/showcase/fixture.js";
import { getIntegrityMetrics, getReviewSummary } from "../src/showcase/integrity.js";

const showcase = await readFile(new URL("../src/showcase/ShowcaseApp.jsx", import.meta.url), "utf8");
const copy = await readFile(new URL("../src/showcase/copy.js", import.meta.url), "utf8");
const page = await readFile(new URL("../prototype/index.html", import.meta.url), "utf8");

test("showcase contract is synthetic, memory-only, and release-blocked", () => {
  assert.equal(SHOWCASE_CONTRACT.syntheticOnly, true);
  assert.equal(SHOWCASE_CONTRACT.realDataUsed, false);
  assert.equal(SHOWCASE_CONTRACT.realModelUsed, false);
  assert.equal(SHOWCASE_CONTRACT.networkRequired, false);
  assert.equal(SHOWCASE_CONTRACT.persistence, "memory_only");
  assert.equal(SHOWCASE_CONTRACT.publishable, false);
  assert.equal(SHOWCASE_CONTRACT.releaseState, "blocked_phase0");
});

test("each speech lane is a fixed three-span Malaysian synthetic fixture", () => {
  assert.deepEqual(Object.keys(LANE_FIXTURES), ["ms", "en", "zh"]);
  for (const lane of Object.values(LANE_FIXTURES)) {
    assert.equal(lane.segments.length, 3);
    assert.deepEqual(lane.segments.map((segment) => segment.id), ["E1", "E2", "E3"]);
    assert.ok(lane.segments.every((segment) => segment.text && segment.time && segment.language));
  }
  assert.match(LANE_FIXTURES.ms.segments[0].text, /Klang/);
  assert.match(LANE_FIXTURES.en.segments[1].text, /1978/);
  assert.match(LANE_FIXTURES.zh.segments[2].text, /年糕/);
});

test("prototype source exposes no network, upload, free-text, or persistent-storage surface", () => {
  const combined = `${showcase}\n${page}`;
  for (const forbidden of [
    /<form\b/i,
    /<input\b/i,
    /<textarea\b/i,
    /\bfetch\s*\(/i,
    /XMLHttpRequest/i,
    /WebSocket/i,
    /\/api\//i,
    /localStorage/i,
    /sessionStorage/i,
    /indexedDB/i,
    /mediaDevices/i,
    /showOpenFilePicker/i,
    /FileReader/i,
  ]) assert.doesNotMatch(combined, forbidden);
});

test("downstream stages are invalidated when their evidence gates change", () => {
  assert.match(showcase, /setMaxStep\(\(current\) => Math\.min\(current, 2\)\)/);
  assert.match(showcase, /setMaxStep\(\(current\) => Math\.min\(current, 4\)\)/);
  assert.match(showcase, /setMaxStep\(\(current\) => Math\.min\(current, 5\)\)/);
});

test("review completion accepts approved or excluded decisions but requires usable evidence", () => {
  const segmentIds = ["E1", "E2", "E3"];
  const mixedReview = getReviewSummary({ E1: "approved", E2: "excluded", E3: "approved" }, segmentIds);
  const unresolvedReview = getReviewSummary({ E1: "approved", E2: "followup", E3: "excluded" }, segmentIds);
  const excludedReview = getReviewSummary({ E1: "excluded", E2: "excluded", E3: "excluded" }, segmentIds);

  assert.equal(mixedReview.allResolved, true);
  assert.equal(mixedReview.approvedCount, 2);
  assert.equal(unresolvedReview.allResolved, false);
  assert.equal(excludedReview.allResolved, true);
  assert.equal(excludedReview.approvedCount, 0);
  assert.match(showcase, /reviewReady = allResolved && approvedCount > 0/);
  assert.match(showcase, /reviewStates\[segment\.id\] === "approved"/);
});

test("integrity metrics reflect reviewed and selected evidence", () => {
  const segmentIds = ["E1", "E2", "E3"];
  const metrics = getIntegrityMetrics({
    contract: SHOWCASE_CONTRACT,
    reviewStates: { E1: "approved", E2: "excluded", E3: "approved" },
    segmentIds,
    selectedEvidence: ["E1"],
  });
  const invalidMetrics = getIntegrityMetrics({
    contract: SHOWCASE_CONTRACT,
    reviewStates: { E1: "approved", E2: "excluded", E3: "approved" },
    segmentIds,
    selectedEvidence: ["E2", "unknown-segment"],
  });

  assert.equal(metrics.precision, 1);
  assert.equal(metrics.recall, 0.5);
  assert.equal(metrics.passedCheckCount, metrics.checkCount);
  assert.equal(invalidMetrics.precision, 0);
  assert.ok(invalidMetrics.passedCheckCount < invalidMetrics.checkCount);
  assert.doesNotMatch(showcase, /<strong>9 \/ 9<\/strong>/);
  assert.doesNotMatch(showcase, /<dd>1\.0<\/dd>/);
});

test("every evidence fragment link has a focusable in-stage target", () => {
  assert.match(showcase, /id={`evidence-\$\{segment\.id\}`}/);
  assert.match(showcase, /targetId={`evidence-\$\{segment\.id\}`}/);
  assert.match(showcase, /id={`memoir-\$\{segment\.id\}`}/);
  assert.match(showcase, /targetId={`memoir-\$\{segment\.id\}`}/);
  assert.match(showcase, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(showcase, /target\.scrollIntoView/);
});

test("prototype is trilingual and keeps release warnings visible", () => {
  assert.match(copy, /Panduan sintetik bergambar/);
  assert.match(copy, /Illustrated synthetic walkthrough/);
  assert.match(copy, /合成数据示范流程/);
  assert.match(copy, /Release blocked/);
  assert.match(copy, /Pelepasan disekat/);
  assert.match(copy, /禁止发布/);
});

test("audio intake labels its playable media as generated fictional narration", () => {
  assert.match(copy, /Playable synthetic sample/);
  assert.match(copy, /Sampel sintetik boleh dimainkan/);
  assert.match(copy, /可播放的合成样本/);
  assert.match(copy, /prepared fictional script.*not live transcription/);
  assert.match(showcase, /FixturePlayer/);
});

test("prototype metadata closes network and form boundaries", () => {
  assert.match(page, /connect-src 'none'/);
  assert.match(page, /form-action 'none'/);
  assert.match(page, /media-src 'self'/);
  assert.match(page, /noindex, nofollow, noarchive/);
});
