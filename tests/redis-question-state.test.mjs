import assert from "node:assert/strict";
import test from "node:test";
import { createRedisState } from "../server/vercel-redis-state.mjs";
import { QUESTION_BANK, QUESTION_POLICY, eligibleQuestions } from "../src/voice/questionBank.js";

const OPTIONS = { url: "https://synthetic-only.upstash.io", token: "synthetic-redis-key", prefix: "question-test" };
const IP = "i".repeat(43);
const OTHER_IP = "j".repeat(43);
const digest = number => String(number).padStart(43, "0");
const operation = number => number.toString(16).padStart(32, "0");
const failure = { message: "Shared state unavailable." };
const json = result => Response.json({ result });
const reserve = (changes = {}) => ({ capabilityHash: digest(1), ipHash: IP, sequence: 0, operationId: operation(1), ...changes });
const commit = (id, changes = {}) => ({ ...reserve(), questionId: id, ...changes });

// This is an explicitly synthetic transport/state model, not a Redis engine or
// a Lua emulator. Production scripts are transported but NOT executed by this
// fixture. Real-engine transaction/TTL verification remains a separate gate.
function model() {
  const m = { wall: 1_000_000, clock: 1_000_000, initialized: true, corruptMeta: false,
    calls: [], caps: new Map(), sessions: new Map(), windows: new Map(), day: [], lose: null };
  const key = suffix => `{question-test}:suara:${suffix}`;
  const liveCap = capKey => {
    const cap = m.caps.get(capKey);
    if (cap && cap.ttlEnds <= m.wall) { m.caps.delete(capKey); return undefined; }
    return cap;
  };
  const validCap = cap => {
    if (cap.schema !== "1" || cap.policy !== QUESTION_POLICY || !/^[A-Za-z0-9_-]{43}$/.test(cap.ip)
        || !Number.isSafeInteger(cap.expires) || cap.expires > Math.max(m.wall, m.clock) + 600_000
        || !Number.isSafeInteger(cap.used) || cap.used < 0 || cap.used > 8
        || !Number.isSafeInteger(cap.sequence) || cap.sequence < 0 || cap.sequence > 7
        || cap.ttlEnds - m.wall > 600_000 || cap.ttlEnds === Infinity
        || typeof cap.pending !== "string" || (cap.pending && !/^[a-f0-9]{32}$/.test(cap.pending))
        || cap.used !== cap.sequence + (cap.pending ? 1 : 0)
        || !Array.isArray(cap.selectedIds) || cap.selectedIds[0] !== "birthplace"
        || cap.selectedIds.length !== cap.sequence + 1) return false;
    try { eligibleQuestions(cap.selectedIds); } catch { return false; }
    return true;
  };
  m.fetch = async (url, request) => {
    const command = JSON.parse(request.body);
    const [, script, keyCount] = command;
    const keys = command.slice(3, 3 + keyCount);
    const args = command.slice(3 + keyCount);
    m.calls.push({ url, request, command, script, keys, args });
    const respond = result => {
      if (m.lose && script.startsWith(m.lose)) { m.lose = null; throw new Error("Synthetic lost response after model commit"); }
      return json(result);
    };
    if (!m.initialized || m.corruptMeta) return json([-1]);
    if (script.startsWith("-- suara-save-v1")) {
      if (m.sessions.has(keys[2])) return json([0]);
      m.sessions.set(keys[2], { ip: args[1], ttlEnds: m.wall + Number(args[2]) * 1000 });
      return json([1]);
    }
    if (script.startsWith("-- suara-consume-")) {
      const session = m.sessions.get(keys[2]);
      if (!session || session.ip !== args[1] || session.ttlEnds <= m.wall) return json([0, 0, 0]);
      const grant = script.startsWith("-- suara-consume-questions-v1");
      if (grant && liveCap(keys[5])) return json([-1]);
      m.clock = Math.max(m.wall, m.clock);
      m.sessions.delete(keys[2]);
      m.day = m.day.filter(value => value > m.clock - 86_400_000);
      if (m.day.length >= Number(args[4])) return json([0, 1, 86400]);
      m.day.push(m.clock);
      if (grant) m.caps.set(keys[5], { schema: "1", policy: "bank-v1", ip: args[1], expires: m.clock + 600_000,
        ttlEnds: m.wall + 600_000, used: 0, sequence: 0, pending: "", selectedIds: ["birthplace"] });
      return respond([1, 0, 0]);
    }
    const cap = liveCap(keys[2]);
    if (!cap) return json([0]);
    if (!validCap(cap)) return json([-1]);
    if (cap.ip !== args[1] || cap.expires <= Math.max(m.wall, m.clock)) return json([0]);
    const sequence = Number(args[2]);
    if (script.startsWith("-- suara-question-reserve-v1")) {
      if (sequence !== cap.sequence || cap.pending || cap.used >= 8 || !eligibleQuestions(cap.selectedIds).length) return json([0]);
      const time = Math.max(m.wall, m.clock);
      for (let index = 3; index < 5; index++) {
        const entries = m.windows.get(keys[index]) || [];
        if (!Array.isArray(entries)) return json([-1]);
      }
      m.clock = time;
      for (let index = 3; index < 5; index++) m.windows.set(keys[index], (m.windows.get(keys[index]) || []).filter(value => value > time - 60_000));
      if (m.windows.get(keys[3]).length >= 8 || m.windows.get(keys[4]).length >= 24) return json([0]);
      cap.used++;
      cap.pending = args[3];
      for (let index = 3; index < 5; index++) m.windows.get(keys[index]).push(time);
      return respond([1, JSON.stringify(cap.selectedIds)]);
    }
    assert.ok(script.startsWith("-- suara-question-commit-v1"));
    if (sequence !== cap.sequence || !cap.pending || cap.pending !== args[3]
        || !eligibleQuestions(cap.selectedIds).some(question => question.id === args[4])) return json([0]);
    m.clock = Math.max(m.wall, m.clock);
    cap.selectedIds.push(args[4]);
    cap.sequence++;
    cap.pending = "";
    return respond([1, cap.sequence]);
  };
  m.adapter = () => createRedisState({ ...OPTIONS, fetchImpl: m.fetch, now: () => m.wall });
  m.cap = number => m.caps.get(key(`question:${digest(number)}`));
  m.issue = async (number = 1, ipHash = IP, extra = {}) => {
    const state = m.adapter();
    await state.saveSession({ tokenHash: digest(number + 1000), ipHash, ttlSeconds: 120 });
    return state.consumeSession({ tokenHash: digest(number + 1000), ipHash, tokenLimit: 50, globalLimit: 100,
      dailyLimit: 100, questionCapabilityHash: digest(number), ...extra });
  };
  return m;
}

test("question-state API rejects unsafe hashes, sequences, operation IDs and unknown IDs before transport", async () => {
  let calls = 0;
  const state = createRedisState({ ...OPTIONS, fetchImpl: async () => { calls++; throw new Error("unexpected"); } });
  for (const changes of [
    { capabilityHash: "raw-token" }, { ipHash: "203.0.113.1" }, { sequence: -1 }, { sequence: 8 },
    { sequence: 0.5 }, { operationId: "" }, { operationId: "X".repeat(32) }, { operationId: operation(1) + "0" },
  ]) await assert.rejects(state.reserveQuestion(reserve(changes)), failure);
  await assert.rejects(state.commitQuestion(commit("unknown-question")), failure);
  await assert.rejects(state.commitQuestion(commit(QUESTION_BANK[1].id, { operationId: "invalid" })), failure);
  await assert.rejects(state.consumeSession({ tokenHash: digest(2), ipHash: IP, tokenLimit: 1, globalLimit: 1,
    dailyLimit: 1, questionCapabilityHash: null }), failure);
  assert.equal(calls, 0);
});

test("optional capability grant uses a distinct atomic mint script and unchanged schema1 meta", async () => {
  const m = model();
  assert.deepEqual(await m.issue(), { allowed: true });
  assert.deepEqual(m.cap(1), { schema: "1", policy: "bank-v1", ip: IP, expires: 1_600_000, ttlEnds: 1_600_000,
    used: 0, sequence: 0, pending: "", selectedIds: ["birthplace"] });
  const grant = m.calls.at(-1);
  assert.match(grant.script, /^-- suara-consume-questions-v1/);
  assert.equal(grant.keys.length, 6);
  assert.equal(grant.keys[5], `{question-test}:suara:question:${digest(1)}`);
  assert.equal(grant.script.includes("'schema', '2'"), false);
  assert.ok(grant.script.indexOf("kind(KEYS[6])") < grant.script.indexOf("local time = tick()"));
  assert.ok(grant.script.indexOf("kept[#kept + 1] = time") < grant.script.indexOf("'HSET', KEYS[6]"));
  assert.match(grant.script, /'PEXPIRE', KEYS\[6\], 600000/);
  await m.issue(2, IP, { questionCapabilityHash: undefined });
  assert.match(m.calls.at(-1).script, /^-- suara-consume-v1\n/);
  assert.equal(m.calls.at(-1).keys.length, 5);
  assert.equal(m.cap(2), undefined);
});

test("no grant on denied mint, no overwrite of existing capability, no automatic initialization", async () => {
  const m = model();
  await m.issue();
  assert.deepEqual(await m.issue(2, IP, { dailyLimit: 1 }), { allowed: false, reason: "rate_limited", retryAfter: 86400 });
  assert.equal(m.cap(2), undefined);
  const original = structuredClone(m.cap(1));
  await assert.rejects(m.issue(3, IP, { questionCapabilityHash: digest(1) }), failure);
  assert.deepEqual(m.cap(1), original);
  for (const field of ["initialized", "corruptMeta"]) {
    const broken = model(); broken[field] = field === "corruptMeta";
    await assert.rejects(broken.issue(), failure);
    assert.equal(broken.caps.size, 0);
    assert.equal(broken.calls.some(call => call.script.startsWith("-- suara-initialize")), false);
  }
});

test("one ready sequence reserves once across adapter instances and stays pending without timeout unlock", async () => {
  const m = model(); await m.issue();
  const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => m.adapter()
    .reserveQuestion(reserve({ operationId: operation(index + 1) }))));
  assert.deepEqual(responses[0], { allowed: true, selectedIds: ["birthplace"] });
  assert.equal(responses.filter(value => value.allowed).length, 1);
  assert.equal(m.cap(1).used, 1);
  assert.equal(m.cap(1).pending, operation(1));
  m.wall += 120_000;
  assert.deepEqual(await m.adapter().reserveQuestion(reserve({ sequence: 1, operationId: operation(2) })), { allowed: false });
  assert.deepEqual(await m.adapter().reserveQuestion(reserve()), { allowed: false });
  assert.equal(m.cap(1).pending, operation(1));
});

test("commit checks IP, exact sequence, operation nonce and chronological unselected ID", async () => {
  const m = model(); await m.issue();
  await m.adapter().reserveQuestion(reserve());
  for (const changes of [{ ipHash: OTHER_IP }, { sequence: 1 }, { operationId: operation(2) }]) {
    assert.deepEqual(await m.adapter().commitQuestion(commit(QUESTION_BANK[3].id, changes)), { committed: false });
  }
  assert.deepEqual(await m.adapter().commitQuestion(commit("birthplace")), { committed: false });
  assert.equal(m.cap(1).pending, operation(1));
  assert.deepEqual(await m.adapter().commitQuestion(commit(QUESTION_BANK[3].id)), { committed: true, nextSequence: 1 });
  assert.deepEqual(m.cap(1).selectedIds, ["birthplace", QUESTION_BANK[3].id]);
  assert.deepEqual(await m.adapter().commitQuestion(commit(QUESTION_BANK[3].id)), { committed: false });
  await m.adapter().reserveQuestion(reserve({ sequence: 1, operationId: operation(2) }));
  assert.deepEqual(await m.adapter().commitQuestion(commit(QUESTION_BANK[1].id, { sequence: 1, operationId: operation(2) })), { committed: false });
  assert.equal(m.cap(1).pending, operation(2));
});

test("selected history and attempt entitlement stay bounded; final catalog question closes eligibility early", async () => {
  const m = model(); await m.issue();
  for (let sequence = 0; sequence < 7; sequence++) {
    const options = { sequence, operationId: operation(sequence + 1) };
    assert.equal((await m.adapter().reserveQuestion(reserve(options))).allowed, true);
    assert.deepEqual(await m.adapter().commitQuestion(commit(QUESTION_BANK[sequence + 1].id, options)),
      { committed: true, nextSequence: sequence + 1 });
  }
  assert.equal(m.cap(1).selectedIds.length, 8);
  assert.equal(m.cap(1).used, 7);
  assert.deepEqual(await m.adapter().reserveQuestion(reserve({ sequence: 7, operationId: operation(8) })), { allowed: false });
  const short = model(); await short.issue();
  await short.adapter().reserveQuestion(reserve());
  await short.adapter().commitQuestion(commit(QUESTION_BANK.at(-1).id));
  assert.deepEqual(await short.adapter().reserveQuestion(reserve({ sequence: 1, operationId: operation(2) })), { allowed: false });
});

test("capability TTL and absolute expiry are immutable; expiry and missing state never create fresh allowance", async () => {
  const m = model(); await m.issue();
  const expiry = [m.cap(1).expires, m.cap(1).ttlEnds];
  m.wall += 30_000;
  await m.adapter().reserveQuestion(reserve());
  await m.adapter().commitQuestion(commit(QUESTION_BANK[1].id));
  assert.deepEqual([m.cap(1).expires, m.cap(1).ttlEnds], expiry);
  m.clock = expiry[0];
  assert.deepEqual(await m.adapter().reserveQuestion(reserve({ sequence: 1, operationId: operation(2) })), { allowed: false });
  m.wall = expiry[1];
  assert.deepEqual(await m.adapter().reserveQuestion(reserve()), { allowed: false });
  assert.equal(m.cap(1), undefined);
  assert.deepEqual(await m.adapter().commitQuestion(commit(QUESTION_BANK[1].id)), { committed: false });
  assert.equal(m.caps.size, 0);
});

test("fixed per-IP eight and global24 minute limits span distinct capability grants", async () => {
  const m = model();
  for (let index = 1; index <= 9; index++) {
    await m.issue(index);
    assert.equal((await m.adapter().reserveQuestion(reserve({ capabilityHash: digest(index), operationId: operation(index) }))).allowed, index <= 8);
  }
  assert.equal(m.cap(9).used, 0);
  m.wall += 60_000;
  assert.equal((await m.adapter().reserveQuestion(reserve({ capabilityHash: digest(9), operationId: operation(9) }))).allowed, true);
  const global = model();
  for (let index = 1; index <= 25; index++) {
    const ipHash = String(index).padStart(43, "p");
    await global.issue(index, ipHash);
    assert.equal((await global.adapter().reserveQuestion(reserve({ capabilityHash: digest(index), ipHash,
      operationId: operation(index) }))).allowed, index <= 24);
  }
  assert.equal(global.cap(25).used, 0);
});

test("malformed capability fields fail closed without rewriting them", async () => {
  for (const changes of [
    { schema: "2" }, { policy: "other" }, { ip: "plain-ip" }, { used: 9 }, { used: -1 }, { used: 1.5 },
    { sequence: 8 }, { pending: "unsafe" }, { used: 1 }, { ttlEnds: Infinity }, { expires: 9_000_000 },
    { selectedIds: [] }, { selectedIds: ["unknown"] }, { selectedIds: ["birthplace", "birthplace"], sequence: 1, used: 1 },
  ]) {
    const m = model(); await m.issue(); Object.assign(m.cap(1), changes);
    const before = structuredClone(m.cap(1));
    await assert.rejects(m.adapter().reserveQuestion(reserve()), failure);
    await assert.rejects(m.adapter().commitQuestion(commit(QUESTION_BANK[1].id)), failure);
    assert.deepEqual(m.cap(1), before);
  }
});

test("lost model responses after grant, reserve and commit cause sanitized uncertainty without retry/refund", async () => {
  const grant = model(); grant.lose = "-- suara-consume-questions-v1";
  await assert.rejects(grant.issue(), failure);
  assert.equal(grant.day.length, 1); assert.equal(grant.caps.size, 1); assert.equal(grant.calls.length, 2);
  const m = model(); await m.issue();
  m.lose = "-- suara-question-reserve-v1";
  const before = m.calls.length;
  await assert.rejects(m.adapter().reserveQuestion(reserve()), failure);
  assert.equal(m.calls.length, before + 1);
  assert.equal(m.cap(1).pending, operation(1)); assert.equal(m.cap(1).used, 1);
  assert.deepEqual(await m.adapter().reserveQuestion(reserve()), { allowed: false });
  m.lose = "-- suara-question-commit-v1";
  await assert.rejects(m.adapter().commitQuestion(commit(QUESTION_BANK[1].id)), failure);
  // A committed write cannot be rolled back just because its response was lost.
  assert.equal(m.cap(1).sequence, 1); assert.equal(m.cap(1).used, 1);
  assert.deepEqual(m.cap(1).selectedIds, ["birthplace", QUESTION_BANK[1].id]);
  assert.deepEqual(await m.adapter().commitQuestion(commit(QUESTION_BANK[1].id)), { committed: false });
});

test("transport carries only hashed security metadata, IDs and counters; scripts never refresh capability TTL", async () => {
  const m = model(); await m.issue();
  const sensitive = "Synthetic transcript must not enter Redis";
  await m.adapter().reserveQuestion({ ...reserve(), transcript: sensitive });
  await m.adapter().commitQuestion({ ...commit(QUESTION_BANK[1].id), transcript: sensitive });
  for (const call of m.calls) {
    assert.equal(call.url, OPTIONS.url);
    assert.equal(call.request.headers.Authorization, `Bearer ${OPTIONS.token}`);
    assert.equal(call.request.redirect, "error");
    assert.equal(call.request.cache, "no-store");
    assert.equal(call.request.body.includes(sensitive), false);
    assert.ok(call.keys.every(key => key.startsWith("{question-test}:suara:")));
    assert.ok(Buffer.byteLength(call.request.body) < 65_536);
  }
  const reserved = m.calls.find(call => call.script.startsWith("-- suara-question-reserve-v1"));
  const committed = m.calls.find(call => call.script.startsWith("-- suara-question-commit-v1"));
  assert.equal(reserved.keys.length, 5);
  assert.equal(committed.keys.length, 3);
  for (const { script } of [reserved, committed]) {
    assert.match(script, /'HLEN', KEYS\[3\]\) ~= 8/);
    assert.doesNotMatch(script, /'P?EXPIRE', KEYS\[3\]/);
    assert.doesNotMatch(script, /redis\.call\('DEL', KEYS\[3\]/);
  }
  assert.match(reserved.script, /waitfor\(KEYS\[4\], time, 60000, 8\)/);
  assert.match(reserved.script, /waitfor\(KEYS\[5\], time, 60000, 24\)/);
  assert.equal(new Set(reserved.args.slice(-2)).size, 2);
});

test("question-result parsers reject malformed acknowledgements and histories", async () => {
  for (const result of [null, [1], [1, "not-json"], [1, '["unknown"]'], [1, '["birthplace","birthplace"]'],
    [1, JSON.stringify(["birthplace", QUESTION_BANK[1].id])], [1, []], [0, 1], [-1], ["1", '["birthplace"]']]) {
    let calls = 0;
    const state = createRedisState({ ...OPTIONS, fetchImpl: async () => { calls++; return json(result); } });
    await assert.rejects(state.reserveQuestion(reserve()), failure);
    assert.equal(calls, 1);
  }
  for (const result of [null, [1], [1, 0], [1, 2], [1, "1"], [0, 1], [-1]]) {
    const state = createRedisState({ ...OPTIONS, fetchImpl: async () => json(result) });
    await assert.rejects(state.commitQuestion(commit(QUESTION_BANK[1].id)), failure);
  }
});

test("question operations inherit the bounded four-second transport deadline and never retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const method of ["reserveQuestion", "commitQuestion"]) {
    let calls = 0; let signal;
    const state = createRedisState({ ...OPTIONS, fetchImpl: async (_url, request) => {
      calls++; signal = request.signal; return new Promise(() => {});
    } });
    const pending = state[method](method === "reserveQuestion" ? reserve() : commit(QUESTION_BANK[1].id));
    const rejected = assert.rejects(pending, failure);
    await Promise.resolve();
    t.mock.timers.tick(4_000);
    await rejected;
    assert.equal(calls, 1); assert.equal(signal.aborted, true);
  }
});
