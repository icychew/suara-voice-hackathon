import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REQUIRED_ARTIFACT_IDS = Object.freeze([
  "deck_pptx",
  "slides_pdf",
  "cover_png",
  "video_draft_mp4",
  "video_captions_srt",
  "video_validation_json",
  "public_source_zip",
]);
const REQUIRED_PUBLIC_ASSETS = Object.freeze(["application", "repository", "video", "slides", "cover"]);
const REQUIRED_EVIDENCE = Object.freeze([
  "liveProviderVerified",
  "onlineDemoVerified",
  "realMicrophoneHeardReplyVerified",
  "matchedThreeArmBenchmarkVerified",
  "independentBlindScoringVerified",
  "signedOutSecondDeviceVerified",
  "finalVideoVerified",
]);

function asRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function asNonemptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be a nonempty string`);
  return value;
}

function safeProjectFile(projectRoot, candidate, label) {
  const path = asNonemptyString(candidate, label);
  if (isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")) {
    throw new TypeError(`${label} must be a project-relative forward-slash path`);
  }
  const root = resolve(projectRoot);
  const target = resolve(root, ...path.split("/"));
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new TypeError(`${label} escapes the project root`);
  }
  return target;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function firstBytes(path, count = 32) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function formatMatches(path, format) {
  const head = await firstBytes(path);
  if (format === "zip") return head[0] === 0x50 && head[1] === 0x4b;
  if (format === "pdf") return head.subarray(0, 5).toString("ascii") === "%PDF-";
  if (format === "png") return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (format === "mp4") return head.subarray(4, 8).toString("ascii") === "ftyp";
  if (format === "srt") return /^\ufeff?1\s*\r?\n\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/u.test(await readFile(path, "utf8"));
  if (format === "json") {
    try {
      asRecord(JSON.parse(await readFile(path, "utf8")), "JSON artifact");
      return true;
    } catch {
      return false;
    }
  }
  throw new TypeError(`unsupported artifact format: ${format}`);
}

function isVerifiedHttps(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.hash === "";
  } catch {
    return false;
  }
}

function validateAssetManifest(manifest) {
  asRecord(manifest, "asset manifest");
  if (manifest.schemaVersion !== "suara.submission_assets_local/1") throw new TypeError("unsupported asset-manifest schema");
  if (manifest.status !== "local_artifacts_verified_not_published") throw new TypeError("unexpected asset-manifest status");
  if (!Array.isArray(manifest.artifacts)) throw new TypeError("asset manifest artifacts must be an array");
  const ids = new Set();
  for (const item of manifest.artifacts) {
    asRecord(item, "artifact");
    const id = asNonemptyString(item.id, "artifact.id");
    if (ids.has(id)) throw new TypeError(`duplicate artifact id: ${id}`);
    ids.add(id);
    asNonemptyString(item.path, `artifact ${id} path`);
    asNonemptyString(item.mediaType, `artifact ${id} mediaType`);
    asNonemptyString(item.format, `artifact ${id} format`);
    if (!Number.isSafeInteger(item.bytes) || item.bytes <= 0) throw new TypeError(`artifact ${id} bytes must be positive`);
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw new TypeError(`artifact ${id} sha256 is invalid`);
  }
  for (const id of REQUIRED_ARTIFACT_IDS) if (!ids.has(id)) throw new TypeError(`missing required artifact: ${id}`);
  const video = asRecord(manifest.video, "video receipt");
  if (!ids.has(video.artifactId) || !ids.has(video.validationArtifactId)) throw new TypeError("video receipt references an unknown artifact");
  if (!(Number.isFinite(video.durationSeconds) && video.durationSeconds > 0)) throw new TypeError("video duration is invalid");
  if (!(Number.isFinite(video.generalLimitSeconds) && video.generalLimitSeconds > 0)) throw new TypeError("video limit is invalid");
  const release = asRecord(manifest.release, "release receipt");
  if (!ids.has(release.artifactId) || release.forbiddenEntryCount !== 0) throw new TypeError("release receipt is not clean");
}

async function inspectArtifact(projectRoot, item) {
  const base = { id: item.id, path: item.path, expectedBytes: item.bytes, expectedSha256: item.sha256 };
  let target;
  try {
    target = safeProjectFile(projectRoot, item.path, `artifact ${item.id} path`);
    const info = await stat(target);
    if (!info.isFile()) return { ...base, status: "fail", reason: "not_regular_file" };
    const [actualSha256, validFormat] = await Promise.all([sha256(target), formatMatches(target, item.format)]);
    const sizeMatches = info.size === item.bytes;
    const hashMatches = actualSha256 === item.sha256;
    return {
      ...base,
      status: sizeMatches && hashMatches && validFormat ? "pass" : "fail",
      actualBytes: info.size,
      actualSha256,
      sizeMatches,
      hashMatches,
      formatMatches: validFormat,
      reason: sizeMatches && hashMatches && validFormat ? null : "integrity_mismatch",
    };
  } catch (error) {
    return { ...base, status: "fail", reason: error?.code === "ENOENT" ? "missing" : "inspection_error" };
  }
}

export async function runSubmissionPreflight({
  projectRoot = DEFAULT_PROJECT_ROOT,
  metadataPath = "docs/submission-metadata.json",
  assetsPath = "docs/submission-assets-local.json",
} = {}) {
  const root = resolve(projectRoot);
  const [metadata, manifest] = await Promise.all([
    readFile(safeProjectFile(root, metadataPath, "metadataPath"), "utf8").then(JSON.parse),
    readFile(safeProjectFile(root, assetsPath, "assetsPath"), "utf8").then(JSON.parse),
  ]);
  asRecord(metadata, "submission metadata");
  if (metadata.schemaVersion !== "suara.submission_metadata/2") throw new TypeError("unsupported submission-metadata schema");
  validateAssetManifest(manifest);

  const artifactChecks = await Promise.all(manifest.artifacts.map((item) => inspectArtifact(root, item)));
  const localArtifactBlockers = artifactChecks.filter((item) => item.status !== "pass").map((item) => `artifact_${item.id}_${item.reason}`);
  if (manifest.video.durationSeconds > manifest.video.generalLimitSeconds) localArtifactBlockers.push("video_exceeds_general_duration_limit");

  const publicationBlockers = [];
  const assets = asRecord(metadata.submissionAssets, "submissionAssets");
  for (const name of REQUIRED_PUBLIC_ASSETS) {
    const item = asRecord(assets[name], `submissionAssets.${name}`);
    if (!isVerifiedHttps(item.url)) publicationBlockers.push(`${name}_verified_https_url_missing`);
  }
  if (!Array.isArray(metadata.project?.teamMembers) || metadata.project.teamMembers.length === 0 || metadata.project.teamStatus !== "confirmed") {
    publicationBlockers.push("team_confirmation_pending");
  }
  if (!Array.isArray(metadata.project?.categoryTags) || metadata.project.categoryTags.length === 0 || metadata.project.tagsStatus !== "selected") {
    publicationBlockers.push("category_tags_pending");
  }

  const evidenceBlockers = [];
  const verification = asRecord(metadata.verification, "verification");
  for (const field of REQUIRED_EVIDENCE) if (verification[field] !== true) evidenceBlockers.push(`${field}_pending`);

  const warnings = [];
  if (metadata.event?.exactSubmissionDeadline === null || metadata.event?.deadlineTimezone === null) warnings.push("exact_submission_cutoff_unconfirmed");
  if (verification.patientBenefitValidated !== true) warnings.push("patient_benefit_unvalidated_keep_claim_absent");
  if (verification.customizedGeneratedMemoirImplemented !== true) warnings.push("customized_generated_memoir_remains_future_work");
  if (verification.productionReady !== true) warnings.push("production_readiness_unproven");

  const localPackageReady = localArtifactBlockers.length === 0;
  const platformFieldsReady = publicationBlockers.length === 0;
  const evidenceReady = evidenceBlockers.length === 0;
  const readyForSubmission = localPackageReady && platformFieldsReady && evidenceReady && metadata.submissionMade === false;
  return {
    schemaVersion: "suara.submission_preflight/1",
    status: readyForSubmission ? "ready_for_owner_submission_review" : "blocked_pending_external_gates",
    readyForSubmission,
    localPackage: { ready: localPackageReady, blockers: localArtifactBlockers, artifactChecks },
    platformFields: { ready: platformFieldsReady, blockers: publicationBlockers },
    evidence: { ready: evidenceReady, blockers: evidenceBlockers },
    warnings,
    postSubmissionReceiptPending: metadata.submissionMade !== true || !isVerifiedHttps(assets.submissionEntry?.url),
    evidenceBoundary: "Preflight validates declared local bytes and explicit metadata gates. It does not prove URL reachability, provider behavior, human hearing, benchmark validity, stakeholder approval or organizer acceptance.",
  };
}

export const submissionPreflightContract = Object.freeze({
  requiredArtifactIds: REQUIRED_ARTIFACT_IDS,
  requiredPublicAssets: REQUIRED_PUBLIC_ASSETS,
  requiredEvidence: REQUIRED_EVIDENCE,
});
