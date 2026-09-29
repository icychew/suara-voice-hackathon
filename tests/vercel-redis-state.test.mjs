import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRedisState } from "../server/vercel-redis-state.mjs";

const URL = "https://synthetic-only.upstash.io";
const TOKEN = "mock-redis-token-never-sent-live";
const IP = "i".repeat(43);
const OTHER_IP = "j".repeat(43);
const bearer = (n) => String(n).padStart(43, "0");
const options = { url: URL, token: TOKEN, prefix: "suara-pilot" };
const error = { message: "Shared state unavailable." };
const response = (result) => new Response(JSON.stringify({ result }), { status: 200 });
const consume = (tokenHash, ipHash = IP, changes = {}) => ({
  tokenHash, ipHash, tokenLimit: 3, globalLimit: 6, dailyLimit: 10, ...changes,
});

// This is an explicitly synthetic REST/state model, NOT a Redis/Lua emulator.
// It tests the adapter protocol and race-facing contract. Separate assertions
// inspect the actual Lua ordering. Live Upstash execution remains a release gate.
function model() {
  const state = { initialized: false, corrupt: false, day: [], clock: 0, wall: 1_000_000,
    sessions: new Map(), sets: new Map(), requests: [] };
  function windowWait(key, now, duration, maximum) {
    const entries = (state.sets.get(key) || []).filter((entry) => entry.time > now - duration);
    state.sets.set(key, entries);
    return entries.length < maximum ? 0 : Math.max(1, Math.ceil((entries[entries.length - maximum].time + duration - now) / 1000));
  }
  function add(key, time, member) {
    state.sets.set(key, [...(state.sets.get(key) || []), { time, member }]);
  }
  state.fetch = async (url, request) => {
    const command = JSON.parse(request.body);
    state.requests.push({ url, request, command });
    const [, script, count] = command;
    const keys = command.slice(3, 3 + count);
    const args = command.slice(3 + count);
    function validDay() {
      return Array.isArray(state.day) && state.day.length <= 10_000 &&
        state.day.every((stamp, i) => Number.isSafeInteger(stamp) && stamp >= (state.day[i - 1] || 0) && stamp <= state.clock);
    }
    if (script.startsWith("-- suara-initialize-v1")) {
      if (state.corrupt || (state.initialized && !validDay())) return response([-1]);
      if (state.initialized) return response([0]);
      state.initialized = true;
      state.clock = Number(args[0]);
      return response([1]);
    }
    if (!state.initialized || state.corrupt || !validDay()) return response([-1]);
    const time = Math.max(state.clock, Number(args[0]));
    state.clock = time;
    if (script.startsWith("-- suara-admit-v1")) {
      const retry = windowWait(keys[2], time, 60_000, Number(args[1]));
      if (retry) return response([0, retry]);
      add(keys[2], time, args[2]);
      return response([1, 0]);
    }
    if (script.startsWith("-- suara-save-v1")) {
      const existing = state.sessions.get(keys[2]);
      if (existing && existing.expires > state.wall) return response([0]);
      state.sessions.set(keys[2], { ip: args[1], expires: state.wall + Number(args[2]) * 1000 });
      return response([1]);
    }
    assert.ok(script.startsWith("-- suara-consume-v1"));
    const session = state.sessions.get(keys[2]);
    if (!session || session.expires <= state.wall || session.ip !== args[1]) return response([0, 0, 0]);
    state.sessions.delete(keys[2]);
    state.day = state.day.filter((stamp) => stamp > time - 86_400_000);
    const dailyLimit = Number(args[4]);
    const dayRetry = state.day.length < dailyLimit ? 0 : Math.max(1, Math.ceil((state.day[state.day.length - dailyLimit] + 86_400_000 - time) / 1000));
    const retry = Math.max(dayRetry, ...keys.slice(3).map((key, i) => windowWait(key, time, 60_000, Number(args[i + 2]))));
    if (retry) return response([0, 1, retry]);
    state.day.push(time);
    keys.slice(3).forEach((key, i) => add(key, time, args[5 + i]));
    return response([1, 0, 0]);
  };
  state.adapter = (overrides = {}) => createRedisState({ ...options, fetchImpl: state.fetch, now: () => state.wall, ...overrides });
  return state;
}

test("Redis state is inert until called and rejects unsafe configuration and identities without a request", async () => {
  let requests = 0;
  const fetchImpl = () => { requests++; throw new Error("must not fetch"); };
  for (const overrides of [
    { url: "http://synthetic-only.upstash.io" }, { url: "https://elsewhere.example" },
    { url: "https://user:pass@synthetic-only.upstash.io" }, { url: `${URL}/commands` },
    { url: `${URL}?token=unsafe` }, { prefix: "deployment/name" }, { prefix: "x".repeat(65) },
    { prefix: "" }, { token: "secret\nheader" }, { token: "" }, { now: null },
  ]) assert.throws(() => createRedisState({ ...options, fetchImpl, ...overrides }), error);
  const state = createRedisState({ ...options, fetchImpl });
  assert.equal(requests, 0);
  await assert.rejects(state.admitSession({ ipHash: "192.0.2.1", limit: 1 }), error);
  await assert.rejects(state.admitSession({ ipHash: IP, limit: 0 }), error);
  await assert.rejects(state.admitSession({ ipHash: IP, limit: 1.1 }), error);
  await assert.rejects(state.saveSession({ tokenHash: bearer(1), ipHash: IP, ttlSeconds: 121 }), error);
  await assert.rejects(state.consumeSession(consume("raw-bearer")), error);
  await assert.rejects(state.consumeSession(consume(bearer(1), IP, { dailyLimit: Infinity })), error);
  assert.equal(requests, 0);
});

test("synthetic REST protocol uses POST EVAL, bearer header only, fixed same-slot namespace and bounded requests", async () => {
  const m = model();
  const state = m.adapter();
  assert.deepEqual(await state.initialize(), { initialized: true });
  await state.admitSession({ ipHash: IP, limit: 3 });
  await state.saveSession({ tokenHash: bearer(1), ipHash: IP, ttlSeconds: 120 });
  await state.consumeSession(consume(bearer(1)));
  for (const { url, request, command } of m.requests) {
    assert.equal(url, URL);
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "error");
    assert.equal(request.cache, "no-store");
    assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(request.signal instanceof AbortSignal);
    assert.equal(command[0], "EVAL");
    assert.ok(command.slice(3, 3 + command[2]).every((key) => key.startsWith("{suara-pilot}:suara:")));
    assert.ok(Buffer.byteLength(request.body) < 65_536);
    assert.ok(!request.body.includes(TOKEN));
  }
  const final = m.requests.at(-1).command;
  assert.match(final.at(-1), /^[a-f0-9]{32}$/);
  assert.notEqual(final.at(-1), bearer(1));
  assert.notEqual(final.at(-1), IP);
  assert.equal(new Set(final.slice(-2)).size, 2);
});

test("missing or corrupt sentinel fails closed; explicit repeated initialization does not clear modeled quotas", async () => {
  const m = model();
  const a = m.adapter();
  await assert.rejects(a.admitSession({ ipHash: IP, limit: 1 }), error);
  await assert.rejects(a.saveSession({ tokenHash: bearer(1), ipHash: IP, ttlSeconds: 120 }), error);
  await assert.rejects(a.consumeSession(consume(bearer(1))), error);
  await a.initialize();
  await a.admitSession({ ipHash: IP, limit: 1 });
  assert.deepEqual(await m.adapter().initialize(), { initialized: false });
  assert.deepEqual(await m.adapter().admitSession({ ipHash: IP, limit: 1 }), { allowed: false, retryAfter: 60 });
  m.corrupt = true;
  await assert.rejects(a.initialize(), error);
  await assert.rejects(a.consumeSession(consume(bearer(1))), error);
});

test("modeled admission counts bad-code attempts, stays bounded, and expires at the rolling minute boundary", async () => {
  const m = model(); const state = m.adapter(); await state.initialize();
  assert.deepEqual(await state.admitSession({ ipHash: IP, limit: 1 }), { allowed: true, retryAfter: 0 });
  for (let i = 0; i < 4; i++) assert.equal((await state.admitSession({ ipHash: IP, limit: 1 })).allowed, false);
  assert.equal([...m.sets.values()][0].length, 1);
  assert.equal((await state.admitSession({ ipHash: OTHER_IP, limit: 1 })).allowed, true);
  m.wall += 59_001;
  assert.deepEqual(await state.admitSession({ ipHash: IP, limit: 1 }), { allowed: false, retryAfter: 1 });
  m.wall += 999;
  assert.equal((await state.admitSession({ ipHash: IP, limit: 1 })).allowed, true);
});

test("modeled bearer NX/TTL/IP binding and concurrent one-use consumption survive adapter replacement", async () => {
  const m = model(); const state = m.adapter(); await state.initialize();
  await state.saveSession({ tokenHash: bearer(1), ipHash: IP, ttlSeconds: 120 });
  await assert.rejects(state.saveSession({ tokenHash: bearer(1), ipHash: OTHER_IP, ttlSeconds: 120 }), error);
  assert.equal((await state.consumeSession(consume(bearer(1), OTHER_IP))).reason, "unauthorized");
  const results = await Promise.all(Array.from({ length: 12 }, () => m.adapter().consumeSession(consume(bearer(1)))));
  assert.equal(results.filter((result) => result.allowed).length, 1);
  assert.ok(results.filter((result) => !result.allowed).every((result) => result.reason === "unauthorized"));
  await state.saveSession({ tokenHash: bearer(2), ipHash: IP, ttlSeconds: 120 });
  m.wall += 120_000;
  assert.equal((await state.consumeSession(consume(bearer(2)))).reason, "unauthorized");
});

test("modeled atomic quotas reserve before provider work, burn rate-denied bearers, and never refund provider failures", async () => {
  const m = model(); const state = m.adapter(); await state.initialize();
  for (let i = 1; i <= 8; i++) await state.saveSession({ tokenHash: bearer(i), ipHash: IP, ttlSeconds: 120 });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => m.adapter().consumeSession(consume(bearer(i + 1), IP, { tokenLimit: 20, globalLimit: 20, dailyLimit: 2 }))));
  assert.equal(results.filter((r) => r.allowed).length, 2);
  assert.ok(results.filter((r) => !r.allowed).every((r) => r.reason === "rate_limited" && r.retryAfter === 86_400));
  assert.equal((await state.consumeSession(consume(bearer(8)))).reason, "unauthorized");
  assert.equal(m.day.length, 2);
  m.wall += 60_001;
  await state.saveSession({ tokenHash: bearer(9), ipHash: OTHER_IP, ttlSeconds: 120 });
  assert.equal((await m.adapter().consumeSession(consume(bearer(9), OTHER_IP, { dailyLimit: 2 }))).reason, "rate_limited");
  m.wall += 86_400_000;
  await state.saveSession({ tokenHash: bearer(10), ipHash: IP, ttlSeconds: 120 });
  assert.equal((await state.consumeSession(consume(bearer(10), IP, { dailyLimit: 2 }))).allowed, true);
});

test("modeled minute quotas distinguish per-IP and global limits; lowered limits calculate enough expirations", async () => {
  const m = model(); const state = m.adapter(); await state.initialize();
  for (let i = 1; i <= 2; i++) {
    await state.saveSession({ tokenHash: bearer(i), ipHash: IP, ttlSeconds: 120 });
    await state.consumeSession(consume(bearer(i)));
    m.wall += 10_000;
  }
  await state.saveSession({ tokenHash: bearer(3), ipHash: IP, ttlSeconds: 120 });
  assert.deepEqual(await state.consumeSession(consume(bearer(3), IP, { tokenLimit: 1 })), { allowed: false, reason: "rate_limited", retryAfter: 50 });
  await state.saveSession({ tokenHash: bearer(4), ipHash: OTHER_IP, ttlSeconds: 120 });
  assert.equal((await state.consumeSession(consume(bearer(4), OTHER_IP, { globalLimit: 2 }))).reason, "rate_limited");
});

test("modeled shared clock clamps backwards request clocks without clearing quota", async () => {
  const m = model(); const state = m.adapter(); await state.initialize();
  await state.admitSession({ ipHash: IP, limit: 1 });
  m.wall -= 30_000;
  assert.deepEqual(await m.adapter().admitSession({ ipHash: IP, limit: 1 }), { allowed: false, retryAfter: 60 });
  assert.equal(m.clock, 1_000_000);
  const invalid = m.adapter({ now: () => NaN });
  const count = m.requests.length;
  await assert.rejects(invalid.initialize(), error);
  assert.equal(m.requests.length, count);
});

test("modeled deleted/corrupt day ledger fails closed instead of auto-zeroing or resetting on initialize", async () => {
  for (const corrupted of [undefined, null, {}, [NaN], [Infinity], [-1], [2_000_000], [900_000, 800_000], Array(10_001).fill(0)]) {
    const m = model(); const state = m.adapter(); await state.initialize();
    await state.saveSession({ tokenHash: bearer(1), ipHash: IP, ttlSeconds: 120 });
    m.day = corrupted;
    await assert.rejects(state.initialize(), error);
    await assert.rejects(state.admitSession({ ipHash: IP, limit: 3 }), error);
    await assert.rejects(state.saveSession({ tokenHash: bearer(2), ipHash: IP, ttlSeconds: 120 }), error);
    await assert.rejects(state.consumeSession(consume(bearer(1))), error);
    assert.equal(m.sessions.size, 1);
    assert.equal(m.day, corrupted);
  }
});

test("actual Lua scripts contain fail-closed sentinel checks, atomic ordering, bounded admission and required persistent day ledger", async () => {
  const source = await readFile(new globalThis.URL("../server/vercel-redis-state.mjs", import.meta.url), "utf8");
  assert.match(source, /redis\.call\('PTTL', KEYS\[1\]\) ~= -1/);
  assert.match(source, /redis\.call\('HLEN', KEYS\[1\]\) ~= 3/);
  assert.match(source, /local raw = redis\.call\('HGET', KEYS\[1\], 'day'\)/);
  assert.match(source, /not raw or string\.len\(raw\) > 180002/);
  assert.match(source, /pcall\(cjson\.decode, raw\)/);
  assert.match(source, /#day > 10000/);
  assert.match(source, /stamp < previous or stamp > clock/);
  assert.match(source, /EXISTS', KEYS\[2\], KEYS\[3\], KEYS\[4\]/);
  assert.match(source, /'EX', ARGV\[3\], 'NX'/);
  assert.match(source, /math\.max\(tonumber\(ARGV\[1\]\), tonumber\(redis\.call\('HGET'/);
  const consumeScript = source.split("const CONSUME =")[1].split("function fail")[0];
  assert.ok(consumeScript.indexOf("~= ARGV[2]") < consumeScript.indexOf("redis.call('DEL'"));
  assert.ok(consumeScript.indexOf("redis.call('DEL'") < consumeScript.indexOf("local retry"));
  assert.ok(consumeScript.indexOf("if retry > 0") < consumeScript.indexOf("redis.call('ZADD'"));
  assert.match(consumeScript, /for i = 4, 5 do redis\.call\('ZADD', KEYS\[i\], time, ARGV\[i \+ 2\]\)/);
  assert.match(consumeScript, /redis\.call\('HSET', KEYS\[1\], 'day', encodeday\(kept\)\)/);
  assert.doesNotMatch(source, /EXPIRE', KEYS\[1\]/);
  assert.doesNotMatch(consumeScript, /EXPIRE', KEYS\[6\]/);
  assert.doesNotMatch(source, /console\.|localStorage|process\.env|setInterval|\/pipeline/);
});

test("REST failures and malformed result tuples are sanitized without retry", async () => {
  for (const factory of [
    () => { throw new Error(`provider-secret ${TOKEN}`); },
    () => new Response(`secret ${TOKEN}`, { status: 401 }),
    () => new Response("not json"),
    () => new Response(JSON.stringify({ error: TOKEN })),
    () => new Response(JSON.stringify({ result: [1], extra: TOKEN })),
    () => response(null), () => response("1"), () => response(["1"]),
    () => response([2]), () => response([-1]), () => response([1, 0]),
  ]) {
    let calls = 0;
    const state = createRedisState({ ...options, fetchImpl: async () => { calls++; return factory(); } });
    await assert.rejects(state.initialize(), error);
    assert.equal(calls, 1);
  }
  for (const result of [[0, -1], [0, 61], [1, 2], [1], [0, 0]]) {
    await assert.rejects(createRedisState({ ...options, fetchImpl: async () => response(result) }).admitSession({ ipHash: IP, limit: 1 }), error);
  }
  for (const result of [[0, 2, 0], [0, 1, 86_401], [0, 0, 1], [1, 0, 1], [0, 1, 0]]) {
    await assert.rejects(createRedisState({ ...options, fetchImpl: async () => response(result) }).consumeSession(consume(bearer(1))), error);
  }
});

test("REST response body is bounded by declared and streamed bytes and reader is cancelled", async () => {
  let cancelled = 0;
  for (const headers of [{ "content-length": "9000" }, {}]) {
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(8_193)); },
      cancel() { cancelled++; },
    });
    const state = createRedisState({ ...options, fetchImpl: async () => new Response(stream, { headers }) });
    await assert.rejects(state.initialize(), error);
  }
  assert.equal(cancelled, 1); // Declared oversized body is aborted before locking its reader.
});

test("4-second deadline bounds a stuck fetch and a stuck body, aborts and never retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const stuckBody of [false, true]) {
    let signal; let calls = 0;
    const state = createRedisState({ ...options, fetchImpl: async (_, request) => {
      calls++; signal = request.signal;
      return stuckBody ? new Response(new ReadableStream({})) : new Promise(() => {});
    } });
    const pending = state.initialize();
    const rejected = assert.rejects(pending, error);
    await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(4_000);
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
  }
});
