import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSubmissionPreflight, submissionPreflightContract } from "../scripts/submission-preflight.mjs";

const bytesFor = {
  zip: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]),
  pdf: Buffer.from("%PDF-1.7\nfixture"),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  mp4: Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1]),
  srt: Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nFixture\n"),
  json: Buffer.from('{"status":"fixture"}\n'),
};

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readyMetadata() {
  const urls = Object.fromEntries(["application", "repository", "video", "slides", "cover", "submissionEntry"].map((name) => [name, { url: `https://example.test/${name}`, status: "verified" }]));
  return {
    schemaVersion: "suara.submission_metadata/2",
    submissionMade: false,
    event: { exactSubmissionDeadline: "2026-09-30T23:00:00+08:00", deadlineTimezone: "Asia/Kuala_Lumpur" },
    project: { teamMembers: ["Confirmed tester"], teamStatus: "confirmed", categoryTags: ["Voice AI"], tagsStatus: "selected" },
    submissionAssets: urls,
    verification: {
      liveProviderVerified: true,
      onlineDemoVerified: true,
      realMicrophoneHeardReplyVerified: true,
      matchedThreeArmBenchmarkVerified: true,
      independentBlindScoringVerified: true,
      signedOutSecondDeviceVerified: true,
      finalVideoVerified: true,
      patientBenefitValidated: false,
      customizedGeneratedMemoirImplemented: false,
      productionReady: false,
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "suara-preflight-"));
  await mkdir(join(root, "docs"));
  await mkdir(join(root, "artifacts"));
  const formats = ["zip", "pdf", "png", "mp4", "srt", "json", "zip"];
  const artifacts = [];
  for (const [index, id] of submissionPreflightContract.requiredArtifactIds.entries()) {
    const format = formats[index];
    const value = bytesFor[format];
    const path = `artifacts/${id}.${format}`;
    await writeFile(join(root, ...path.split("/")), value);
    artifacts.push({ id, path, mediaType: "application/octet-stream", format, bytes: value.length, sha256: sha(value) });
  }
  const manifest = {
    schemaVersion: "suara.submission_assets_local/1",
    status: "local_artifacts_verified_not_published",
    checkedOn: "2026-09-14",
    artifacts,
    video: { artifactId: "video_draft_mp4", validationArtifactId: "video_validation_json", durationSeconds: 240, generalLimitSeconds: 300, status: "fixture" },
    release: { artifactId: "public_source_zip", candidateRevision: "v1", entryCount: 1, forbiddenEntryCount: 0, status: "fixture" },
    evidenceBoundary: "fixture",
  };
  await writeFile(join(root, "docs", "submission-assets-local.json"), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(root, "docs", "submission-metadata.json"), `${JSON.stringify(readyMetadata())}\n`);
  return { root, manifest };
}

test("preflight distinguishes a verified local package from submission readiness", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await runSubmissionPreflight({ projectRoot: root });
  assert.equal(report.localPackage.ready, true);
  assert.equal(report.platformFields.ready, true);
  assert.equal(report.evidence.ready, true);
  assert.equal(report.readyForSubmission, true);
  assert.deepEqual(report.warnings, [
    "patient_benefit_unvalidated_keep_claim_absent",
    "customized_generated_memoir_remains_future_work",
    "production_readiness_unproven",
  ]);
});

test("draft URLs and evidence remain explicit blockers even when every local byte passes", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "docs", "submission-metadata.json");
  const metadata = JSON.parse(await readFile(path, "utf8"));
  for (const name of submissionPreflightContract.requiredPublicAssets) metadata.submissionAssets[name] = { url: null, status: "pending" };
  metadata.project = { teamMembers: null, teamStatus: "pending_confirmation", categoryTags: null, tagsStatus: "pending_platform_selection" };
  metadata.event = { exactSubmissionDeadline: null, deadlineTimezone: null };
  for (const field of submissionPreflightContract.requiredEvidence) metadata.verification[field] = false;
  await writeFile(path, `${JSON.stringify(metadata)}\n`);
  const report = await runSubmissionPreflight({ projectRoot: root });
  assert.equal(report.localPackage.ready, true);
  assert.equal(report.readyForSubmission, false);
  assert.equal(report.platformFields.blockers.length, 7);
  assert.equal(report.evidence.blockers.length, 7);
  assert.ok(report.warnings.includes("exact_submission_cutoff_unconfirmed"));
});

test("changed bytes fail integrity without turning an external gate into a pass", async (t) => {
  const { root, manifest } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ...manifest.artifacts[0].path.split("/")), bytesFor.zip.subarray(0, 4));
  const report = await runSubmissionPreflight({ projectRoot: root });
  assert.equal(report.localPackage.ready, false);
  assert.equal(report.readyForSubmission, false);
  assert.match(report.localPackage.blockers[0], /^artifact_deck_pptx_integrity_mismatch$/u);
});

test("asset paths cannot escape the project root", async (t) => {
  const { root, manifest } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  manifest.artifacts[0].path = "../outside.zip";
  await writeFile(join(root, "docs", "submission-assets-local.json"), `${JSON.stringify(manifest)}\n`);
  const report = await runSubmissionPreflight({ projectRoot: root });
  assert.equal(report.localPackage.ready, false);
  assert.equal(report.localPackage.artifactChecks[0].reason, "inspection_error");
});
