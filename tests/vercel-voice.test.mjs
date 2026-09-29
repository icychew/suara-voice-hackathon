import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { createVercelVoiceHandler, loadVercelVoiceConfig } from "../server/vercel-voice.mjs";

// Handler contract tests only. FakeSharedState models atomic Redis results; these
// tests do NOT establish live Redis persistence, Lua execution, or Vercel trust.
const ORIGIN = "https://suara-handler-test.vercel.app";
const HOST = "suara-handler-test.vercel.app";
const IP = "203.0.113.8";
const CODE = "synthetic-judge-code-only";
const PROVIDER_KEY = "synthetic-provider-secret-only";
const PROVIDER_TOKEN = "synthetic-short-lived-provider-token";
const hash = value => createHash("sha256").update(value).digest("base64url");
const ipHash = value => createHmac("sha256", CODE).update(value).digest("base64url");
const environment = overrides => ({
  VERCEL: "1", SUARA_ENABLE_VERCEL_VOICE: "true", SUARA_PUBLIC_ORIGIN: ORIGIN,
  SUARA_JUDGE_ACCESS_CODE: CODE, ASSEMBLYAI_API_KEY: PROVIDER_KEY,
  SUARA_REDIS_PREFIX: "suara-handler-test", UPSTASH_REDIS_REST_URL: "https://redis-test.invalid",
  UPSTASH_REDIS_REST_TOKEN: "synthetic-redis-secret", ...overrides,
});

class FakeSharedState {
  sessions = new Map();
  events = [];
  attempts = 0;
  admissions = 0;
  async admitSession(args) {
    this.events.push(["admit", args]);
    this.admissions += 1;
    return { allowed: this.admissions <= args.limit, retryAfter: 45 };
  }
  async saveSession(args) {
    this.events.push(["save", args]);
    this.sessions.set(args.tokenHash, args.ipHash);
  }
  async consumeSession(args) {
    this.events.push(["consume", args]);
    // No await between validation and deletion: deliberately atomic fake.
    if (this.sessions.get(args.tokenHash) !== args.ipHash) return { allowed: false, reason: "unauthorized" };
    this.sessions.delete(args.tokenHash);
    if (this.attempts >= args.dailyLimit) return { allowed: false, retryAfter: 3600 };
    this.attempts += 1;
    return { allowed: true };
  }
}

function request(route = "/api/session", { method, headers = {}, url, signal, body } = {}) {
  const values = new Headers({ host: HOST, "x-forwarded-proto": "https", "x-vercel-forwarded-for": IP });
  if (route === "/api/voice/token" || route === "/api/streaming/token") values.set("origin", ORIGIN);
  for (const [key, value] of Object.entries(headers)) {
    if (value === null) values.delete(key); else values.set(key, value);
  }
  return new Request(url ?? `${ORIGIN}${route}`, {
    method: method ?? (route === "/api/session" ? "GET" : "POST"), headers: values, signal,
    ...(body === undefined ? {} : { body, duplex: "half" }),
  });
}

function fixture({ state = new FakeSharedState(), env = environment(), fetchImpl, stateFactory } = {}) {
  let providerCalls = 0;
  const fetcher = async (...args) => {
    providerCalls += 1;
    state.events.push(["provider"]);
    return fetchImpl ? fetchImpl(...args) : Response.json({ token: PROVIDER_TOKEN });
  };
  const options = { env, fetchImpl: fetcher, stateFactory: stateFactory ?? (() => state) };
  return {
    state, options, calls: () => providerCalls,
    session: createVercelVoiceHandler({ route: "/api/session", ...options }),
    capabilities: createVercelVoiceHandler({ route: "/api/capabilities", ...options }),
    token: createVercelVoiceHandler({ route: "/api/voice/token", ...options }),
    streaming: createVercelVoiceHandler({ route: "/api/streaming/token", ...options }),
  };
}
async function bearer(f) {
  const response = await f.session(request("/api/session", { headers: { "x-suara-access-code": CODE } }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("vercel-cdn-cache-control"), "no-store");
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload).sort(), ["expires_in_seconds", "token", "token_type"]);
  assert.equal(payload.token_type, "Bearer");
  assert.equal(payload.expires_in_seconds, 120);
  return payload.token;
}
function tokenRequest(token, options = {}) {
  return request("/api/voice/token", { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });
}
function streamingRequest(token, options = {}) {
  return request("/api/streaming/token", { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });
}
async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error: code });
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("vercel-cdn-cache-control"), "no-store");
}

test("Vercel handler: valid explicit configuration and bounded limits", () => {
  const config = loadVercelVoiceConfig(environment());
  assert.equal(config.host, HOST);
  assert.equal(config.dailyLimit, 60);
  assert.equal(config.sessionLimit, 6);
  assert.equal(config.tokenLimit, 2);
  assert.equal(config.globalLimit, 6);
  assert.throws(() => createVercelVoiceHandler({ route: "/api/unknown" }));
});

test("Vercel handler accepts managed Upstash KV aliases without copying integration secrets", () => {
  const env = environment({
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
    KV_REST_API_URL: "https://redis-managed-test.upstash.io",
    KV_REST_API_TOKEN: "synthetic-managed-redis-secret",
  });
  const config = loadVercelVoiceConfig(env);
  assert.equal(config.redisUrl, env.KV_REST_API_URL);
  assert.equal(config.redisToken, env.KV_REST_API_TOKEN);
});

test("Vercel capabilities require authentication, share the access throttle and never reserve a token", async () => {
  const f = fixture();
  const read = headers => f.capabilities(request("/api/capabilities", { method: "GET", headers }));
  await expectError(await read({}), 401, "access_code_required");
  const response = await read({ "x-suara-access-code": CODE });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.deepEqual(await response.json(), { schemaVersion: "suara.voice_capabilities/1", streaming: false, aiQuestions: false });
  assert.deepEqual(f.state.events.map(([kind]) => kind), ["admit", "admit"]);
  assert.equal(f.calls(), 0); assert.equal(f.state.sessions.size, 0); assert.equal(f.state.attempts, 0);
  for (let index = 0; index < 4; index++) assert.equal((await read({ "x-suara-access-code": CODE })).status, 200);
  await expectError(await read({ "x-suara-access-code": CODE }), 429, "rate_limited");
});

test("Vercel capabilities report optional flags accurately and keep managed token issuance unchanged", async () => {
  for (const [streaming, questions] of [[false, true], [true, false], [true, true]]) {
    const f = fixture({ env: environment({ SUARA_ENABLE_STREAMING_VOICE: String(streaming), SUARA_ENABLE_AI_QUESTIONS: String(questions) }) });
    const response = await f.capabilities(request("/api/capabilities", { method: "GET", headers: { "x-suara-access-code": CODE } }));
    assert.deepEqual(await response.json(), { schemaVersion: "suara.voice_capabilities/1", streaming, aiQuestions: streaming && questions });
    assert.equal(f.calls(), 0); assert.equal(f.state.attempts, 0);
    assert.equal((await f.token(tokenRequest(await bearer(f)))).status, 200);
    assert.equal(f.calls(), 1);
  }
});

test("Vercel capabilities reject untrusted request boundaries and unavailable state", async () => {
  for (const [options, status] of [
    [{ method: "POST" }, 405], [{ url: `${ORIGIN}/api/capabilities?extra=1` }, 400],
    [{ headers: { origin: "https://untrusted.invalid" } }, 403], [{ headers: { host: "untrusted.invalid" } }, 421],
    [{ headers: { "x-vercel-forwarded-for": null } }, 403], [{ headers: { "content-length": "1" } }, 413],
  ]) {
    const f = fixture();
    const response = await f.capabilities(request("/api/capabilities", { method: "GET", ...options,
      headers: { "x-suara-access-code": CODE, ...options.headers } }));
    assert.equal(response.status, status); assert.equal(f.calls(), 0); assert.equal(f.state.events.length, 0);
  }
  const f = fixture({ stateFactory: () => { throw new Error("PRIVATE"); } });
  await expectError(await f.capabilities(request("/api/capabilities", { method: "GET" })), 503, "voice_not_configured");
});

test("Vercel handler: invalid configuration fails closed without state/provider access", async t => {
  for (const overrides of [
    { VERCEL: "0" }, { SUARA_ENABLE_VERCEL_VOICE: "" }, { SUARA_ENABLE_VERCEL_VOICE: "TRUE" },
    { SUARA_PUBLIC_ORIGIN: "http://localhost" }, { SUARA_PUBLIC_ORIGIN: `${ORIGIN}/path` },
    { SUARA_PUBLIC_ORIGIN: "not-a-url" }, { SUARA_PUBLIC_ORIGIN: "https://user:password@example.com" },
    { SUARA_JUDGE_ACCESS_CODE: "" }, { SUARA_JUDGE_ACCESS_CODE: "too-short" },
    { SUARA_JUDGE_ACCESS_CODE: "contains spaces are invalid" }, { SUARA_JUDGE_ACCESS_CODE: "x".repeat(129) },
    { ASSEMBLYAI_API_KEY: "" }, { ASSEMBLYAI_API_KEY: "secret\nheader" },
    { SUARA_REDIS_PREFIX: "" }, { SUARA_REDIS_PREFIX: "bad:namespace" },
    { SUARA_DAILY_TOKEN_LIMIT: "0" }, { SUARA_DAILY_TOKEN_LIMIT: "10001" },
    { SUARA_SESSION_RATE_LIMIT: "101" }, { SUARA_TOKEN_RATE_LIMIT: "1.5" },
    { SUARA_GLOBAL_TOKEN_RATE_LIMIT: "1001" },
  ]) await t.test(Object.keys(overrides)[0] + ":" + Object.values(overrides)[0], async () => {
    assert.throws(() => loadVercelVoiceConfig(environment(overrides)));
    let stateCalls = 0;
    const f = fixture({ env: environment(overrides), stateFactory: () => { stateCalls++; throw new Error("unexpected"); } });
    await expectError(await f.session(request()), 503, "voice_not_configured");
    assert.equal(stateCalls, 0);
    assert.equal(f.calls(), 0);
  });
});

test("Vercel handler: missing shared state is unavailable, never an in-memory fallback", async () => {
  const f = fixture({ stateFactory: () => { throw new Error("redis secret and internal path must stay private"); } });
  await expectError(await f.session(request()), 503, "voice_not_configured");
  assert.equal(f.calls(), 0);
});

test("Vercel handler: route, query, method and request body boundaries", async t => {
  const cases = [
    [{ url: `${ORIGIN}/api/other` }, 400, "bad_request"],
    [{ url: `${ORIGIN}/api/session?secret=value` }, 400, "bad_request"],
    [{ url: `${ORIGIN}/api/session?${"x".repeat(2100)}` }, 400, "bad_request"],
    [{ method: "POST" }, 405, "method_not_allowed"],
    [{ method: "HEAD" }, 405, "method_not_allowed"],
    [{ headers: { "content-length": "1" } }, 413, "request_body_not_allowed"],
    [{ headers: { "transfer-encoding": "chunked" } }, 413, "request_body_not_allowed"],
  ];
  for (const [options, status, code] of cases) await t.test(JSON.stringify(options).slice(0, 110), async () => {
    const f = fixture();
    const response = await f.session(request("/api/session", options));
    if (status === 405) assert.equal(response.headers.get("allow"), "GET");
    await expectError(response, status, code);
    assert.equal(f.state.events.length, 0);
  });
  const f = fixture();
  await expectError(await f.token(request("/api/voice/token", { body: "speech must never arrive" })), 413, "request_body_not_allowed");
  await expectError(await f.token(request("/api/voice/token", { method: "GET" })), 405, "method_not_allowed");
  assert.equal(f.calls(), 0);
});

test("Vercel handler: exact host, origin, HTTPS and single platform IP; no spoofed fallback", async t => {
  const cases = [
    [{ headers: { host: null } }, 421], [{ headers: { host: "evil.example" } }, 421],
    [{ url: "https://evil.example/api/session" }, 421],
    [{ headers: { "x-forwarded-proto": null } }, 421],
    [{ headers: { "x-forwarded-proto": "http" } }, 421],
    [{ headers: { "x-forwarded-proto": "https,http" } }, 421],
    [{ headers: { origin: "https://evil.example" } }, 403],
    [{ headers: { "sec-fetch-site": "cross-site" } }, 403],
    [{ headers: { "x-vercel-forwarded-for": null, "x-real-ip": IP, "x-forwarded-for": IP } }, 403],
    [{ headers: { "x-vercel-forwarded-for": `${IP}, 198.51.100.2` } }, 403],
    [{ headers: { "x-vercel-forwarded-for": "unknown" } }, 403],
  ];
  for (const [options, status] of cases) await t.test(JSON.stringify(options), async () => {
    const f = fixture();
    await expectError(await f.session(request("/api/session", options)), status, status === 421 ? "misdirected_request" : "forbidden");
    assert.equal(f.state.events.length, 0);
  });
  const f = fixture();
  await expectError(await f.token(request("/api/voice/token", { headers: { origin: null } })), 403, "forbidden");
});

test("Vercel handler: failed judge guesses consume shared throttle before access check", async () => {
  const f = fixture({ env: environment({ SUARA_SESSION_RATE_LIMIT: "2" }) });
  await expectError(await f.session(request()), 401, "access_code_required");
  await expectError(await f.session(request("/api/session", { headers: { "x-suara-access-code": "incorrect-code" } })), 401, "access_code_required");
  const limited = await f.session(request("/api/session", { headers: { "x-suara-access-code": CODE } }));
  assert.equal(limited.headers.get("retry-after"), "45");
  await expectError(limited, 429, "rate_limited");
  assert.deepEqual(f.state.events.map(([name]) => name), ["admit", "admit", "admit"]);
  assert.equal(f.calls(), 0);
});

test("Vercel handler: random 120s bearer, token digest only and HMAC IP binding in shared state", async () => {
  const f = fixture();
  const one = await bearer(f);
  const two = await bearer(f);
  assert.match(one, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(one, two);
  const saved = f.state.events.filter(([name]) => name === "save").map(([, args]) => args);
  assert.deepEqual(saved[0], { tokenHash: hash(one), ipHash: ipHash(IP), ttlSeconds: 120 });
  assert.notEqual(saved[0].ipHash, hash(IP));
  for (const value of [one, two, IP, CODE, PROVIDER_KEY]) assert.equal(JSON.stringify(saved).includes(value), false);
  assert.equal(f.calls(), 0);
});

test("Vercel handler: platform IPv6 accepted and spoofed auxiliary IP headers ignored", async () => {
  const f = fixture();
  const ipv6 = "2001:db8::1";
  const response = await f.session(request("/api/session", { headers: {
    "x-suara-access-code": CODE, "x-vercel-forwarded-for": ipv6,
    "x-real-ip": "198.51.100.99", "x-forwarded-for": "192.0.2.88", "x-forwarded-host": "evil.example",
  } }));
  assert.equal(response.status, 200);
  assert.equal(f.state.events[0][1].ipHash, ipHash(ipv6));
});

test("Vercel handler: valid flow reserves atomically before bounded provider exchange", async () => {
  const f = fixture({ fetchImpl: async (url, options) => {
    assert.equal(f.state.attempts, 1);
    assert.equal(f.state.sessions.size, 0);
    assert.equal(url.origin + url.pathname, "https://agents.assemblyai.com/v1/token");
    assert.equal(url.searchParams.get("expires_in_seconds"), "60");
    assert.equal(url.searchParams.get("max_session_duration_seconds"), "600");
    assert.equal(options.headers.Authorization, `Bearer ${PROVIDER_KEY}`);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    return Response.json({ token: PROVIDER_TOKEN });
  } });
  const token = await bearer(f);
  const response = await f.token(tokenRequest(token));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.deepEqual(await response.json(), { token: PROVIDER_TOKEN, expires_in_seconds: 60, max_session_duration_seconds: 600 });
  assert.deepEqual(f.state.events.map(([name]) => name), ["admit", "save", "consume", "provider"]);
  assert.deepEqual(f.state.events[2][1], { tokenHash: hash(token), ipHash: ipHash(IP), tokenLimit: 2, globalLimit: 6, dailyLimit: 60 });
});

test("Vercel handler: concurrent bearer replay across separate handlers mints only once", async () => {
  const f = fixture();
  const second = createVercelVoiceHandler({ route: "/api/voice/token", ...f.options });
  const token = await bearer(f);
  const responses = await Promise.all([f.token(tokenRequest(token)), second(tokenRequest(token))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 401]);
  assert.equal(f.calls(), 1);
  assert.equal(f.state.attempts, 1);
});

test("Vercel handler: invalid bearer and mismatched IP never call provider", async () => {
  const f = fixture();
  for (const authorization of [null, "Basic abc", "Bearer short", `Bearer ${"a".repeat(44)}`]) {
    await expectError(await f.token(request("/api/voice/token", { headers: { authorization } })), 401, "unauthorized");
  }
  assert.equal(f.state.events.length, 0);
  const token = await bearer(f);
  await expectError(await f.token(tokenRequest(token, { headers: { "x-vercel-forwarded-for": "198.51.100.7" } })), 401, "unauthorized");
  assert.equal(f.calls(), 0);
  assert.equal(f.state.attempts, 0);
});

test("Vercel handler: each shared-state failure is generic and never reaches provider", async t => {
  for (const method of ["admitSession", "saveSession", "consumeSession"]) await t.test(method, async () => {
    const f = fixture();
    const token = method === "consumeSession" ? await bearer(f) : null;
    f.state[method] = async () => { throw new Error(`${PROVIDER_KEY} ${CODE} https://private-redis.invalid`); };
    const response = token ? await f.token(tokenRequest(token)) : await f.session(request("/api/session", { headers: { "x-suara-access-code": CODE } }));
    await expectError(response, 503, "quota_unavailable");
    assert.equal(f.calls(), 0);
  });
});

test("Vercel handler: uncertain committed reservation never mints or refunds", async () => {
  const f = fixture();
  const token = await bearer(f);
  const consume = f.state.consumeSession.bind(f.state);
  f.state.consumeSession = async args => { await consume(args); throw new Error("lost Redis response after commit"); };
  await expectError(await f.token(tokenRequest(token)), 503, "quota_unavailable");
  assert.equal(f.state.attempts, 1);
  assert.equal(f.state.sessions.size, 0);
  assert.equal(f.calls(), 0);
});

test("Vercel handler: rate denial propagates retry delay and never calls provider", async () => {
  const f = fixture();
  const token = await bearer(f);
  f.state.consumeSession = async () => ({ allowed: false, reason: "rate_limited", retryAfter: 234 });
  const response = await f.token(tokenRequest(token));
  assert.equal(response.headers.get("retry-after"), "234");
  await expectError(response, 429, "rate_limited");
  assert.equal(f.calls(), 0);
});

test("Vercel handler: failed provider attempt stays counted across subsequent handlers", async () => {
  const f = fixture({ env: environment({ SUARA_DAILY_TOKEN_LIMIT: "1" }), fetchImpl: async () => {
    throw new Error(`${PROVIDER_KEY} provider-private-details`);
  } });
  await expectError(await f.token(tokenRequest(await bearer(f))), 502, "voice_token_unavailable");
  assert.equal(f.state.attempts, 1);
  const next = createVercelVoiceHandler({ route: "/api/voice/token", ...f.options });
  await expectError(await next(tokenRequest(await bearer(f))), 429, "rate_limited");
  assert.equal(f.calls(), 1);
  assert.equal(f.state.attempts, 1);
});

test("Vercel handler: upstream failures and invalid JSON remain generic", async t => {
  for (const [name, response] of [
    ["unauthorized upstream", () => new Response(PROVIDER_KEY, { status: 401 })],
    ["redirect upstream", () => new Response("private-location", { status: 302 })],
    ["invalid JSON", () => new Response("not JSON " + PROVIDER_KEY)],
    ["missing token", () => Response.json({ secret: PROVIDER_KEY })],
    ["short token", () => Response.json({ token: "short" })],
    ["oversized token", () => Response.json({ token: "x".repeat(4097) })],
  ]) await t.test(name, async () => {
    const f = fixture({ fetchImpl: async () => response() });
    await expectError(await f.token(tokenRequest(await bearer(f))), 502, "voice_token_unavailable");
    assert.equal(f.state.attempts, 1);
  });
});

test("Vercel handler: actual streamed upstream bytes capped at 8192 without Content-Length", async () => {
  let cancelled = false;
  let chunks = 0;
  const f = fixture({ fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(3000).fill(32)); },
    cancel() { cancelled = true; },
  })) });
  await expectError(await f.token(tokenRequest(await bearer(f))), 502, "voice_token_unavailable");
  assert.equal(cancelled, true);
  assert.ok(chunks <= 4, `stream should stop promptly, got ${chunks} chunks`);
  assert.equal(f.state.attempts, 1);
});

test("Vercel handler: exactly 8192 upstream bytes remain valid", async () => {
  const base = JSON.stringify({ token: PROVIDER_TOKEN, padding: "" });
  const body = JSON.stringify({ token: PROVIDER_TOKEN, padding: " ".repeat(8192 - Buffer.byteLength(base)) });
  assert.equal(Buffer.byteLength(body), 8192);
  const f = fixture({ fetchImpl: async () => new Response(body) });
  const response = await f.token(tokenRequest(await bearer(f)));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).token, PROVIDER_TOKEN);
});

test("Vercel handler: separate instances respect fake shared quota for distinct concurrent bearers", async () => {
  const f = fixture({ env: environment({ SUARA_DAILY_TOKEN_LIMIT: "1" }) });
  const second = createVercelVoiceHandler({ route: "/api/voice/token", ...f.options });
  const firstBearer = await bearer(f);
  const secondBearer = await bearer(f);
  const responses = await Promise.all([f.token(tokenRequest(firstBearer)), second(tokenRequest(secondBearer))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 429]);
  assert.equal(f.calls(), 1);
  assert.equal(f.state.attempts, 1);
});

test("Vercel handler: oversized declared upstream length cancels body before parsing", async () => {
  let cancelled = false;
  const f = fixture({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { "content-length": "8193" },
  }) });
  await expectError(await f.token(tokenRequest(await bearer(f))), 502, "voice_token_unavailable");
  assert.equal(cancelled, true);
});

test("Vercel handler: pre-cancelled request never reserves or mints", async () => {
  const f = fixture();
  const token = await bearer(f);
  const before = f.state.events.length;
  const controller = new AbortController(); controller.abort();
  await expectError(await f.token(tokenRequest(token, { signal: controller.signal })), 499, "request_cancelled");
  assert.equal(f.state.events.length, before);
  assert.equal(f.calls(), 0);
});

test("Vercel handler: cancellation during reservation retains slot but never mints", async () => {
  const f = fixture();
  const token = await bearer(f);
  const controller = new AbortController();
  const consume = f.state.consumeSession.bind(f.state);
  f.state.consumeSession = async args => { const result = await consume(args); controller.abort(); return result; };
  await expectError(await f.token(tokenRequest(token, { signal: controller.signal })), 499, "request_cancelled");
  assert.equal(f.state.attempts, 1);
  assert.equal(f.calls(), 0);
});

test("Vercel handler: cancellation during admission does not create a bearer", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.state.admitSession = async () => { controller.abort(); return { allowed: true }; };
  await expectError(await f.session(request("/api/session", { signal: controller.signal, headers: { "x-suara-access-code": CODE } })), 499, "request_cancelled");
  assert.equal(f.state.sessions.size, 0);
  assert.equal(f.calls(), 0);
});

test("Vercel handler: cancellation during session save suppresses bearer without deleting stored state", async () => {
  const f = fixture();
  const controller = new AbortController();
  const save = f.state.saveSession.bind(f.state);
  f.state.saveSession = async args => { await save(args); controller.abort(); };
  await expectError(await f.session(request("/api/session", {
    signal: controller.signal, headers: { "x-suara-access-code": CODE },
  })), 499, "request_cancelled");
  // The inaccessible stored digest expires normally; no compensating delete or
  // refund is attempted after cancellation of a potentially committed write.
  assert.equal(f.state.sessions.size, 1);
  assert.equal(f.state.admissions, 1);
  assert.equal(f.state.events.find(([name]) => name === "save")[1].ttlSeconds, 120);
  assert.equal(f.calls(), 0);
});

test("Vercel handler: active provider fetch receives cancellation, no token returned or refund", async () => {
  const controller = new AbortController();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let observedAbort = false;
  const f = fixture({ fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
    entered();
    options.signal.addEventListener("abort", () => {
      observedAbort = true; reject(new DOMException("synthetic abort", "AbortError"));
    }, { once: true });
  }) });
  const token = await bearer(f);
  const pending = f.token(tokenRequest(token, { signal: controller.signal }));
  await started;
  controller.abort();
  const response = await pending;
  await expectError(response, 499, "request_cancelled");
  assert.equal(observedAbort, true);
  assert.equal(f.state.attempts, 1);
  assert.equal(f.state.sessions.size, 0);
});

test("Vercel handler: cancellation after provider response suppresses returned token", async () => {
  const controller = new AbortController();
  const f = fixture({ fetchImpl: async () => { controller.abort(); return Response.json({ token: PROVIDER_TOKEN }); } });
  await expectError(await f.token(tokenRequest(await bearer(f), { signal: controller.signal })), 499, "request_cancelled");
  assert.equal(f.state.attempts, 1);
});

test("Streaming handler: only explicit lowercase true enables minting; disabled route never accesses state", async t => {
  for (const value of [undefined, "", "false", "TRUE", "1", true]) await t.test(String(value), async () => {
    const env = environment({ SUARA_ENABLE_STREAMING_VOICE: value });
    assert.equal(loadVercelVoiceConfig(env).streamingEnabled, false);
    let stateCalls = 0;
    const f = fixture({ env, stateFactory: () => { stateCalls++; throw new Error("unexpected state"); } });
    await expectError(await f.streaming(request("/api/streaming/token")), 503, "streaming_not_configured");
    assert.equal(stateCalls, 0);
    assert.equal(f.calls(), 0);
  });
});

test("Streaming handler: fixed GET destination and raw-key authorization after the existing atomic reservation", async () => {
  const f = fixture({ env: environment({ SUARA_ENABLE_STREAMING_VOICE: "true" }), fetchImpl: async (url, options) => {
    assert.equal(f.state.attempts, 1);
    assert.equal(f.state.sessions.size, 0);
    assert.equal(url.origin + url.pathname, "https://streaming.assemblyai.com/v3/token");
    assert.deepEqual([...url.searchParams], [["expires_in_seconds", "60"], ["max_session_duration_seconds", "600"]]);
    assert.equal(options.headers.Authorization, PROVIDER_KEY);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    return Response.json({ token: PROVIDER_TOKEN, secret: PROVIDER_KEY });
  } });
  const response = await f.streaming(streamingRequest(await bearer(f)));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { token: PROVIDER_TOKEN, expires_in_seconds: 60, max_session_duration_seconds: 600 });
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.state.events.map(([name]) => name), ["admit", "save", "consume", "provider"]);
  assert.deepEqual(f.state.events[2][1], { tokenHash: f.state.events[1][1].tokenHash,
    ipHash: ipHash(IP), tokenLimit: 2, globalLimit: 6, dailyLimit: 60 });
});

test("Streaming handler: route, body, origin, method and bearer boundaries remain fail-closed", async t => {
  for (const [label, options, status, code] of [
    ["query", { url: `${ORIGIN}/api/streaming/token?model=expensive` }, 400, "bad_request"],
    ["wrong route", { url: `${ORIGIN}/api/streaming/other` }, 400, "bad_request"],
    ["body", { body: "private transcript" }, 413, "request_body_not_allowed"],
    ["GET", { method: "GET" }, 405, "method_not_allowed"],
    ["missing origin", { headers: { origin: null } }, 403, "forbidden"],
    ["cross origin", { headers: { origin: "https://evil.example" } }, 403, "forbidden"],
    ["wrong host", { headers: { host: "evil.example" } }, 421, "misdirected_request"],
    ["wrong IP", { headers: { "x-vercel-forwarded-for": "198.51.100.2" } }, 401, "unauthorized"],
    ["missing bearer", { headers: { authorization: null } }, 401, "unauthorized"],
  ]) await t.test(label, async () => {
    const f = fixture({ env: environment({ SUARA_ENABLE_STREAMING_VOICE: "true" }) });
    await expectError(await f.streaming(streamingRequest(await bearer(f), options)), status, code);
    assert.equal(f.calls(), 0);
    assert.equal(f.state.attempts, 0);
  });
});

test("Streaming and managed routes compete for the same one-use bearer, not one bearer per route", async () => {
  const f = fixture({ env: environment({ SUARA_ENABLE_STREAMING_VOICE: "true" }) });
  const token = await bearer(f);
  const results = await Promise.all([f.streaming(streamingRequest(token)), f.token(tokenRequest(token))]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
  assert.equal(f.calls(), 1);
  assert.equal(f.state.attempts, 1);
});

test("Streaming and managed routes share the daily cap for distinct bearers", async () => {
  const f = fixture({ env: environment({ SUARA_ENABLE_STREAMING_VOICE: "true", SUARA_DAILY_TOKEN_LIMIT: "1" }) });
  const one = await bearer(f);
  const two = await bearer(f);
  const results = await Promise.all([f.streaming(streamingRequest(one)), f.token(tokenRequest(two))]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 429]);
  assert.equal(f.calls(), 1);
  assert.equal(f.state.attempts, 1);
});

test("Streaming handler: disabled flag does not disable or alter the managed route", async () => {
  const f = fixture({ fetchImpl: async (url, options) => {
    assert.equal(url.origin, "https://agents.assemblyai.com");
    assert.equal(options.headers.Authorization, `Bearer ${PROVIDER_KEY}`);
    return Response.json({ token: PROVIDER_TOKEN });
  } });
  assert.equal((await f.token(tokenRequest(await bearer(f)))).status, 200);
});

test("Streaming handler: upstream errors and oversized bodies never leak or refund", async t => {
  for (const [label, fetchImpl] of [
    ["rejected", async () => new Response(PROVIDER_KEY, { status: 401 })],
    ["redirect", async () => new Response(PROVIDER_KEY, { status: 302 })],
    ["bad JSON", async () => new Response(PROVIDER_KEY)],
    ["invalid token", async () => Response.json({ token: "short" })],
    ["oversized token", async () => Response.json({ token: "x".repeat(4097) })],
    ["oversized bytes", async () => new Response("x".repeat(8193))],
  ]) await t.test(label, async () => {
    const f = fixture({ env: environment({ SUARA_ENABLE_STREAMING_VOICE: "true" }), fetchImpl });
    const token = await bearer(f);
    await expectError(await f.streaming(streamingRequest(token)), 502, "voice_token_unavailable");
    assert.equal(f.state.attempts, 1);
    await expectError(await f.token(tokenRequest(token)), 401, "unauthorized");
    assert.equal(f.calls(), 1);
  });
});

test("Streaming handler: cancellation reaches active provider fetch and never refunds or retries", async () => {
  const controller = new AbortController();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ env: environment({ SUARA_ENABLE_STREAMING_VOICE: "true" }),
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      entered();
      options.signal.addEventListener("abort", () => reject(new DOMException("synthetic abort", "AbortError")), { once: true });
    }),
  });
  const token = await bearer(f);
  const pending = f.streaming(streamingRequest(token, { signal: controller.signal }));
  await started;
  controller.abort();
  await expectError(await pending, 499, "request_cancelled");
  assert.equal(f.state.attempts, 1);
  assert.equal(f.calls(), 1);
  await expectError(await f.token(tokenRequest(token)), 401, "unauthorized");
});

test("Streaming handler: uncertain shared reservation never reaches the provider", async () => {
  const f = fixture({ env: environment({ SUARA_ENABLE_STREAMING_VOICE: "true" }) });
  const token = await bearer(f);
  const consume = f.state.consumeSession.bind(f.state);
  f.state.consumeSession = async args => { await consume(args); throw new Error("synthetic response lost"); };
  await expectError(await f.streaming(streamingRequest(token)), 503, "quota_unavailable");
  assert.equal(f.state.attempts, 1);
  assert.equal(f.calls(), 0);
});

test("Streaming handler: upstream fetch timeout remains eight seconds with no retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ env: environment({ SUARA_ENABLE_STREAMING_VOICE: "true" }),
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      entered();
      options.signal.addEventListener("abort", () => reject(new DOMException("synthetic timeout", "AbortError")), { once: true });
    }),
  });
  const pending = f.streaming(streamingRequest(await bearer(f)));
  await started;
  t.mock.timers.tick(8_000);
  await expectError(await pending, 502, "voice_token_unavailable");
  assert.equal(f.calls(), 1);
  assert.equal(f.state.attempts, 1);
});
