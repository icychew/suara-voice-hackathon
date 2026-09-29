import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRedisState } from "../server/vercel-redis-state.mjs";
import { QUESTION_BANK } from "../src/voice/questionBank.js";

// Explicitly opt-in local Redis/Lua integration, not a live Upstash test.
// Usage: node scripts/qa-redis-engine.mjs --port 16379 --pidfile /tmp/owned/redis.pid
// No defaults, host override, credentials, environment reads, shutdown, or flush.
const MAX_RESPONSE = 1024 * 1024;
const PENDING = Symbol("incomplete RESP");
const sockets = new Set();
const ownedKeys = new Set();
const IP = "i".repeat(43);
const OTHER_IP = "j".repeat(43);
const bearer = n => String(n).padStart(43, "0");
const operation = n => n.toString(16).padStart(32, "0");
const runPrefix = `qa-${randomBytes(10).toString("hex")}`;
let fixtureIndex = 0;
let engineVerified = false;
let timedOut = false;
let port;
let expectedPidfile;
let commandCount = 0;

function argumentsFrom(argv) {
  if (argv.length !== 4) throw new Error("Explicit --port and --pidfile arguments required.");
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--port", "--pidfile"].includes(argv[i]) || values.has(argv[i])) throw new Error("Invalid arguments.");
    values.set(argv[i], argv[i + 1]);
  }
  const rawPort = values.get("--port");
  const pidfile = values.get("--pidfile");
  if (!/^\d+$/.test(rawPort || "") || Number(rawPort) <= 1024 || Number(rawPort) > 65535 || Number(rawPort) === 6379
      || typeof pidfile !== "string" || !pidfile.startsWith("/") || posix.normalize(pidfile) !== pidfile
      || posix.basename(pidfile) !== "redis.pid" || /[\r\n\0]/.test(pidfile)) throw new Error("Unsafe local engine arguments.");
  return { port: Number(rawPort), pidfile };
}

function encode(command) {
  const parts = [Buffer.from(`*${command.length}\r\n`)];
  for (const value of command) {
    const bytes = Buffer.from(String(value));
    parts.push(Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

function parse(buffer, offset = 0, depth = 0) {
  if (depth > 16) throw new Error("Invalid engine response.");
  if (offset >= buffer.length) return PENDING;
  const end = buffer.indexOf("\r\n", offset);
  if (end < 0) return PENDING;
  const tag = String.fromCharCode(buffer[offset]);
  const text = buffer.toString("utf8", offset + 1, end);
  const next = end + 2;
  if (tag === "-") throw new Error("Redis command failed."); // Never echo raw server errors.
  if (tag === "+") return { value: text, next };
  if (!/^-?\d+$/.test(text)) throw new Error("Invalid engine response.");
  const number = Number(text);
  if (!Number.isSafeInteger(number)) throw new Error("Invalid engine response.");
  if (tag === ":") return { value: number, next };
  if (tag === "$") {
    if (number === -1) return { value: null, next };
    if (number < 0 || number > MAX_RESPONSE) throw new Error("Oversized engine response.");
    if (buffer.length < next + number + 2) return PENDING;
    if (buffer.toString("ascii", next + number, next + number + 2) !== "\r\n") throw new Error("Invalid engine response.");
    return { value: buffer.subarray(next, next + number), next: next + number + 2 };
  }
  if (tag === "*") {
    if (number === -1) return { value: null, next };
    if (number < 0 || number > 10000) throw new Error("Invalid engine response.");
    const values = [];
    let position = next;
    for (let i = 0; i < number; i++) {
      const result = parse(buffer, position, depth + 1);
      if (result === PENDING) return PENDING;
      values.push(result.value); position = result.next;
    }
    return { value: values, next: position };
  }
  throw new Error("Unsupported engine response.");
}

function command(values) {
  if (timedOut) return Promise.reject(new Error("Harness deadline exceeded."));
  if (!engineVerified && !(values[0] === "CONFIG" && values[1] === "GET" && ["pidfile", "dir"].includes(values[2]))) {
    return Promise.reject(new Error("Engine identity not verified."));
  }
  commandCount++;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    sockets.add(socket);
    let bytes = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); sockets.delete(socket); socket.destroy();
      if (error) reject(new Error("Local Redis command unavailable.")); else resolve(value);
    };
    const timer = setTimeout(() => finish(true), 2000);
    socket.on("connect", () => socket.write(encode(values)));
    socket.on("error", () => finish(true));
    socket.on("end", () => { if (!settled) finish(true); });
    socket.on("close", () => { if (!settled) finish(true); });
    socket.on("data", chunk => {
      if (bytes.length + chunk.length > MAX_RESPONSE) return finish(true);
      bytes = Buffer.concat([bytes, chunk]);
      try {
        const result = parse(bytes);
        if (result !== PENDING) {
          if (result.next !== bytes.length) return finish(true);
          const textValue = value => Buffer.isBuffer(value) ? value.toString("utf8") : Array.isArray(value) ? value.map(textValue) : value;
          finish(false, values[0] === "DUMP" ? result.value : textValue(result.value));
        }
      } catch { finish(true); }
    });
  });
}

function track(key) {
  if (!key.startsWith(`{${runPrefix}-`)) throw new Error("Non-test key rejected.");
  ownedKeys.add(key);
  return key;
}
const keyCommand = (op, key, ...args) => command([op, track(key), ...args]);
const unavailable = promise => assert.rejects(promise, { message: "Shared state unavailable." });
const consumeArgs = (n, ipHash = IP, limits = {}) => ({
  tokenHash: bearer(n), ipHash, tokenLimit: 100, globalLimit: 100, dailyLimit: 100, ...limits,
});

function fixture() {
  const prefix = `${runPrefix}-${++fixtureIndex}`;
  const base = `{${prefix}}:suara:`;
  const f = { clock: Date.now(), requests: 0, dropNextConsume: false, dropNextScript: null };
  f.key = suffix => track(base + suffix);
  f.fetch = async (_url, request) => {
    const args = JSON.parse(request.body);
    assert.equal(args[0], "EVAL");
    assert.ok(Number.isInteger(args[2]) && args[2] >= 3 && args[2] <= 6);
    for (const key of args.slice(3, 3 + args[2])) {
      assert.ok(key.startsWith(base)); track(key);
    }
    f.requests++;
    const result = await command(args);
    if (f.dropNextScript && args[1].startsWith(f.dropNextScript)) {
      f.dropNextScript = null;
      throw new Error("Synthetic lost response after actual question-state commit.");
    }
    if (f.dropNextConsume && args[1].startsWith("-- suara-consume-v1")) {
      f.dropNextConsume = false;
      throw new Error("Synthetic lost response after actual commit.");
    }
    return Response.json({ result });
  };
  f.adapter = () => createRedisState({
    url: "https://synthetic-only.upstash.io", token: "synthetic-not-a-credential",
    prefix, fetchImpl: f.fetch, now: () => f.clock,
  });
  f.save = (n, ipHash = IP, ttlSeconds = 120) => f.adapter().saveSession({ tokenHash: bearer(n), ipHash, ttlSeconds });
  f.day = async () => JSON.parse(await keyCommand("HGET", f.key("meta"), "day"));
  f.cap = n => f.key(`question:${bearer(n + 10000)}`);
  f.qargs = (n = 1, sequence = 0, nonce = 1, ipHash = IP) => ({
    capabilityHash: bearer(n + 10000), ipHash, sequence, operationId: operation(nonce),
  });
  f.grant = async (n = 1, ipHash = IP, limits = {}) => {
    await f.save(n, ipHash);
    return f.adapter().consumeSession({ ...consumeArgs(n, ipHash, limits), questionCapabilityHash: bearer(n + 10000) });
  };
  return f;
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  port = args.port; expectedPidfile = args.pidfile;
  const identity = await command(["CONFIG", "GET", "pidfile"]);
  assert.deepEqual(identity, ["pidfile", expectedPidfile]);
  assert.deepEqual(await command(["CONFIG", "GET", "dir"]), ["dir", posix.dirname(expectedPidfile)]);
  engineVerified = true;
  const info = await command(["INFO", "server"]);
  const version = /^redis_version:([0-9]+\.[0-9]+\.[0-9]+)\r?$/m.exec(info)?.[1];
  assert.ok(version, "Redis version not available.");
  const results = [];
  const check = async (name, run) => {
    if (timedOut) return;
    try { await run(); results.push({ name, pass: true }); }
    catch { results.push({ name, pass: false }); }
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    for (const socket of sockets) socket.destroy();
  }, 45000);
  let cleanup = false;
  try {
    await check("initialization-and-persistent-metadata", async () => {
      const f = fixture(); const a = f.adapter();
      await unavailable(a.admitSession({ ipHash: IP, limit: 1 }));
      await unavailable(f.save(1));
      await unavailable(a.consumeSession(consumeArgs(1)));
      assert.deepEqual(await a.initialize(), { initialized: true });
      assert.deepEqual(await f.adapter().initialize(), { initialized: false });
      assert.deepEqual((await keyCommand("HKEYS", f.key("meta"))).sort(), ["clock", "day", "schema"]);
      assert.equal(await keyCommand("PTTL", f.key("meta")), -1);
      assert.equal(await keyCommand("PTTL", f.key("initialized")), -1);
      assert.deepEqual(await f.day(), []);
    });

    await check("concurrent-one-use-bearer", async () => {
      const f = fixture(); await f.adapter().initialize(); await f.save(1);
      const rows = await Promise.all(Array.from({ length: 20 }, () => f.adapter().consumeSession(consumeArgs(1))));
      assert.equal(rows.filter(r => r.allowed).length, 1);
      assert.ok(rows.filter(r => !r.allowed).every(r => r.reason === "unauthorized"));
      assert.equal(await keyCommand("EXISTS", f.key(`session:${bearer(1)}`)), 0);
      assert.equal((await f.day()).length, 1);
      for (const suffix of [`tokens:${IP}`, "minute"]) assert.equal(await keyCommand("ZCARD", f.key(suffix)), 1);
    });

    for (const [name, limits, perIp] of [
      ["daily", { dailyLimit: 3 }, false], ["global-minute", { globalLimit: 3 }, true],
      ["per-ip-minute", { tokenLimit: 3 }, false],
    ]) await check(`concurrent-distinct-bearers-${name}`, async () => {
      const f = fixture(); await f.adapter().initialize();
      const ids = Array.from({ length: 20 }, (_, i) => perIp ? bearer(100 + i) : IP);
      await Promise.all(ids.map((ip, i) => f.save(i + 1, ip)));
      const rows = await Promise.all(ids.map((ip, i) => f.adapter().consumeSession(consumeArgs(i + 1, ip, limits))));
      assert.equal(rows.filter(r => r.allowed).length, 3);
      assert.ok(rows.filter(r => !r.allowed).every(r => r.reason === "rate_limited"));
      assert.equal((await f.day()).length, 3);
      assert.equal(await keyCommand("ZCARD", f.key("minute")), 3);
      assert.ok((await Promise.all(ids.map((_, i) => keyCommand("EXISTS", f.key(`session:${bearer(i + 1)}`))))).every(n => n === 0));
    });

    await check("bearer-nx-ip-real-ttl-and-invalid-ttl", async () => {
      const f = fixture(); const a = f.adapter(); await a.initialize(); await f.save(1);
      await unavailable(f.save(1, OTHER_IP));
      assert.equal((await a.consumeSession(consumeArgs(1, OTHER_IP))).reason, "unauthorized");
      assert.equal((await a.consumeSession(consumeArgs(1))).allowed, true);
      await f.save(2, IP, 1); await delay(1100);
      assert.equal((await a.consumeSession(consumeArgs(2))).reason, "unauthorized");
      for (const [n, op, extra] of [[3, "PERSIST", []], [4, "PEXPIRE", [240000]]]) {
        await f.save(n); await keyCommand(op, f.key(`session:${bearer(n)}`), ...extra);
        await unavailable(a.consumeSession(consumeArgs(n)));
        assert.equal(await keyCommand("EXISTS", f.key(`session:${bearer(n)}`)), 1);
      }
      assert.equal((await f.day()).length, 1);
    });

    const corruptions = [
      ["missing-meta", f => keyCommand("DEL", f.key("meta"))],
      ["missing-guard", f => keyCommand("DEL", f.key("initialized"))],
      ["meta-wrong-type", async f => { await keyCommand("DEL", f.key("meta")); await keyCommand("SET", f.key("meta"), "bad"); }],
      ["guard-wrong-type", async f => { await keyCommand("DEL", f.key("initialized")); await keyCommand("HSET", f.key("initialized"), "x", "y"); }],
      ["bad-guard", f => keyCommand("SET", f.key("initialized"), "2")],
      ["bad-schema", f => keyCommand("HSET", f.key("meta"), "schema", "2")],
      ["extra-field", f => keyCommand("HSET", f.key("meta"), "extra", "0")],
      ["missing-day", f => keyCommand("HDEL", f.key("meta"), "day")],
      ["expiring-meta", f => keyCommand("PEXPIRE", f.key("meta"), 60000)],
      ["expiring-guard", f => keyCommand("PEXPIRE", f.key("initialized"), 60000)],
      ["negative-clock", f => keyCommand("HSET", f.key("meta"), "clock", "-1")],
      ...["not-json", "{}", "[null]", '["1"]', "[-1]", "[1.5]", "[2,1]", `[${Number.MAX_SAFE_INTEGER}]`, `[${Array(10001).fill(0).join(",")}]`]
        .map((raw, i) => [`bad-day-${i + 1}`, f => keyCommand("HSET", f.key("meta"), "day", raw)]),
    ];
    for (const [name, corrupt] of corruptions) await check(`metadata-${name}`, async () => {
      const f = fixture(); const a = f.adapter(); await a.initialize(); await f.save(1);
      await corrupt(f);
      // DUMP captures exact values/types without comparing decreasing TTLs.
      const before = await Promise.all(["meta", "initialized"].map(s => keyCommand("DUMP", f.key(s))));
      await unavailable(a.initialize());
      await unavailable(a.admitSession({ ipHash: IP, limit: 1 }));
      await unavailable(f.save(2));
      await unavailable(a.consumeSession(consumeArgs(1)));
      assert.deepEqual(await Promise.all(["meta", "initialized"].map(s => keyCommand("DUMP", f.key(s)))), before);
      assert.equal(await keyCommand("EXISTS", f.key(`session:${bearer(1)}`)), 1);
      assert.equal(await keyCommand("EXISTS", f.key(`session:${bearer(2)}`)), 0);
    });

    for (const suffix of [`tokens:${IP}`, "minute"]) await check(`quota-wrong-type-${suffix === "minute" ? "global" : "ip"}`, async () => {
      const f = fixture(); const a = f.adapter(); await a.initialize(); await f.save(1);
      const priorClock = await keyCommand("HGET", f.key("meta"), "clock");
      await keyCommand("SET", f.key(suffix), "wrong-type"); f.clock += 1000;
      await unavailable(a.consumeSession(consumeArgs(1)));
      assert.equal(await keyCommand("EXISTS", f.key(`session:${bearer(1)}`)), 1);
      assert.deepEqual(await f.day(), []);
      assert.equal(await keyCommand("HGET", f.key("meta"), "clock"), priorClock);
    });

    await check("quota-non-reset-clock-rollback-and-exact-day-boundary", async () => {
      const f = fixture(); await f.adapter().initialize(); const start = f.clock;
      await f.save(1); assert.equal((await f.adapter().consumeSession(consumeArgs(1, IP, { dailyLimit: 1 }))).allowed, true);
      assert.deepEqual(await f.adapter().initialize(), { initialized: false });
      f.clock -= 30000; await f.save(2);
      assert.equal((await f.adapter().consumeSession(consumeArgs(2, IP, { dailyLimit: 1 }))).reason, "rate_limited");
      assert.equal(Number(await keyCommand("HGET", f.key("meta"), "clock")), start);
      assert.deepEqual(await f.day(), [start]);
      f.clock = start + 60001; await f.save(3);
      assert.equal((await f.adapter().consumeSession(consumeArgs(3, IP, { dailyLimit: 1 }))).reason, "rate_limited");
      f.clock = start + 86400000 - 1; await f.save(4);
      assert.equal((await f.adapter().consumeSession(consumeArgs(4, IP, { dailyLimit: 1 }))).retryAfter, 1);
      f.clock += 1; await f.save(5);
      assert.equal((await f.adapter().consumeSession(consumeArgs(5, IP, { dailyLimit: 1 }))).allowed, true);
      assert.deepEqual(await f.day(), [f.clock]);
      assert.equal(await keyCommand("PTTL", f.key("meta")), -1);
    });

    await check("lowered-minute-limits-and-bounded-admission", async () => {
      const f = fixture(); const a = f.adapter(); await a.initialize();
      assert.equal((await a.admitSession({ ipHash: IP, limit: 1 })).allowed, true);
      const rows = await Promise.all(Array.from({ length: 12 }, () => f.adapter().admitSession({ ipHash: IP, limit: 1 })));
      assert.ok(rows.every(r => !r.allowed));
      assert.equal(await keyCommand("ZCARD", f.key(`admit:${IP}`)), 1);
      for (let n = 1; n <= 2; n++) { await f.save(n); await a.consumeSession(consumeArgs(n)); f.clock += 10000; }
      await f.save(3);
      assert.equal((await a.consumeSession(consumeArgs(3, IP, { tokenLimit: 1 }))).retryAfter, 50);
      f.clock += 50000;
      assert.equal((await a.admitSession({ ipHash: IP, limit: 1 })).allowed, true);
    });

    await check("lost-response-after-real-commit-no-retry-or-refund", async () => {
      const f = fixture(); const a = f.adapter(); await a.initialize(); await f.save(1);
      f.dropNextConsume = true; const before = f.requests;
      await unavailable(a.consumeSession(consumeArgs(1)));
      assert.equal(f.requests, before + 1);
      assert.equal((await f.day()).length, 1);
      assert.equal((await f.adapter().consumeSession(consumeArgs(1))).reason, "unauthorized");
      assert.equal((await f.day()).length, 1);
    });

    await check("question-grant-atomic-with-mint-and-seeded-capability", async () => {
      const f = fixture(); await f.adapter().initialize(); await f.save(1);
      const rows = await Promise.all(Array.from({ length: 20 }, (_, index) => f.adapter().consumeSession({
        ...consumeArgs(1), questionCapabilityHash: bearer(index + 10001),
      })));
      assert.equal(rows.filter(row => row.allowed).length, 1);
      const existing = await Promise.all(Array.from({ length: 20 }, (_, index) => keyCommand("EXISTS", f.cap(index + 1))));
      assert.equal(existing.reduce((sum, value) => sum + value, 0), 1);
      const winner = existing.findIndex(Boolean) + 1;
      const values = await keyCommand("HGETALL", f.cap(winner));
      const cap = Object.fromEntries(Array.from({ length: values.length / 2 }, (_, i) => [values[i * 2], values[i * 2 + 1]]));
      assert.deepEqual(Object.keys(cap).sort(), ["expires", "ip", "pending", "policy", "schema", "selected", "sequence", "used"]);
      assert.deepEqual(cap, { schema: "1", policy: "bank-v1", ip: IP, expires: String(f.clock + 600000),
        used: "0", sequence: "0", pending: "", selected: '["birthplace"]' });
      const ttl = await keyCommand("PTTL", f.cap(winner));
      assert.ok(ttl > 0 && ttl <= 600000);
      assert.equal((await f.day()).length, 1);
      assert.deepEqual((await keyCommand("HKEYS", f.key("meta"))).sort(), ["clock", "day", "schema"]);
    });

    await check("question-grant-denied-mint-or-legacy-consume-never-grants", async () => {
      const f = fixture(); await f.adapter().initialize(); await f.save(1);
      assert.equal((await f.adapter().consumeSession(consumeArgs(1, IP, { dailyLimit: 1 }))).allowed, true);
      assert.equal(await keyCommand("EXISTS", f.cap(1)), 0);
      assert.equal((await f.grant(2, IP, { dailyLimit: 1 })).reason, "rate_limited");
      assert.equal(await keyCommand("EXISTS", f.cap(2)), 0);
      assert.equal((await f.day()).length, 1);
      assert.equal((await f.adapter().consumeSession({ ...consumeArgs(77), questionCapabilityHash: bearer(10077) })).reason, "unauthorized");
      assert.equal(await keyCommand("EXISTS", f.cap(77)), 0);
    });

    await check("question-preexisting-grant-refused-without-bearer-or-quota-write", async () => {
      const f = fixture(); await f.adapter().initialize(); await f.grant(); await f.save(2);
      const before = await Promise.all(["meta", `session:${bearer(2)}`].map(suffix => keyCommand("DUMP", f.key(suffix))));
      const cap = await keyCommand("DUMP", f.cap(1));
      await unavailable(f.adapter().consumeSession({ ...consumeArgs(2), questionCapabilityHash: bearer(10001) }));
      assert.deepEqual(await Promise.all(["meta", `session:${bearer(2)}`].map(suffix => keyCommand("DUMP", f.key(suffix)))), before);
      assert.deepEqual(await keyCommand("DUMP", f.cap(1)), cap);
    });

    await check("question-reserve-concurrent-single-winner-pending-never-unlocks", async () => {
      const f = fixture(); await f.adapter().initialize(); await f.grant();
      const rows = await Promise.all(Array.from({ length: 20 }, (_, index) => f.adapter().reserveQuestion(f.qargs(1, 0, index + 1))));
      assert.equal(rows.filter(row => row.allowed).length, 1);
      const winner = rows.findIndex(row => row.allowed) + 1;
      assert.deepEqual(rows[winner - 1], { allowed: true, selectedIds: ["birthplace"] });
      assert.equal(await keyCommand("HGET", f.cap(1), "used"), "1");
      assert.equal(await keyCommand("HGET", f.cap(1), "pending"), operation(winner));
      f.clock += 120000;
      assert.deepEqual(await f.adapter().reserveQuestion(f.qargs(1, 1, 99)), { allowed: false });
      assert.deepEqual(await f.adapter().reserveQuestion(f.qargs(1, 0, 99)), { allowed: false });
      assert.equal(await keyCommand("HGET", f.cap(1), "pending"), operation(winner));
      assert.equal(await keyCommand("ZCARD", f.key(`question-minute:${IP}`)), 1);
      assert.equal(await keyCommand("ZCARD", f.key("question-minute")), 1);
    });

    for (const [label, global] of [["per-ip", false], ["global", true]]) await check(`question-reserve-${label}-fixed-minute-gate`, async () => {
      const f = fixture(); await f.adapter().initialize();
      const count = global ? 25 : 9;
      const ids = Array.from({ length: count }, (_, index) => global ? bearer(500 + index) : IP);
      await Promise.all(ids.map((id, index) => f.grant(index + 1, id)));
      const rows = await Promise.all(ids.map((id, index) => f.adapter().reserveQuestion(f.qargs(index + 1, 0, index + 1, id))));
      assert.equal(rows.filter(row => row.allowed).length, global ? 24 : 8);
      const refused = rows.findIndex(row => !row.allowed);
      assert.equal(await keyCommand("HGET", f.cap(refused + 1), "used"), "0");
      assert.equal(await keyCommand("HGET", f.cap(refused + 1), "pending"), "");
      f.clock += 60000;
      assert.equal((await f.adapter().reserveQuestion(f.qargs(refused + 1, 0, 99, ids[refused]))).allowed, true);
    });

    await check("question-commit-exact-nonce-ip-sequence-chronological-id", async () => {
      const f = fixture(); await f.adapter().initialize(); await f.grant();
      assert.equal((await f.adapter().reserveQuestion(f.qargs())).allowed, true);
      const selected = QUESTION_BANK[3].id;
      for (const changes of [{ sequence: 1 }, { operationId: operation(2) }, { ipHash: OTHER_IP }, { questionId: "birthplace" }]) {
        assert.deepEqual(await f.adapter().commitQuestion({ ...f.qargs(), questionId: selected, ...changes }), { committed: false });
      }
      const rows = await Promise.all(Array.from({ length: 20 }, () => f.adapter().commitQuestion({ ...f.qargs(), questionId: selected })));
      assert.equal(rows.filter(row => row.committed).length, 1);
      assert.deepEqual(rows.find(row => row.committed), { committed: true, nextSequence: 1 });
      assert.deepEqual(JSON.parse(await keyCommand("HGET", f.cap(1), "selected")), ["birthplace", selected]);
      assert.equal((await f.adapter().reserveQuestion(f.qargs(1, 1, 2))).allowed, true);
      assert.deepEqual(await f.adapter().commitQuestion({ ...f.qargs(1, 1, 2), questionId: QUESTION_BANK[1].id }), { committed: false });
      assert.equal(await keyCommand("HGET", f.cap(1), "pending"), operation(2));
    });

    await check("question-total-eight-selected-ids-and-final-bank-id-exhaust-eligibility", async () => {
      const f = fixture(); await f.adapter().initialize(); await f.grant();
      for (let sequence = 0; sequence < 7; sequence++) {
        assert.equal((await f.adapter().reserveQuestion(f.qargs(1, sequence, sequence + 1))).allowed, true);
        assert.deepEqual(await f.adapter().commitQuestion({ ...f.qargs(1, sequence, sequence + 1), questionId: QUESTION_BANK[sequence + 1].id }),
          { committed: true, nextSequence: sequence + 1 });
      }
      assert.deepEqual(await f.adapter().reserveQuestion(f.qargs(1, 7, 8)), { allowed: false });
      assert.equal(JSON.parse(await keyCommand("HGET", f.cap(1), "selected")).length, 8);
      assert.equal(await keyCommand("HGET", f.cap(1), "used"), "7");
      const last = fixture(); await last.adapter().initialize(); await last.grant();
      await last.adapter().reserveQuestion(last.qargs());
      await last.adapter().commitQuestion({ ...last.qargs(), questionId: QUESTION_BANK.at(-1).id });
      assert.deepEqual(await last.adapter().reserveQuestion(last.qargs(1, 1, 2)), { allowed: false });
    });

    await check("question-immutable-real-ttl-and-absolute-expiry", async () => {
      const f = fixture(); await f.adapter().initialize(); await f.grant();
      const expiry = await keyCommand("HGET", f.cap(1), "expires");
      const initialTtl = await keyCommand("PTTL", f.cap(1));
      await delay(30);
      await f.adapter().reserveQuestion(f.qargs());
      await f.adapter().commitQuestion({ ...f.qargs(), questionId: QUESTION_BANK[1].id });
      const afterTtl = await keyCommand("PTTL", f.cap(1));
      assert.ok(afterTtl < initialTtl);
      assert.equal(await keyCommand("HGET", f.cap(1), "expires"), expiry);
      f.clock = Number(expiry);
      assert.deepEqual(await f.adapter().reserveQuestion(f.qargs(1, 1, 2)), { allowed: false });
      // Accelerate only this owned synthetic key's physical expiry to verify Redis TTL deletion.
      await keyCommand("PEXPIRE", f.cap(1), 50); await delay(80);
      assert.equal(await keyCommand("EXISTS", f.cap(1)), 0);
      assert.deepEqual(await f.adapter().reserveQuestion(f.qargs()), { allowed: false });
      assert.deepEqual(await f.adapter().commitQuestion({ ...f.qargs(), questionId: QUESTION_BANK[1].id }), { committed: false });
      assert.equal(await keyCommand("EXISTS", f.cap(1)), 0);
    });

    const capCorruptions = [
      ["schema", f => keyCommand("HSET", f.cap(1), "schema", "2")],
      ["policy", f => keyCommand("HSET", f.cap(1), "policy", "unknown")],
      ["extra-field", f => keyCommand("HSET", f.cap(1), "extra", "0")],
      ["missing-field", f => keyCommand("HDEL", f.cap(1), "used")],
      ["wrong-type", async f => { await keyCommand("DEL", f.cap(1)); await keyCommand("SET", f.cap(1), "bad", "PX", 600000); }],
      ["persistent", f => keyCommand("PERSIST", f.cap(1))],
      ["excess-ttl", f => keyCommand("PEXPIRE", f.cap(1), 700000)],
      ["attempts", f => keyCommand("HSET", f.cap(1), "used", "9")],
      ["fraction", f => keyCommand("HSET", f.cap(1), "used", "0.5")],
      ["inconsistent-sequence", f => keyCommand("HSET", f.cap(1), "sequence", "1")],
      ["pending", f => keyCommand("HSET", f.cap(1), "pending", "invalid")],
      ["json", f => keyCommand("HSET", f.cap(1), "selected", "not-json")],
      ["non-array", f => keyCommand("HSET", f.cap(1), "selected", "{}")],
      ["unknown-id", f => keyCommand("HSET", f.cap(1), "selected", '["unknown"]')],
      ["duplicate", f => keyCommand("HSET", f.cap(1), "selected", '["birthplace","birthplace"]', "sequence", "1", "used", "1")],
    ];
    for (const [name, corrupt] of capCorruptions) await check(`question-corruption-${name}-no-further-writes`, async () => {
      const f = fixture(); await f.adapter().initialize(); await f.grant(); await corrupt(f);
      const snapshot = await Promise.all([f.cap(1), f.key("meta")].map(key => keyCommand("DUMP", key)));
      f.clock += 1000;
      await unavailable(f.adapter().reserveQuestion(f.qargs()));
      await unavailable(f.adapter().commitQuestion({ ...f.qargs(), questionId: QUESTION_BANK[1].id }));
      assert.deepEqual(await Promise.all([f.cap(1), f.key("meta")].map(key => keyCommand("DUMP", key))), snapshot);
    });

    for (const suffix of [`question-minute:${IP}`, "question-minute"]) await check(`question-wrong-type-minute-${suffix.includes(":") ? "ip" : "global"}`, async () => {
      const f = fixture(); await f.adapter().initialize(); await f.grant();
      await keyCommand("SET", f.key(suffix), "bad");
      const before = await Promise.all([f.cap(1), f.key("meta")].map(key => keyCommand("DUMP", key)));
      f.clock += 1000;
      await unavailable(f.adapter().reserveQuestion(f.qargs()));
      assert.deepEqual(await Promise.all([f.cap(1), f.key("meta")].map(key => keyCommand("DUMP", key))), before);
    });

    await check("question-lost-grant-reserve-commit-responses-never-retry-or-refund", async () => {
      const f = fixture(); await f.adapter().initialize();
      f.dropNextScript = "-- suara-consume-questions-v1";
      await unavailable(f.grant());
      assert.equal((await f.day()).length, 1);
      assert.equal(await keyCommand("EXISTS", f.cap(1)), 1);
      assert.equal((await f.adapter().consumeSession({ ...consumeArgs(1), questionCapabilityHash: bearer(10002) })).reason, "unauthorized");
      f.dropNextScript = "-- suara-question-reserve-v1";
      const before = f.requests;
      await unavailable(f.adapter().reserveQuestion(f.qargs()));
      assert.equal(f.requests, before + 1);
      assert.equal(await keyCommand("HGET", f.cap(1), "pending"), operation(1));
      assert.deepEqual(await f.adapter().reserveQuestion(f.qargs()), { allowed: false });
      f.dropNextScript = "-- suara-question-commit-v1";
      const beforeCommit = f.requests;
      await unavailable(f.adapter().commitQuestion({ ...f.qargs(), questionId: QUESTION_BANK[1].id }));
      assert.equal(f.requests, beforeCommit + 1);
      assert.equal(await keyCommand("HGET", f.cap(1), "used"), "1");
      assert.equal(await keyCommand("HGET", f.cap(1), "sequence"), "1");
      assert.deepEqual(await f.adapter().commitQuestion({ ...f.qargs(), questionId: QUESTION_BANK[1].id }), { committed: false });
      assert.deepEqual(await f.adapter().reserveQuestion(f.qargs()), { allowed: false });
    });
  } finally {
    clearTimeout(deadline);
    if (!timedOut) {
      // Recheck process identity before exact-key cleanup; never flush a database.
      assert.deepEqual(await command(["CONFIG", "GET", "pidfile"]), ["pidfile", expectedPidfile]);
      assert.deepEqual(await command(["CONFIG", "GET", "dir"]), ["dir", posix.dirname(expectedPidfile)]);
      const keys = [...ownedKeys];
      for (let i = 0; i < keys.length; i += 200) await command(["DEL", ...keys.slice(i, i + 200)]);
      for (let i = 0; i < keys.length; i += 200) assert.equal(await command(["EXISTS", ...keys.slice(i, i + 200)]), 0);
      cleanup = true;
    }
  }
  const failed = results.filter(r => !r.pass).map(r => r.name);
  const report = {
    kind: "local-redis-lua-engine", version, passed: results.length - failed.length,
    failed: failed.length, cases: results.length, failures: failed, commands: commandCount,
    timedOut, cleanup, providerCalls: 0, upstashVerified: false, engineRestartTested: false,
  };
  report.pass = failed.length === 0 && !timedOut && cleanup;
  console.log(JSON.stringify(report));
  if (!report.pass) process.exitCode = 1;
}

main().catch(() => {
  for (const socket of sockets) socket.destroy();
  console.log(JSON.stringify({ kind: "local-redis-lua-engine", pass: false,
    error: "Harness failed or local engine identity did not match.", cleanup: false }));
  process.exitCode = 1;
});
