import assert from "node:assert/strict";
import test from "node:test";
import { HostedAcceptanceError, runHostedAcceptance, validateHostedOrigin } from "../scripts/hosted-acceptance.mjs";

const ORIGIN = "https://suara.example.test";
const PAGE = (title, asset) => `<!doctype html><html><head><title>${title}</title><script type="module" src="${asset}"></script></head><body><div id="root"></div></body></html>`;
const HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(self)",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function fixture({ mutate } = {}) {
  const calls = [];
  const routes = new Map([
    ["GET /", [200, PAGE("Suara — memories, with evidence", "/assets/main.js"), { "content-type": "text/html; charset=utf-8" }]],
    ["GET /voice/", [200, PAGE("Suara — guided voice memory pilot", "/assets/voice.js"), { "content-type": "text/html" }]],
    ["GET /prototype/", [200, PAGE("Suara — interactive synthetic prototype", "/assets/prototype.js"), { "content-type": "text/html" }]],
    ["GET /assets/main.js", [200, "export const main = true;", { "content-type": "text/javascript" }]],
    ["GET /assets/voice.js", [200, "export const voice = true;", { "content-type": "text/javascript" }]],
    ["GET /assets/prototype.js", [200, "export const prototype = true;", { "content-type": "text/javascript" }]],
    ["GET /api/health", [200, JSON.stringify({ schemaVersion: "suara.health/1", status: "ok", evidenceScope: "vercel_function_liveness_only" }), { "content-type": "application/json; charset=utf-8" }]],
    ["HEAD /api/health", [200, null, { "content-type": "application/json; charset=utf-8" }]],
    ["GET /api/health?probe=1", [400, JSON.stringify({ error: "invalid_request" }), { "content-type": "application/json" }]],
    ["POST /api/health", [405, JSON.stringify({ error: "method_not_allowed" }), { "content-type": "application/json", allow: "GET, HEAD" }]],
  ]);
  mutate?.(routes);
  return {
    calls,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      calls.push({ url: url.href, method: options.method, headers: options.headers,
        redirect: options.redirect, credentials: options.credentials, cache: options.cache });
      const entry = routes.get(`${options.method} ${url.pathname}${url.search}`);
      if (!entry) return new Response("missing fixture", { status: 404, headers: HEADERS });
      const [status, body, headers] = entry;
      return new Response(options.method === "HEAD" ? null : body, { status, headers: { ...HEADERS, ...headers } });
    },
  };
}

test("hosted probe verifies static pages, their assets and the bounded health contract without protected calls", async () => {
  const { calls, fetchImpl } = fixture();
  const report = await runHostedAcceptance({ origin: ORIGIN, fetchImpl });
  assert.equal(report.status, "pass");
  assert.equal(report.assetCount, 3);
  assert.equal(report.providerTokenRequested, false);
  assert.equal(report.protectedCapabilityRouteCalled, false);
  assert.equal(report.microphoneAccessed, false);
  assert.equal(calls.some((call) => /capabilities|session|token/u.test(call.url)), false);
  assert.equal(calls.every((call) => call.headers["User-Agent"] === "Suara-Hosted-Acceptance/1"), true);
  assert.equal(calls.every((call) => call.redirect === "manual" && call.credentials === "omit" && call.cache === "no-store"), true);
});

test("hosted probe stops at the first broken boundary", async () => {
  const { calls, fetchImpl } = fixture({ mutate: (routes) => {
    routes.set("GET /voice/", [200, PAGE("Wrong identity", "/assets/voice.js"), { "content-type": "text/html" }]);
  } });
  await assert.rejects(runHostedAcceptance({ origin: ORIGIN, fetchImpl }), (error) => {
    assert.ok(error instanceof HostedAcceptanceError);
    assert.equal(error.check, "page:/voice/");
    assert.equal(error.code, "identity_invalid");
    return true;
  });
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/", "/voice/"]);
});

test("missing policy headers and leaked private markers fail closed", async () => {
  const missing = fixture({ mutate: (routes) => {
    const [status, body, headers] = routes.get("GET /");
    routes.set("GET /", [status, body, { ...headers, "x-frame-options": "SAMEORIGIN" }]);
  } });
  await assert.rejects(runHostedAcceptance({ origin: ORIGIN, fetchImpl: missing.fetchImpl }), { check: "page:/", code: "header_x-frame-options_invalid" });

  const leaked = fixture({ mutate: (routes) => {
    routes.set("GET /assets/main.js", [200, "const leaked = 'ASSEMBLYAI_API_KEY';", { "content-type": "text/javascript" }]);
  } });
  await assert.rejects(runHostedAcceptance({ origin: ORIGIN, fetchImpl: leaked.fetchImpl }), { check: "asset:/assets/main.js", code: "private_marker_exposed" });
});

test("redirects and oversized declared bodies fail before later boundaries", async () => {
  const redirected = fixture({ mutate: (routes) => {
    routes.set("GET /", [302, "", { location: `${ORIGIN}/other`, "content-type": "text/html" }]);
  } });
  await assert.rejects(runHostedAcceptance({ origin: ORIGIN, fetchImpl: redirected.fetchImpl }), { check: "page:/", code: "redirect_not_allowed" });
  assert.equal(redirected.calls.length, 1);

  const oversized = fixture({ mutate: (routes) => {
    const [status, body, headers] = routes.get("GET /");
    routes.set("GET /", [status, body, { ...headers, "content-length": String(256 * 1024 + 1) }]);
  } });
  await assert.rejects(runHostedAcceptance({ origin: ORIGIN, fetchImpl: oversized.fetchImpl }), { check: "page:/", code: "body_too_large" });
  assert.equal(oversized.calls.length, 1);
});

test("origin must be an exact public HTTPS origin", () => {
  assert.equal(validateHostedOrigin(ORIGIN), ORIGIN);
  for (const value of ["http://suara.example.test", `${ORIGIN}/`, `${ORIGIN}/path`, `${ORIGIN}?x=1`, "https://localhost", "https://user:pass@suara.example.test", " https://suara.example.test"]) {
    assert.throws(() => validateHostedOrigin(value), HostedAcceptanceError);
  }
});
