import { randomBytes } from "node:crypto";
import { QUESTION_BANK, QUESTION_POLICY, OPENING_QUESTION_ID, MAX_INTERVIEW_QUESTIONS,
  eligibleQuestions } from "../src/voice/questionBank.js";

// Upstash REST command-array protocol and EVAL (checked 2026-09-05):
// https://upstash.com/docs/redis/features/restapi
// https://upstash.com/docs/redis/sdks/ts/commands/scripts/eval
// These are server request timestamps, never speech/acoustic measurements.
// Provision initialize() explicitly once; request handlers must never auto-init.
// Keep the prefix unchanged across deployments and use non-evicting durable Redis.
// Total deletion of the namespace/database is indistinguishable from first use;
// recovery therefore needs operator authorization, never automatic initialize().
const FAILURE = "Shared state unavailable.";
const MAX_BODY = 8_192;
const MAX_REQUEST = 65_536;
const DEADLINE_MS = 4_000;
const DAY_MS = 86_400_000;

const HELPERS = `
local function kind(key) return redis.call('TYPE', key).ok end
local function validmeta()
  if kind(KEYS[1]) ~= 'hash' or kind(KEYS[2]) ~= 'string' then return false end
  if redis.call('HGET', KEYS[1], 'schema') ~= '1' or redis.call('HLEN', KEYS[1]) ~= 3 then return false end
  if redis.call('GET', KEYS[2]) ~= '1' then return false end
  if redis.call('PTTL', KEYS[1]) ~= -1 or redis.call('PTTL', KEYS[2]) ~= -1 then return false end
  local clock = tonumber(redis.call('HGET', KEYS[1], 'clock'))
  if not clock or clock < 0 or clock > 9007199254740991 or clock ~= math.floor(clock) then return false end
  local raw = redis.call('HGET', KEYS[1], 'day')
  if not raw or string.len(raw) > 180002 or not string.match(raw, '^%[.*%]$') then return false end
  local ok, day = pcall(cjson.decode, raw)
  if not ok or type(day) ~= 'table' or #day > 10000 then return false end
  local previous = 0
  for index, stamp in ipairs(day) do
    if type(stamp) ~= 'number' or stamp ~= stamp or stamp < previous or stamp > clock or stamp ~= math.floor(stamp) then return false end
    previous = stamp
  end
  for key, _ in pairs(day) do
    if type(key) ~= 'number' or key < 1 or key > #day or key ~= math.floor(key) then return false end
  end
  return true
end
local function tick()
  local time = math.max(tonumber(ARGV[1]), tonumber(redis.call('HGET', KEYS[1], 'clock')))
  redis.call('HSET', KEYS[1], 'clock', string.format('%.0f', time))
  return time
end
local function encodeday(day)
  local values = {}
  for i, stamp in ipairs(day) do values[i] = string.format('%.0f', stamp) end
  return '[' .. table.concat(values, ',') .. ']'
end
local function validset(key)
  local t = kind(key)
  return t == 'none' or t == 'zset'
end
local function waitfor(key, time, window, limit)
  redis.call('ZREMRANGEBYSCORE', key, '-inf', time - window)
  local count = redis.call('ZCARD', key)
  if count < limit then return 0 end
  -- If limits were lowered, enough entries (not just the oldest) must expire.
  local boundary = redis.call('ZRANGE', key, count - limit, count - limit, 'WITHSCORES')
  return math.max(1, math.ceil((tonumber(boundary[2]) + window - time) / 1000))
end
`;

const INITIALIZE = `-- suara-initialize-v1
${HELPERS}
if redis.call('EXISTS', KEYS[1]) == 1 then
  if not validmeta() then return {-1} end
  return {0}
end
-- A guard or residual global quota means this is not a fresh namespace.
if redis.call('EXISTS', KEYS[2], KEYS[3], KEYS[4]) ~= 0 then return {-1} end
redis.call('SET', KEYS[2], '1')
redis.call('HSET', KEYS[1], 'schema', '1', 'clock', ARGV[1], 'day', '[]')
return {1}
`;

const ADMIT = `-- suara-admit-v1
${HELPERS}
if not validmeta() or not validset(KEYS[3]) then return {-1} end
local time = tick()
local retry = waitfor(KEYS[3], time, 60000, tonumber(ARGV[2]))
if retry > 0 then return {0, retry} end
-- Counts every admitted attempt, before checking whether the judge code is valid.
redis.call('ZADD', KEYS[3], time, ARGV[3])
redis.call('PEXPIRE', KEYS[3], math.max(60000, time - tonumber(ARGV[1]) + 60000))
return {1, 0}
`;

const SAVE = `-- suara-save-v1
${HELPERS}
if not validmeta() then return {-1} end
tick()
local saved = redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3], 'NX')
if not saved then return {0} end
return {1}
`;

const CONSUME = `-- suara-consume-v1
${HELPERS}
if not validmeta() then return {-1} end
local tokenkind = kind(KEYS[3])
if tokenkind == 'none' then return {0, 0, 0} end
if tokenkind ~= 'string' then return {-1} end
local ttl = redis.call('PTTL', KEYS[3])
if ttl < 0 or ttl > 120000 then return {-1} end
if redis.call('GET', KEYS[3]) ~= ARGV[2] then return {0, 0, 0} end
-- Validate types before writes: Redis scripts are atomic, not rollback transactions.
for i = 4, 5 do if not validset(KEYS[i]) then return {-1} end end
local time = tick()
local day = cjson.decode(redis.call('HGET', KEYS[1], 'day'))
local kept = {}
for _, stamp in ipairs(day) do
  if stamp > time - 86400000 then kept[#kept + 1] = stamp end
end
local dailyLimit = tonumber(ARGV[5])
local dayRetry = 0
if #kept >= dailyLimit then
  dayRetry = math.max(1, math.ceil((kept[#kept - dailyLimit + 1] + 86400000 - time) / 1000))
end
-- A valid bearer is burned even when quota denies this issuance attempt.
redis.call('DEL', KEYS[3])
local retry = math.max(
  waitfor(KEYS[4], time, 60000, tonumber(ARGV[3])),
  waitfor(KEYS[5], time, 60000, tonumber(ARGV[4])),
  dayRetry)
if retry > 0 then
  redis.call('HSET', KEYS[1], 'day', encodeday(kept))
  return {0, 1, retry}
end
-- Reserve all three quotas together before the caller can contact the provider.
kept[#kept + 1] = time
redis.call('HSET', KEYS[1], 'day', encodeday(kept))
for i = 4, 5 do redis.call('ZADD', KEYS[i], time, ARGV[i + 2]) end
local minuteTtl = math.max(60000, time - tonumber(ARGV[1]) + 60000)
redis.call('PEXPIRE', KEYS[4], minuteTtl)
redis.call('PEXPIRE', KEYS[5], minuteTtl)
-- The required day field never expires and contains numeric timestamps only.
-- Separate random minute members cannot join the IP and global quota keys.
return {1, 0, 0}
`;

function fail() { throw new Error(FAILURE); }
function hash(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) fail();
  return value;
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail();
  return value;
}
function limit(value) { return integer(value, 1, 100_000); }
function tuple(value, length) {
  if (!Array.isArray(value) || value.length !== length || !value.every(Number.isSafeInteger)) fail();
  return value;
}

const QUESTION_CAP_SECONDS = 600;
const QUESTION_ATTEMPTS = 8;
const QUESTION_ID_LIMIT = 64;
const questionIds = QUESTION_BANK.map(question => question.id);
if (QUESTION_POLICY !== "bank-v1" || OPENING_QUESTION_ID !== "birthplace"
    || MAX_INTERVIEW_QUESTIONS !== 8 || questionIds[0] !== OPENING_QUESTION_ID
    || new Set(questionIds).size !== questionIds.length
    || questionIds.some(id => typeof id !== "string" || !/^[a-z0-9_-]{1,64}$/.test(id))
    || QUESTION_BANK.some((question, index) => !Number.isSafeInteger(question.order)
      || question.order <= (QUESTION_BANK[index - 1]?.order ?? 0))) fail();

function operation(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) fail();
  return value;
}
function questionId(value) {
  if (typeof value !== "string" || value.length > QUESTION_ID_LIMIT || !questionIds.includes(value)) fail();
  return value;
}
function selectedHistory(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_INTERVIEW_QUESTIONS
      || value[0] !== OPENING_QUESTION_ID) fail();
  try { eligibleQuestions(value); } catch { fail(); }
  return value;
}

// Derive the optional grant from the unchanged mint-reservation script. This
// keeps its quota/bearer semantics identical without copying the transaction.
// The assertions fail closed if a future refactor removes an insertion point.
function insertScript(source, marker, addition) {
  if (source.indexOf(marker) < 0 || source.indexOf(marker) !== source.lastIndexOf(marker)) fail();
  return source.replace(marker, `${addition}\n${marker}`);
}
const CONSUME_WITH_QUESTIONS = insertScript(insertScript(
  CONSUME.replace("-- suara-consume-v1", "-- suara-consume-questions-v1"),
  "local time = tick()",
  "-- A preexisting capability is not a fresh grant, even if it has expired logically.\nif kind(KEYS[6]) ~= 'none' then return {-1} end"),
  "return {1, 0, 0}",
  `-- Entitlement exists only after the same successful mint reservation.
redis.call('HSET', KEYS[6], 'schema', '1', 'policy', '${QUESTION_POLICY}',
  'ip', ARGV[2], 'expires', string.format('%.0f', time + ${QUESTION_CAP_SECONDS * 1000}),
  'used', '0', 'sequence', '0', 'pending', '', 'selected', '["${OPENING_QUESTION_ID}"]')
redis.call('PEXPIRE', KEYS[6], ${QUESTION_CAP_SECONDS * 1000})`);

const QUESTION_HELPERS = `
${HELPERS}
local questionOrder = {${questionIds.map((id, index) => `["${id}"]=${index + 1}`).join(',')}}
local function whole(raw, minimum, maximum)
  if not raw or not string.match(raw, '^%d+$') or string.len(raw) > 16 then return nil end
  local value = tonumber(raw)
  if not value or value < minimum or value > maximum or value ~= math.floor(value) then return nil end
  return value
end
local function capability()
  local t = kind(KEYS[3])
  if t == 'none' then return 0 end
  if t ~= 'hash' or redis.call('HLEN', KEYS[3]) ~= 8 then return -1 end
  if redis.call('HGET', KEYS[3], 'schema') ~= '1'
    or redis.call('HGET', KEYS[3], 'policy') ~= '${QUESTION_POLICY}' then return -1 end
  local ttl = redis.call('PTTL', KEYS[3])
  if ttl <= 0 or ttl > ${QUESTION_CAP_SECONDS * 1000} then return -1 end
  local identity = redis.call('HGET', KEYS[3], 'ip')
  if not identity or string.len(identity) ~= 43 or not string.match(identity, '^[A-Za-z0-9_-]+$') then return -1 end
  local expires = whole(redis.call('HGET', KEYS[3], 'expires'), 1, 9007199254740991)
  local used = whole(redis.call('HGET', KEYS[3], 'used'), 0, ${QUESTION_ATTEMPTS})
  local sequence = whole(redis.call('HGET', KEYS[3], 'sequence'), 0, ${MAX_INTERVIEW_QUESTIONS - 1})
  local pending = redis.call('HGET', KEYS[3], 'pending')
  if not expires or not used or not sequence or not pending then return -1 end
  if pending ~= '' and (string.len(pending) ~= 32 or not string.match(pending, '^[a-f0-9]+$')) then return -1 end
  if (pending == '' and used ~= sequence) or (pending ~= '' and used ~= sequence + 1) then return -1 end
  local raw = redis.call('HGET', KEYS[3], 'selected')
  if not raw or string.len(raw) > 1024 or not string.match(raw, '^%[.*%]$') then return -1 end
  local ok, selected = pcall(cjson.decode, raw)
  if not ok or type(selected) ~= 'table' or #selected < 1 or #selected > ${MAX_INTERVIEW_QUESTIONS}
    or selected[1] ~= '${OPENING_QUESTION_ID}' or #selected ~= sequence + 1 then return -1 end
  local previous = 0
  for _, id in ipairs(selected) do
    if type(id) ~= 'string' or not questionOrder[id] or questionOrder[id] <= previous then return -1 end
    previous = questionOrder[id]
  end
  for key, _ in pairs(selected) do
    if type(key) ~= 'number' or key < 1 or key > #selected or key ~= math.floor(key) then return -1 end
  end
  local time = math.max(tonumber(ARGV[1]), tonumber(redis.call('HGET', KEYS[1], 'clock')))
  if expires <= time or identity ~= ARGV[2] then return 0 end
  if expires > time + ${QUESTION_CAP_SECONDS * 1000} then return -1 end
  return 1, selected, used, sequence, pending, previous
end
`;

const RESERVE_QUESTION = `-- suara-question-reserve-v1
${QUESTION_HELPERS}
if not validmeta() then return {-1} end
local valid, selected, used, sequence, pending, previous = capability()
if valid ~= 1 then return {valid} end
if sequence ~= tonumber(ARGV[3]) or pending ~= '' or used >= ${QUESTION_ATTEMPTS}
  or #selected >= ${MAX_INTERVIEW_QUESTIONS} or previous >= ${questionIds.length} then return {0} end
for i = 4, 5 do if not validset(KEYS[i]) then return {-1} end end
local time = tick()
local retry = math.max(waitfor(KEYS[4], time, 60000, 8), waitfor(KEYS[5], time, 60000, 24))
if retry > 0 then return {0} end
-- A single pending operation owns this sequence. No timeout clears this state.
redis.call('HSET', KEYS[3], 'used', tostring(used + 1), 'pending', ARGV[4])
for i = 4, 5 do redis.call('ZADD', KEYS[i], time, ARGV[i + 1]) end
local minuteTtl = math.max(60000, time - tonumber(ARGV[1]) + 60000)
redis.call('PEXPIRE', KEYS[4], minuteTtl)
redis.call('PEXPIRE', KEYS[5], minuteTtl)
-- Never refresh capability expiry. Only IDs, counters and operation metadata persist.
return {1, cjson.encode(selected)}
`;

const COMMIT_QUESTION = `-- suara-question-commit-v1
${QUESTION_HELPERS}
if not validmeta() then return {-1} end
local valid, selected, used, sequence, pending, previous = capability()
if valid ~= 1 then return {valid} end
if sequence ~= tonumber(ARGV[3]) or pending == '' or pending ~= ARGV[4]
  or not questionOrder[ARGV[5]] or questionOrder[ARGV[5]] <= previous
  or #selected >= ${MAX_INTERVIEW_QUESTIONS} then return {0} end
tick()
selected[#selected + 1] = ARGV[5]
redis.call('HSET', KEYS[3], 'selected', cjson.encode(selected),
  'sequence', tostring(sequence + 1), 'pending', '')
-- selected IDs are not evidence that speech playback started or was heard.
return {1, sequence + 1}
`;

/** Shared, content-free state; throws only sanitized errors, never retries writes. */
export function createRedisState({ url, token, prefix, fetchImpl = fetch, now = Date.now } = {}) {
  let endpoint;
  try { endpoint = new URL(url); } catch { fail(); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search ||
      endpoint.hash || endpoint.pathname !== "/" || endpoint.port ||
      !/^[a-z0-9-]+\.upstash\.io$/.test(endpoint.hostname) ||
      typeof token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(token) ||
      typeof prefix !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(prefix) ||
      typeof fetchImpl !== "function" || typeof now !== "function") fail();
  const base = `{${prefix}}:suara:`;
  const meta = `${base}meta`;
  const guard = `${base}initialized`;
  const globalMinute = `${base}minute`;
  const globalDay = `${base}day`;

  async function evaluate(script, keys, args) {
    let controller;
    let timer;
    let reader;
    try {
      const timestamp = integer(now(), 0, Number.MAX_SAFE_INTEGER - DAY_MS);
      const body = JSON.stringify(["EVAL", script, keys.length, ...keys, String(timestamp), ...args.map(String)]);
      if (Buffer.byteLength(body) > MAX_REQUEST) fail();
      controller = new AbortController();
      // Race covers fetch AND stream reads, even an injected fetch ignoring abort.
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error(FAILURE)); }, DEADLINE_MS);
      });
      const work = (async () => {
        const response = await fetchImpl(endpoint.origin, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
          body, redirect: "error", cache: "no-store", signal: controller.signal,
        });
        if (controller.signal.aborted || response.status !== 200 || !response.body?.getReader) fail();
        const declared = response.headers.get("content-length");
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) fail();
        reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (controller.signal.aborted) fail();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BODY) fail();
          chunks.push(Buffer.from(chunk.value));
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
            Object.keys(payload).length !== 1 || !Object.hasOwn(payload, "result")) fail();
        return payload.result;
      })();
      return await Promise.race([work, timeout]);
    } catch { fail(); }
    finally {
      clearTimeout(timer);
      controller?.abort();
      // Do not let a malicious/hung cancellation promise delay this deadline.
      try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch { /* sanitized */ }
    }
  }

  return Object.freeze({
    async initialize() {
      const result = tuple(await evaluate(INITIALIZE, [meta, guard, globalMinute, globalDay], []), 1);
      if (![0, 1].includes(result[0])) fail();
      return { initialized: result[0] === 1 };
    },
    async admitSession({ ipHash, limit: sessionLimit } = {}) {
      const result = tuple(await evaluate(ADMIT, [meta, guard, `${base}admit:${hash(ipHash)}`],
        [limit(sessionLimit), randomBytes(16).toString("hex")]), 2);
      if (result[0] === 1 && result[1] === 0) return { allowed: true, retryAfter: 0 };
      if (result[0] === 0 && result[1] >= 1 && result[1] <= 60) return { allowed: false, retryAfter: result[1] };
      fail();
    },
    async saveSession({ tokenHash, ipHash, ttlSeconds } = {}) {
      const result = tuple(await evaluate(SAVE, [meta, guard, `${base}session:${hash(tokenHash)}`],
        [hash(ipHash), integer(ttlSeconds, 1, 120)]), 1);
      if (result[0] !== 1) fail();
      return { saved: true };
    },
    async consumeSession({ tokenHash, ipHash, tokenLimit, globalLimit, dailyLimit, questionCapabilityHash } = {}) {
      const identity = hash(ipHash);
      const grantQuestionCapability = questionCapabilityHash !== undefined;
      const keys = [meta, guard, `${base}session:${hash(tokenHash)}`, `${base}tokens:${identity}`, globalMinute];
      if (grantQuestionCapability) keys.push(`${base}question:${hash(questionCapabilityHash)}`);
      const result = tuple(await evaluate(grantQuestionCapability ? CONSUME_WITH_QUESTIONS : CONSUME, keys,
        [identity, limit(tokenLimit), limit(globalLimit), integer(dailyLimit, 1, 10_000),
          ...Array.from({ length: 2 }, () => randomBytes(16).toString("hex"))]), 3);
      if (result[0] === 1 && result[1] === 0 && result[2] === 0) return { allowed: true };
      if (result[0] === 0 && result[1] === 0 && result[2] === 0) return { allowed: false, reason: "unauthorized", retryAfter: 0 };
      if (result[0] === 0 && result[1] === 1 && result[2] >= 1 && result[2] <= 86_400) {
        return { allowed: false, reason: "rate_limited", retryAfter: result[2] };
      }
      fail();
    },
    async reserveQuestion({ capabilityHash, ipHash, sequence, operationId } = {}) {
      const identity = hash(ipHash);
      const result = await evaluate(RESERVE_QUESTION,
        [meta, guard, `${base}question:${hash(capabilityHash)}`, `${base}question-minute:${identity}`, `${base}question-minute`],
        [identity, integer(sequence, 0, MAX_INTERVIEW_QUESTIONS - 1), operation(operationId),
          ...Array.from({ length: 2 }, () => randomBytes(16).toString("hex"))]);
      if (Array.isArray(result) && result.length === 1 && result[0] === 0) return { allowed: false };
      if (!Array.isArray(result) || result.length !== 2 || result[0] !== 1
          || typeof result[1] !== "string" || result[1].length > 1024) fail();
      let selectedIds;
      try { selectedIds = selectedHistory(JSON.parse(result[1])); } catch { fail(); }
      if (selectedIds.length !== sequence + 1 || eligibleQuestions(selectedIds).length === 0) fail();
      return { allowed: true, selectedIds };
    },
    async commitQuestion({ capabilityHash, ipHash, sequence, operationId, questionId: selectedId } = {}) {
      const result = await evaluate(COMMIT_QUESTION,
        [meta, guard, `${base}question:${hash(capabilityHash)}`],
        [hash(ipHash), integer(sequence, 0, MAX_INTERVIEW_QUESTIONS - 1), operation(operationId), questionId(selectedId)]);
      if (Array.isArray(result) && result.length === 1 && result[0] === 0) return { committed: false };
      if (!Array.isArray(result) || result.length !== 2 || result[0] !== 1
          || result[1] !== sequence + 1 || result[1] >= MAX_INTERVIEW_QUESTIONS) fail();
      return { committed: true, nextSequence: result[1] };
    },
  });
}
