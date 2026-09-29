import assert from "node:assert/strict";
import test from "node:test";
import { fetchVoiceCapabilities, validateVoiceCapabilities } from "../src/voice/capabilities.js";
import { CAPABILITY_COPY } from "../src/voice/streamingCopy.js";

const CODE = "synthetic-capability-code";
const payload = (streaming = true, aiQuestions = false) => ({ schemaVersion: "suara.voice_capabilities/1", streaming, aiQuestions });

test("capability reads authenticate a fixed same-origin URL with no token/audio request", async () => {
  const calls = [];
  const result = await fetchVoiceCapabilities({ accessCode: CODE, fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.method, "GET");
    assert.equal(options.headers["X-Suara-Access-Code"], CODE);
    assert.equal(options.cache, "no-store"); assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "same-origin"); assert.equal(options.body, undefined);
    return Response.json(payload());
  } });
  assert.deepEqual(calls, ["/api/capabilities"]);
  assert.deepEqual(result, { streaming: true, aiQuestions: false });
  assert.ok(Object.isFrozen(result));
});

test("optional capabilities accept only explicit booleans in the exact versioned contract", () => {
  for (const flags of [[false, false], [true, false], [true, true]]) {
    assert.deepEqual(validateVoiceCapabilities(payload(...flags)), { streaming: flags[0], aiQuestions: flags[1] });
  }
  for (const value of [null, [], {}, payload(false, true), { ...payload(), streaming: "true" },
    { ...payload(), aiQuestions: 1 }, { ...payload(), schemaVersion: "other" }, { ...payload(), secret: "PRIVATE" }]) {
    assert.throws(() => validateVoiceCapabilities(value), { kind: "capabilities" });
  }
});

test("unavailable, malformed, oversized and redirected capability responses fail closed", async () => {
  for (const response of [Response.json({ error: "PRIVATE" }, { status: 503 }),
    new Response("not-json", { headers: { "content-type": "application/json" } }),
    Response.json({ ...payload(), streaming: "true" }), new Response("{}", { headers: { "content-type": "text/html" } }),
    new Response("x".repeat(1025), { headers: { "content-type": "application/json" } })]) {
    await assert.rejects(fetchVoiceCapabilities({ accessCode: CODE, fetchImpl: async () => response }), { kind: "capabilities" });
  }
  for (const [status, kind] of [[401, "access"], [429, "capacity"]]) {
    await assert.rejects(fetchVoiceCapabilities({ accessCode: CODE,
      fetchImpl: async () => Response.json({ error: "PRIVATE" }, { status }) }), { kind });
  }
});

test("cancelled capability checks settle without waiting for a stalled transport", async () => {
  const controller = new AbortController();
  const pending = fetchVoiceCapabilities({ accessCode: CODE, signal: controller.signal,
    fetchImpl: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(pending, { kind: "cancelled" });
});

test("all interface locales provide optional-mode availability and recovery copy", () => {
  for (const locale of ["en", "ms", "zh"]) {
    assert.deepEqual(Object.keys(CAPABILITY_COPY[locale]), Object.keys(CAPABILITY_COPY.en));
    assert.deepEqual(Object.keys(CAPABILITY_COPY[locale].errors), Object.keys(CAPABILITY_COPY.en.errors));
    for (const value of Object.values(CAPABILITY_COPY[locale].errors)) assert.ok(value.length > 10);
  }
});
