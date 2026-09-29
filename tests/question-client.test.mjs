import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { validateQuestionGrant, selectionExcerpt, requestBankQuestion } from "../src/voice/questionClient.js";
import { QUESTION_BANK } from "../src/voice/questionBank.js";

const CAPABILITY = "A".repeat(43);
const GRANT = Object.freeze({ policy: "bank-v1", capability: CAPABILITY, nextSequence: 0, expires_in_seconds: 600, max_selections: 8 });
const INPUT = Object.freeze({ capability: CAPABILITY, sequence: 0, transcript: "I grew up in Penang.", askedIds: ["birthplace"] });
const answer = (questionId = "childhood_home", nextSequence = 1) => ({ questionId, nextSequence });
const response = (value = answer(), options = {}) => new Response(typeof value === "string" ? value : JSON.stringify(value),
  { status: 200, headers: { "Content-Type": "application/json" }, ...options });
const generic = (error) => {
  assert.equal(error.message, "question_unavailable"); assert.equal(error.cause, undefined); return true;
};
async function turn() { await new Promise(setImmediate); }

test("grant validates exact scalar policy/shape and returns only session-local capability/sequence", () => {
  const result = validateQuestionGrant(GRANT);
  assert.deepEqual(result, { capability: CAPABILITY, sequence: 0 });
  result.sequence = 1; assert.equal(GRANT.nextSequence, 0);
  for (const invalid of [null, [], {}, { ...GRANT, extra: "PRIVATE" },
    { ...GRANT, policy: "other" }, { ...GRANT, nextSequence: "0" }, { ...GRANT, nextSequence: 1 },
    { ...GRANT, expires_in_seconds: "600" }, { ...GRANT, expires_in_seconds: 601 },
    { ...GRANT, max_selections: "8" }, { ...GRANT, max_selections: 9 },
    { ...GRANT, capability: { toString: () => CAPABILITY } }, { ...GRANT, capability: [CAPABILITY] },
    { ...GRANT, capability: "A".repeat(42) }, { ...GRANT, capability: "!".repeat(43) },
    { ...GRANT, get capability() { throw new Error("PRIVATE getter"); } },
  ]) assert.throws(() => validateQuestionGrant(invalid), generic);
});

test("excerpt includes only the last two final strings and at most 4000 UTF-16 units", () => {
  assert.equal(selectionExcerpt(["PRIVATE_OLD_ANSWER", "Second final.", "Third final."]), "Second final.\nThird final.");
  const result = selectionExcerpt(["older".repeat(3000), "x".repeat(3000)]);
  assert.equal(result.length, 4000);
  assert.equal(result.endsWith("x".repeat(3000)), true);
});

test("excerpt never splits a surrogate pair at the retention boundary", () => {
  const result = selectionExcerpt(["older", "😀" + "x".repeat(3999)]);
  assert.equal(result, "x".repeat(3999));
  assert.equal(result.isWellFormed(), true);
  assert.equal(selectionExcerpt(["😀".repeat(3000)]), "😀".repeat(2000));
});

test("excerpt rejects malformed final containers and does not coerce objects or partial structures", () => {
  for (const input of [null, {}, "answer", [], [""], [" \n"], [1], [null],
    [{ text: "PRIVATE", toString: () => "PRIVATE" }], new Array(1), ["bad\ud800"], ["\udc00bad"], ["a".repeat(32001)],
  ]) assert.throws(() => selectionExcerpt(input), generic);
});

test("question request fixes endpoint, header policy, body fields and never forwards asked IDs or capability in content", async () => {
  let call;
  const result = await requestBankQuestion({ ...INPUT, fetchImpl: async (url, init) => { call = { url, init }; return response(); } });
  assert.deepEqual(result, answer()); assert.equal(Object.isFrozen(result), true);
  assert.equal(call.url, "/api/interview/question");
  assert.equal(call.init.method, "POST"); assert.equal(call.init.cache, "no-store");
  assert.equal(call.init.credentials, "same-origin"); assert.equal(call.init.redirect, "error");
  assert.deepEqual(call.init.headers, { Accept: "application/json", "Content-Type": "application/json",
    Authorization: `Bearer ${CAPABILITY}`, "X-Suara-Question-Policy": "bank-v1" });
  assert.deepEqual(JSON.parse(call.init.body), { version: "bank-v1", sequence: 0, transcript: INPUT.transcript });
  assert.equal(call.init.body.includes(CAPABILITY), false);
  assert.equal(Object.hasOwn(JSON.parse(call.init.body), "askedIds"), false);
});

test("invalid scalar inputs, history, capabilities and deadlines fail before fetch", async () => {
  let calls = 0;
  for (const fields of [
    { capability: { toString: () => CAPABILITY } }, { capability: [CAPABILITY] }, { capability: "" },
    { sequence: true }, { sequence: "0" }, { sequence: -1 }, { sequence: 8 }, { sequence: 0.5 },
    { transcript: "" }, { transcript: " " }, { transcript: true }, { transcript: "a".repeat(4001) }, { transcript: "bad\ud800" },
    { askedIds: null }, { askedIds: ["unknown"] }, { askedIds: ["birthplace", "birthplace"] },
    { askedIds: ["parents", "birthplace"] }, { askedIds: QUESTION_BANK.slice(0, 8).map((q) => q.id) },
    { askedIds: ["anything_else"] }, { askedIds: new Array(1) },
    { timeoutMs: 0 }, { timeoutMs: 5001 }, { timeoutMs: Infinity }, { timeoutMs: "5000" },
  ]) await assert.rejects(requestBankQuestion({ ...INPUT, ...fields, fetchImpl: async () => { calls += 1; return response(); } }), generic);
  for (const input of [null, [], "PRIVATE", { get transcript() { throw new Error("PRIVATE"); } }]) {
    await assert.rejects(requestBankQuestion(input), generic);
  }
  assert.equal(calls, 0);
});

test("serialized JSON bytes are capped before fetch, including escaped control characters", async () => {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1; assert.ok(new TextEncoder().encode(init.body).byteLength <= 16384); return response();
  };
  await requestBankQuestion({ ...INPUT, transcript: "中".repeat(4000), fetchImpl });
  await assert.rejects(requestBankQuestion({ ...INPUT, transcript: "\u0000".repeat(4000), fetchImpl }), generic);
  assert.equal(calls, 1);
});

test("response is one eligible ID and exact next sequence, never generated text or duplicate keys", async () => {
  for (const payload of [null, [], {}, answer("birthplace"), answer("unknown"), answer("__proto__"),
    answer("childhood_home", 0), answer("childhood_home", "1"), answer("childhood_home", 2),
    { ...answer(), text: "PRIVATE GENERATED QUESTION" }, { ...answer(), capability: CAPABILITY },
    '{"questionId":"childhood_home","nextSequence":1,"nextSequence":1}',
    '{"questionId":"birthplace","questionId":"childhood_home","nextSequence":1}',
    '{"questionId":"childhood_home","nextSequence":1,"next\\u0053equence":1}',
    '```json\n{"questionId":"childhood_home","nextSequence":1}\n```',
  ]) await assert.rejects(requestBankQuestion({ ...INPUT, fetchImpl: async () => response(payload) }), generic);
});

test("valid escaped JSON keys and eligible winding-down choice remain supported", async () => {
  const payload = '{"question\\u0049d":"anything_else","nextSequence":1}';
  assert.deepEqual(await requestBankQuestion({ ...INPUT, fetchImpl: async () => response(payload) }), answer("anything_else"));
});

test("provider/server failure details never escape and never trigger a retry", async () => {
  for (const status of [400, 401, 409, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(requestBankQuestion({ ...INPUT, fetchImpl: async () => {
      calls += 1; return response({ error: "PRIVATE SERVER DETAILS" }, { status });
    } }), generic);
    assert.equal(calls, 1);
  }
  await assert.rejects(requestBankQuestion({ ...INPUT, fetchImpl: async () => { throw new Error("PRIVATE FETCH DETAILS"); } }), generic);
});

test("redirects, missing body readers, non-JSON responses and oversized declarations fail before reading", async () => {
  for (const fields of [{ redirected: true }, { status: 201 }, { body: {} },
    { headers: new Headers({ "content-type": "text/html" }) }, { headers: new Headers() },
    { headers: new Headers({ "content-type": "application/json", "content-length": "1025" }) },
    { headers: new Headers({ "content-type": "application/json", "content-length": "1e2" }) },
  ]) {
    let read = false;
    await assert.rejects(requestBankQuestion({ ...INPUT, fetchImpl: async () => ({ ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }), body: { getReader() { read = true; }, cancel() {} }, ...fields }) }), generic);
    assert.equal(read, false);
  }
});

test("1024-byte response bound applies to actual streamed bytes", async () => {
  const raw = JSON.stringify(answer());
  const exact = raw + " ".repeat(1024 - new TextEncoder().encode(raw).length);
  assert.deepEqual(await requestBankQuestion({ ...INPUT, fetchImpl: async () => response(exact) }), answer());
  await assert.rejects(requestBankQuestion({ ...INPUT, fetchImpl: async () => response(exact + " ") }), generic);
});

test("reader chunks are validated, copied, cancelled and released on failures", async () => {
  for (const value of [new Uint8Array(1025), new Uint8Array(), "PRIVATE", null]) {
    let cancelled = 0; let released = 0;
    const reader = { read: async () => ({ done: false, value }), cancel() { cancelled += 1; }, releaseLock() { released += 1; } };
    await assert.rejects(requestBankQuestion({ ...INPUT, fetchImpl: async () => ({ ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }), body: { getReader: () => reader } }) }), generic);
    assert.equal(cancelled, 1); assert.equal(released, 1);
  }
});

test("empty, truncated, malformed UTF-8 and malformed JSON are rejected", async () => {
  for (const value of [new Uint8Array(), new Uint8Array([0xc3, 0x28]), "{bad json}"])
    await assert.rejects(requestBankQuestion({ ...INPUT, fetchImpl: async () => new Response(value,
      { headers: { "content-type": "application/json" } }) }), generic);
  await assert.rejects(requestBankQuestion({ ...INPUT, fetchImpl: async () => response(answer(),
    { headers: { "content-type": "application/json", "content-length": "999" } }) }), generic);
});

test("pre-aborted or invalid signal performs no request", async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort("PRIVATE");
  for (const signal of [controller.signal, null, {}, { aborted: false }])
    await assert.rejects(requestBankQuestion({ ...INPUT, signal, fetchImpl: async () => { calls += 1; return response(); } }), generic);
  assert.equal(calls, 0);
});

test("caller abort settles ignored fetch and cancels its eventual late body without reading", async () => {
  const controller = new AbortController();
  let resolveFetch; let upstreamSignal; let cancelled = 0;
  const pending = requestBankQuestion({ ...INPUT, signal: controller.signal, fetchImpl: (_url, init) => {
    upstreamSignal = init.signal; return new Promise((resolve) => { resolveFetch = resolve; });
  } });
  const rejected = assert.rejects(pending, generic);
  controller.abort("PRIVATE"); await rejected;
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  resolveFetch({ body: { cancel() { cancelled += 1; }, getReader() { assert.fail("Late body must not be read"); } } });
  await turn(); assert.equal(cancelled, 1);
});

test("fixed maximum deadline rejects a fetch that ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fetchSignal; let settled = false;
  const rejected = assert.rejects(requestBankQuestion({ ...INPUT, fetchImpl: (_url, init) => {
    fetchSignal = init.signal; return new Promise(() => {});
  } }), generic).then(() => { settled = true; });
  t.mock.timers.tick(4999); await turn(); assert.equal(settled, false);
  t.mock.timers.tick(1); await rejected; assert.equal(fetchSignal.aborted, true);
});

test("a single total deadline covers both fetch and an ignored reader/cancel", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolveFetch; let reading = false; let cancelled = false; let settled = false;
  const reader = { read() { reading = true; return new Promise(() => {}); },
    cancel() { cancelled = true; return new Promise(() => {}); }, releaseLock() {} };
  const rejected = assert.rejects(requestBankQuestion({ ...INPUT,
    fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) }), generic).then(() => { settled = true; });
  t.mock.timers.tick(2000);
  resolveFetch({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), body: { getReader: () => reader } });
  await turn(); assert.equal(reading, true);
  t.mock.timers.tick(2999); await turn(); assert.equal(settled, false);
  t.mock.timers.tick(1); await rejected; assert.equal(cancelled, true);
});

test("success removes caller listeners and leaves cleared timers inert", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let calls = 0;
  await requestBankQuestion({ ...INPUT, signal: controller.signal, fetchImpl: async () => { calls += 1; return response(); } });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  t.mock.timers.tick(5000); controller.abort(); await turn(); assert.equal(calls, 1);
});
