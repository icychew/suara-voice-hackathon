import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { COPY, LOCALES, SESSION_PROMPT, SESSION_QUESTIONS } from "../src/voice/copy.js";
import { appendSpokenToken, createEvidenceIdLedger, upsertTurn } from "../src/voice/transcript.js";

const app = await readFile(new URL("../src/voice/VoiceDemoApp.jsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/voice/voiceClient.js", import.meta.url), "utf8");
const copy = await readFile(new URL("../src/voice/copy.js", import.meta.url), "utf8");
const processor = await readFile(new URL("../src/voice/pcm-processor.js", import.meta.url), "utf8");

test("microphone start is gated by explicit, revocable consent", () => {
  assert.match(app, /if \(!consent \|\| status !== "idle" \|\| capabilityCheckState === "checking"\) return;/);
  assert.match(app, /disabled=\{!consent \|\| !accessCode\.trim\(\) \|\| optionalModeBlocked/);
  assert.match(app, /checked=\{consent\}/);
  assert.match(app, /aria-describedby="voice-consent-detail"/);
  assert.match(app, /<p id="voice-consent-detail">\{c\.consentDetail\}<\/p>/);
  assert.match(app, /disabled=\{controlsLocked\}/);
  assert.match(app, /setConsent\(false\)/);
  assert.match(COPY.en.consent, /choose to turn on my microphone/i);
  assert.match(COPY.ms.consent, /memilih untuk menghidupkan mikrofon/i);
  assert.match(COPY.zh.consent, /选择.*开启麦克风/);
  for (const locale of ["en", "ms", "zh"]) {
    assert.equal(typeof COPY[locale].resolvedModes.baseline, "string");
    assert.equal(typeof COPY[locale].resolvedModes.patient, "string");
    assert.equal(typeof COPY[locale].errorMessages.configuration, "string");
  }
  assert.match(app, /c\.resolvedModes\[resolvedMode\]/);
});

test("audio capture batches 50 ms frames and applies WebSocket backpressure", () => {
  assert.match(processor, /this\.frameSamples = processorOptions\.frameSamples \|\| 1_200/);
  assert.match(processor, /this\.pendingLength === this\.frameSamples/);
  assert.match(client, /MAX_SOCKET_AUDIO_BACKLOG_BYTES = 256_000/);
  assert.match(client, /this\.socket\.bufferedAmount > MAX_SOCKET_AUDIO_BACKLOG_BYTES/);
});

test("all access hints distinguish the host's Suara password from API keys and retain recovery guidance", () => {
  const expected = {
    en: [/private Suara demo password from your host/u, /not an AssemblyAI API key/u,
      /Never paste an API key here/u, /this tab until you clear or leave this page/u,
      /No code\? Try the no-microphone demo below/u],
    ms: [/kata laluan demo peribadi Suara daripada hos/u, /bukan kunci API AssemblyAI/u,
      /Jangan tampal kunci API di sini/u, /tab ini sehingga anda mengosongkan atau meninggalkan halaman/u,
      /Tiada kod\? Cuba demo tanpa mikrofon di bawah/u],
    zh: [/主持人提供的 Suara 私人演示密码/u, /不是 AssemblyAI API 密钥/u,
      /切勿在此粘贴 API 密钥/u, /当前标签页，清除或离开页面后即移除/u,
      /没有访问码？可体验下方的免麦克风演示/u],
  };
  for (const { id } of LOCALES) {
    assert.match(COPY[id].accessHint, /16–128/u, `${id}: retain password length guidance`);
    for (const pattern of expected[id]) assert.match(COPY[id].accessHint, pattern, `${id}: access hint`);
  }
});

test("the interview scope is exactly three questions with English replies", () => {
  assert.deepEqual(LOCALES.map(({ id }) => id), ["ms", "en", "zh"]);
  assert.equal(SESSION_QUESTIONS.length, 3);
  assert.match(SESSION_PROMPT, /exactly three stages/i);
  assert.match(SESSION_PROMPT, /Ask these questions in order/i);
  assert.match(SESSION_PROMPT, /Always speak back in clear, warm English/i);
  assert.doesNotMatch(SESSION_PROMPT, /mixture|mix of both/i);

  for (const locale of ["en", "ms", "zh"]) {
    assert.equal(COPY[locale].questions.length, 3);
    assert.match(COPY[locale].footer, /English|Inggeris|英语/);
    assert.match(COPY[locale].pilotNote, /Mandarin|普通话/);
    assert.doesNotMatch(COPY[locale].pilotNote, /mix of both|campuran kedua-duanya|混合/u);
    assert.ok(COPY[locale].recordingHold);
  }
  assert.match(app, /className="recording-hold" role="note">\{c\.recordingHold\}<\/p>/);
  assert.match(COPY.en.recordingHold, /Human recording is currently on hold/i);
  assert.match(COPY.ms.recordingHold, /Rakaman manusia kini ditangguhkan/u);
  assert.match(COPY.zh.recordingHold, /真人录音目前暂停/u);
});

test("the local memoir preview requires current human review and links each selected excerpt to evidence", () => {
  assert.match(app, /turns\.filter\(\(turn\) => turn\.role === "user" && turn\.text\.trim\(\)\)/);
  assert.match(app, /\? evidenceLedgerRef\.current\.ensure\(key\) : undefined/);
  assert.match(app, /id=\{sourceId \? `evidence-\$\{sourceId\}` : undefined\}/);
  assert.match(app, /href=\{`#evidence-\$\{turn\.sourceId\}`\}/);
  assert.match(app, /const canReview = \(status === "ended" \|\| status === "error"\) && userTurns\.length > 0/);
  assert.match(app, /!canReview \?/);
  assert.match(app, /selectReviewedTurns\(reviewTurns, reviewByKey\)/);
  assert.match(app, /setReviewByKey\(\(current\) => reconcileReviewMap\(current, key, event\.text\)\)/);
  assert.match(app, /review\.status === decision/);
  assert.match(app, /maxLength=\{MAX_CORRECTION_CHARS\}/);
  assert.match(app, /buildReviewedMemoryMarkdown/);
  assert.match(app, /link\.download = "suara-reviewed-memory\.md"/);
  assert.match(app, /<p>“\{turn\.text\}”<\/p>/);
  assert.match(COPY.en.previewIntro, /unreviewed local arrangement/i);
  assert.match(COPY.en.candidate, /human review required/i);
  assert.match(COPY.en.correctionNote, /resets the excerpt to Waiting/i);
  assert.match(COPY.en.downloadBoundary, /not AI-authored or fact-checked/i);
  assert.match(COPY.en.previewEmptyEnded, /without a final narrator transcript/i);
});

test("reset, tab close, and the no-microphone fallback are explicit", () => {
  for (const reset of [
    /client\?\.dispose\(\)/,
    /setConsent\(false\)/,
    /setTurns\(\[\]\)/,
    /setReviewByKey\(\{\}\)/,
    /setUserPartial\(null\)/,
    /setAgentPartial\(null\)/,
    /setEndsAt\(null\)/,
    /setRemainingMs\(SESSION_LIMIT_MS\)/,
  ]) {
    assert.match(app, reset);
  }
  assert.match(app, /window\.addEventListener\("pagehide", endOnPageHide\)/);
  assert.match(app, /window\.addEventListener\("beforeunload", warnBeforeUnload\)/);
  assert.match(app, /href=\{withInterfaceLocale\("\/prototype\/", locale\)\}/);
  assert.match(COPY.en.fallback, /no-microphone demo/i);
});

test("late final corrections preserve chronology and exact evidence text", () => {
  const first = upsertTurn([], { key: "u1", role: "user", text: "  Nasi lemak with grandma.  " });
  const second = upsertTurn(first, { key: "a1", role: "agent", text: "What do you remember?" });
  const corrected = upsertTurn(second, { key: "u1", role: "user", text: "外婆的椰浆饭。" });
  assert.deepEqual(corrected.map(({ key }) => key), ["u1", "a1"]);
  assert.equal(corrected[0].text, "外婆的椰浆饭。");
  assert.equal(first[0].text, "Nasi lemak with grandma.");
  assert.deepEqual(upsertTurn(corrected, { key: "u1", text: " " }), [second[1]]);
});

test("evidence identifiers are monotonic and are not recycled after a withdrawal", () => {
  const ledger = createEvidenceIdLedger();
  assert.equal(ledger.ensure("user-first"), "U01");
  assert.equal(ledger.ensure("user-second"), "U02");
  assert.equal(ledger.ensure("user-first"), "U01");
  assert.equal(ledger.ensure("user-third"), "U03");
  ledger.clear();
  assert.equal(ledger.ensure("new-session"), "U01");
  assert.throws(() => ledger.ensure(""), /Invalid evidence key/);
});

test("provisional token display handles spaces and Chinese punctuation", () => {
  assert.equal(appendSpokenToken("Hello", " there"), "Hello there");
  assert.equal(appendSpokenToken("Hello ", "there"), "Hello there");
  assert.equal(appendSpokenToken("Hello", ","), "Hello,");
  assert.equal(appendSpokenToken("Hello", "there"), "Hello there");
  assert.equal(appendSpokenToken("家", "人"), "家人");
  assert.equal(appendSpokenToken("家人", "。"), "家人。");
  assert.equal(appendSpokenToken("（", "往事"), "（往事");
});

test("all interface locales have matching keys and actionable recovery copy", () => {
  function paths(value, prefix = "") {
    return Object.entries(value).flatMap(([key, item]) => {
      const path = `${prefix}.${key}`;
      return item && typeof item === "object" && !Array.isArray(item) ? paths(item, path) : [path];
    }).sort();
  }
  for (const locale of ["ms", "zh"]) assert.deepEqual(paths(COPY[locale]), paths(COPY.en));
  for (const locale of ["en", "ms", "zh"]) {
    assert.ok(COPY[locale].accessLabel);
    assert.ok(COPY[locale].errorMessages.access);
    assert.ok(COPY[locale].errorMessages.capacity);
    assert.match(COPY[locale].transcriptUpdated, /\{count\}/);
    assert.equal(Object.keys(COPY[locale].endReasons).sort().join(","), "complete,limit,provider,user");
  }
  assert.match(app, /if \(clientRef\.current !== client\) return/);
  assert.match(app, /if \(clientRef\.current === client\) handleVoiceEvent/);
  assert.match(app, /if \(confirmReset\) keepReviewRef\.current\?\.focus/);
});

test("Suara keeps no browser persistence path and discloses provider-side recording", () => {
  const sources = `${app}\n${client}\n${copy}`;
  for (const forbidden of [
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bindexedDB\b/,
    /\bdocument\.cookie\b/,
    /\bsendBeacon\b/,
  ]) {
    assert.doesNotMatch(sources, forbidden);
  }

  assert.match(client, /const SESSION_ENDPOINT = "\/api\/session"/);
  assert.match(client, /const TOKEN_ENDPOINT = "\/api\/voice\/token"/);
  assert.match(client, /const VOICE_ENDPOINT = "wss:\/\/agents\.assemblyai\.com\/v1\/ws"/);
  assert.doesNotMatch(app, /\bfetch\s*\(/);
  assert.match(COPY.en.consentDetail, /copy shown on this page clears/i);
  assert.match(COPY.en.consentDetail, /records managed Voice Agent sessions/i);
  assert.match(COPY.en.consentDetail, /Streaming handling depends/i);
  assert.match(COPY.en.privacyItems[2][1], /does not delete data retained by AssemblyAI/i);
  assert.doesNotMatch(copy, /No Suara-server storage|Tiada simpanan pelayan Suara|Suara 服务器不储存内容/u);
  assert.match(COPY.en.privacyItems[1][1], /access service keeps request times and short-lived security identifiers.*no audio or transcripts/i);
  assert.match(COPY.ms.privacyItems[1][1], /menyimpan masa permintaan dan pengecam keselamatan sementara.*bukan audio atau transkrip/u);
  assert.match(COPY.zh.privacyItems[1][1], /访问服务保存请求时间和短期安全标识.*不会保存音频或转录/u);
});
