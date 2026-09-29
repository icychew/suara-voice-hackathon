import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const metadata = JSON.parse(await readFile(new URL("../docs/submission-metadata.json", import.meta.url), "utf8"));
const charCount = (text) => Array.from(text).length;
const wordCount = (text) => text.trim().split(/\s+/u).length;

function exactKeys(value, keys) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

function nonemptyString(value) {
  assert.equal(typeof value, "string");
  assert.ok(value.trim().length > 0);
}

function validateDraft(value) {
  exactKeys(value, ["schemaVersion", "status", "submissionMade", "event", "project", "plannedStack", "submissionAssets", "verification", "guidance"]);
  assert.equal(value.schemaVersion, "suara.submission_metadata/2");
  assert.equal(value.status, "draft_pending_external_gates");
  assert.equal(value.submissionMade, false);
  exactKeys(value.event, ["name", "officialUrl", "buildWindowStart", "buildWindowEnd", "exactSubmissionDeadline", "deadlineTimezone", "deadlineStatus"]);
  for (const field of ["name", "officialUrl", "buildWindowStart", "buildWindowEnd"]) nonemptyString(value.event[field]);
  assert.equal(value.event.exactSubmissionDeadline, "2026-09-30T15:00:00Z");
  assert.equal(value.event.deadlineTimezone, "UTC (2026-09-30 23:00 Asia/Kuala_Lumpur)");
  assert.equal(value.event.deadlineStatus, "confirmed_from_official_event_schedule_2026-09-27");
  exactKeys(value.project, ["title", "summary", "longDescription", "teamMembers", "teamStatus", "categoryTags", "tagsStatus"]);
  for (const field of ["title", "summary", "longDescription"]) nonemptyString(value.project[field]);
  assert.ok(charCount(value.project.title) >= 5 && charCount(value.project.title) <= 50);
  assert.ok(charCount(value.project.summary) >= 50 && charCount(value.project.summary) <= 255);
  assert.ok(wordCount(value.project.longDescription) >= 100);
  assert.ok(charCount(value.project.longDescription) >= 600 && charCount(value.project.longDescription) <= 2000);
  assert.equal(value.project.teamMembers, null);
  assert.equal(value.project.teamStatus, "pending_confirmation");
  assert.equal(value.project.categoryTags, null);
  assert.equal(value.project.tagsStatus, "pending_platform_selection");
  assert.ok(Array.isArray(value.plannedStack) && value.plannedStack.length > 0);
  for (const item of value.plannedStack) {
    exactKeys(item, ["name", "role"]);
    nonemptyString(item.name);
    nonemptyString(item.role);
  }
  const assets = ["application", "repository", "video", "slides", "cover", "submissionEntry"];
  exactKeys(value.submissionAssets, assets);
  for (const [name, asset] of Object.entries(value.submissionAssets)) {
    exactKeys(asset, ["url", "status"]);
    if (name === "application") {
      assert.equal(asset.url, "https://suara-voice.vercel.app");
      assert.equal(asset.status, "verified_static_and_health_voice_e2e_pending");
    } else {
      assert.equal(asset.url, null);
      assert.match(asset.status, /^pending_[a-z_]+$/u);
    }
  }
  exactKeys(value.verification, ["liveProviderVerified", "onlineDemoVerified", "realMicrophoneHeardReplyVerified", "matchedThreeArmBenchmarkVerified", "independentBlindScoringVerified", "signedOutSecondDeviceVerified", "finalVideoVerified", "patientBenefitValidated", "customizedGeneratedMemoirImplemented", "productionReady"]);
  for (const verified of Object.values(value.verification)) assert.equal(verified, false);
  exactKeys(value.guidance, ["requirementsBasis", "titleMinCharacters", "titleMaxCharacters", "summaryMinCharacters", "summaryMaxCharacters", "longDescriptionMinWords", "longDescriptionMinCharacters", "longDescriptionMaxCharacters", "generalVideoMaxSeconds", "internalVideoTargetSeconds", "eventSpecificVideoLimit", "sourcesCheckedOn", "formUrl", "formCheckedOn", "formStepsVerified", "sources"]);
  assert.equal(value.guidance.requirementsBasis, "event_form_step_one_and_general_guidance");
  assert.equal(value.guidance.titleMinCharacters, 5);
  assert.equal(value.guidance.titleMaxCharacters, 50);
  assert.equal(value.guidance.summaryMinCharacters, 50);
  assert.equal(value.guidance.summaryMaxCharacters, 255);
  assert.equal(value.guidance.longDescriptionMinWords, 100);
  assert.equal(value.guidance.longDescriptionMinCharacters, 600);
  assert.equal(value.guidance.longDescriptionMaxCharacters, 2000);
  assert.equal(value.guidance.formUrl, "https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon/project-suara/submission");
  assert.equal(value.guidance.formCheckedOn, "2026-09-06");
  assert.deepEqual(value.guidance.formStepsVerified, [1]);
  assert.equal(value.guidance.generalVideoMaxSeconds, 300);
  assert.equal(value.guidance.internalVideoTargetSeconds, 180);
  assert.equal(value.guidance.eventSpecificVideoLimit, null);
  assert.match(value.guidance.sourcesCheckedOn, /^\d{4}-\d{2}-\d{2}$/u);
  assert.ok(Array.isArray(value.guidance.sources) && value.guidance.sources.length >= 3);
  for (const source of value.guidance.sources) {
    const url = new URL(source);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "lablab.ai");
  }
}

test("submission metadata satisfies the draft schema and platform text limits", () => {
  validateDraft(metadata);
});

test("submission copy preserves the implemented product and unverified claims boundary", () => {
  const text = metadata.project.longDescription;
  assert.match(text, /reviewed fictional quotes/u);
  assert.match(text, /AI-authored memoir.*remain unproven/u);
  assert.match(text, /\d+ automated tests passed/u);
  assert.match(text, /No physical microphone or human-heard response was verified/u);
  assert.match(text, /older-adult benefit and production readiness remain unproven/u);
  assert.match(text, /Malay live speech and code-switching accuracy are not claimed/u);
  assert.match(text, /browser reset does not delete those recordings/u);
  assert.match(text, /default-off.*at most two final-answer excerpts/u);
  assert.match(text, /AssemblyAI LLM Gateway and its model provider/u);
  assert.match(text, /15 credential-free hosted checks passed/u);
  assert.match(text, /no model weights were trained/u);
  const stack = new Map(metadata.plannedStack.map((item) => [item.name, item.role]));
  assert.match(stack.get("Vercel"), /Current public host/u);
  assert.match(stack.get("Upstash Redis"), /protected live voice state was not exercised/u);
  assert.match(stack.get("Oracle Cloud"), /Deferred migration option/u);
});

test("draft contract rejects fabricated completion, identities, URLs and deadlines", () => {
  const mutations = [
    (value) => { value.submissionMade = true; },
    (value) => { value.status = "submitted"; },
    (value) => { value.project.teamMembers = ["Unconfirmed member"]; },
    (value) => { value.event.exactSubmissionDeadline = null; },
    (value) => { value.event.deadlineTimezone = "UTC"; },
    (value) => { value.guidance.eventSpecificVideoLimit = 180; },
    (value) => { value.guidance.formStepsVerified = [1, 2, 3]; },
    (value) => { value.verification.onlineDemoVerified = true; },
    (value) => { value.submissionAssets.application.url = null; },
    (value) => { value.submissionAssets.video.status = "published"; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(metadata);
    mutate(invalid);
    assert.throws(() => validateDraft(invalid));
  }
});

test("draft contract rejects text overflow, missing fields and unknown schema fields", () => {
  const mutations = [
    (value) => { value.project.title = "a".repeat(4); },
    (value) => { value.project.title = "a".repeat(51); },
    (value) => { value.project.summary = "a".repeat(49); },
    (value) => { value.project.summary = "a".repeat(256); },
    (value) => { value.project.longDescription = "insufficient detail"; },
    (value) => { value.project.longDescription = "word ".repeat(100).trim(); },
    (value) => { value.project.longDescription = "word ".repeat(500).trim(); },
    (value) => { value.guidance.longDescriptionMaxCharacters = 3000; },
    (value) => { delete value.submissionAssets.slides; },
    (value) => { value.submissionReceipt = "not a real receipt"; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(metadata);
    mutate(invalid);
    assert.throws(() => validateDraft(invalid));
  }
});
