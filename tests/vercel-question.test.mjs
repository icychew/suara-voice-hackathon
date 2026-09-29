import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createVercelVoiceHandler, loadVercelVoiceConfig } from '../server/vercel-voice.mjs';
import { fallbackQuestion } from '../src/voice/questionBank.js';

// Explicit synthetic dependencies. No real environment, Redis, credentials,
// provider connection or Vercel platform trust is exercised by these tests.
const ORIGIN = 'https://suara-question-test.vercel.app';
const HOST = 'suara-question-test.vercel.app';
const IP = '203.0.113.91';
const CODE = 'synthetic-question-access-code';
const PROVIDER_KEY = 'synthetic-question-provider-key';
const PROVIDER_TOKEN = 'synthetic-streaming-provider-token';
const ROUTE = '/api/interview/question';
const TRANSCRIPT = 'A synthetic memory about the family home.';
const hash = value => createHash('sha256').update(value).digest('base64url');
const ipDigest = value => createHmac('sha256', CODE).update(value).digest('base64url');
const capDigest = value => createHmac('sha256', CODE).update(`question:${value}`).digest('base64url');
const environment = overrides => ({
  VERCEL: '1', SUARA_ENABLE_VERCEL_VOICE: 'true', SUARA_ENABLE_STREAMING_VOICE: 'true',
  SUARA_ENABLE_AI_QUESTIONS: 'true', SUARA_PUBLIC_ORIGIN: ORIGIN,
  SUARA_JUDGE_ACCESS_CODE: CODE, ASSEMBLYAI_API_KEY: PROVIDER_KEY,
  SUARA_REDIS_PREFIX: 'suara-question-test', UPSTASH_REDIS_REST_URL: 'https://redis-test.invalid',
  UPSTASH_REDIS_REST_TOKEN: 'synthetic-redis-token', ...overrides,
});

class FakeState {
  sessions = new Map();
  capabilities = new Map();
  events = [];
  async admitSession(args) { this.events.push(['admit', args]); return { allowed: true }; }
  async saveSession(args) { this.events.push(['save', args]); this.sessions.set(args.tokenHash, args.ipHash); }
  async consumeSession(args) {
    this.events.push(['consume', args]);
    if (this.sessions.get(args.tokenHash) !== args.ipHash) return { allowed: false, reason: 'unauthorized' };
    this.sessions.delete(args.tokenHash);
    if (args.questionCapabilityHash) this.capabilities.set(args.questionCapabilityHash, {
      ipHash: args.ipHash, sequence: 0, selectedIds: ['birthplace'], pending: null,
    });
    return { allowed: true };
  }
  async reserveQuestion(args) {
    this.events.push(['reserve', args]);
    const cap = this.capabilities.get(args.capabilityHash);
    if (!cap || cap.ipHash !== args.ipHash || cap.sequence !== args.sequence || cap.pending
        || !fallbackQuestion(cap.selectedIds)) return { allowed: false };
    cap.pending = args.operationId;
    return { allowed: true, selectedIds: [...cap.selectedIds] };
  }
  async commitQuestion(args) {
    this.events.push(['commit', args]);
    const cap = this.capabilities.get(args.capabilityHash);
    if (!cap || cap.ipHash !== args.ipHash || cap.sequence !== args.sequence || cap.pending !== args.operationId) {
      return { committed: false };
    }
    cap.selectedIds.push(args.questionId);
    cap.sequence += 1;
    cap.pending = null;
    return { committed: true, nextSequence: cap.sequence };
  }
}

function request(route = ROUTE, options = {}) {
  const headers = new Headers({ host: HOST, 'x-forwarded-proto': 'https', 'x-vercel-forwarded-for': IP });
  if (route !== '/api/session') headers.set('origin', ORIGIN);
  if (route === ROUTE) {
    headers.set('content-type', 'application/json');
    headers.set('x-suara-question-policy', 'bank-v1');
  }
  for (const [key, value] of Object.entries(options.headers || {})) {
    if (value === null) headers.delete(key); else headers.set(key, value);
  }
  const body = Object.hasOwn(options, 'body') ? options.body : route === ROUTE
    ? JSON.stringify({ version: 'bank-v1', sequence: 0, transcript: TRANSCRIPT }) : undefined;
  return new Request(options.url || `${ORIGIN}${route}`, {
    method: options.method || (route === '/api/session' ? 'GET' : 'POST'),
    headers, signal: options.signal, ...(body === undefined ? {} : { body, duplex: 'half' }),
  });
}

function fixture({ state = new FakeState(), env = environment(), fetchImpl, selectQuestion, stateFactory } = {}) {
  const counts = { factory: 0, mint: 0, select: 0 };
  const selections = [];
  const options = {
    env, stateFactory: (...args) => { counts.factory++; return stateFactory ? stateFactory(...args) : state; },
    fetchImpl: async (...args) => {
      counts.mint++;
      return fetchImpl ? fetchImpl(...args) : Response.json({ token: PROVIDER_TOKEN });
    },
    selectQuestion: async args => {
      counts.select++;
      selections.push(args);
      return selectQuestion ? selectQuestion(args) : { questionId: fallbackQuestion(args.selectedIds).id };
    },
  };
  return {
    state, counts, selections, options,
    session: createVercelVoiceHandler({ route: '/api/session', ...options }),
    streaming: createVercelVoiceHandler({ route: '/api/streaming/token', ...options }),
    managed: createVercelVoiceHandler({ route: '/api/voice/token', ...options }),
    question: createVercelVoiceHandler({ route: ROUTE, ...options }),
  };
}

async function bearer(f) {
  const response = await f.session(request('/api/session', { headers: { 'x-suara-access-code': CODE } }));
  assert.equal(response.status, 200);
  return (await response.json()).token;
}
async function mint(f, { optedIn = true, signal } = {}) {
  const token = await bearer(f);
  return f.streaming(request('/api/streaming/token', { signal, headers: {
    authorization: `Bearer ${token}`, ...(optedIn ? { 'x-suara-question-policy': 'bank-v1' } : {}),
  } }));
}
async function capability(f) {
  const response = await mint(f);
  assert.equal(response.status, 200);
  return (await response.json()).question_access.capability;
}
function questionRequest(cap, options = {}) {
  return request(ROUTE, { ...options, headers: { authorization: `Bearer ${cap}`, ...options.headers } });
}
async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error: code });
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
}

test('question grant requires both exact lowercase feature flags before state/provider access', async () => {
  for (const overrides of [
    ...[undefined, '', 'false', 'TRUE', '1', true].map(value => ({ SUARA_ENABLE_AI_QUESTIONS: value })),
    { SUARA_ENABLE_STREAMING_VOICE: 'false' },
  ]) {
    const f = fixture({ env: environment(overrides) });
    assert.equal(loadVercelVoiceConfig(f.options.env).questionsEnabled, false);
    await expectError(await f.streaming(request('/api/streaming/token', {
      headers: { 'x-suara-question-policy': 'bank-v1' },
    })), 503, 'question_not_configured');
    await expectError(await f.question(questionRequest('a'.repeat(43))), 503, 'question_not_configured');
    assert.deepEqual(f.counts, { factory: 0, mint: 0, select: 0 });
  }
});

test('unknown policy or policy on managed/session routes is rejected before any quota', async () => {
  const f = fixture();
  for (const value of ['', 'bank-v2', 'BANK-v1', 'bank-v1, bank-v1']) {
    await expectError(await f.streaming(request('/api/streaming/token', {
      headers: { 'x-suara-question-policy': value },
    })), 400, 'bad_request');
  }
  for (const [route, handle] of [['/api/voice/token', f.managed], ['/api/session', f.session]]) {
    await expectError(await handle(request(route, { headers: { 'x-suara-question-policy': 'bank-v1' } })), 400, 'bad_request');
  }
  await expectError(await f.question(questionRequest('a'.repeat(43), {
    headers: { 'x-suara-question-policy': null },
  })), 400, 'bad_request');
  assert.deepEqual(f.counts, { factory: 0, mint: 0, select: 0 });
});

test('existing plain streaming contract remains unchanged even when AI selection is disabled', async () => {
  const f = fixture({ env: environment({ SUARA_ENABLE_AI_QUESTIONS: 'false' }) });
  const response = await mint(f, { optedIn: false });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    token: PROVIDER_TOKEN, expires_in_seconds: 60, max_session_duration_seconds: 600,
  });
  assert.equal(Object.hasOwn(f.state.events.find(([name]) => name === 'consume')[1], 'questionCapabilityHash'), false);
  assert.equal(f.state.capabilities.size, 0);
});

test('definite streaming mint returns a random capability whose keyed digest alone reaches state', async () => {
  const f = fixture();
  const response = await mint(f);
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload).sort(), ['expires_in_seconds', 'max_session_duration_seconds', 'question_access', 'token']);
  const grant = payload.question_access;
  assert.deepEqual(Object.keys(grant).sort(), ['capability', 'expires_in_seconds', 'max_selections', 'nextSequence', 'policy']);
  assert.match(grant.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual({ ...grant, capability: 'redacted' }, {
    policy: 'bank-v1', capability: 'redacted', nextSequence: 0, expires_in_seconds: 600, max_selections: 8,
  });
  const consume = f.state.events.find(([name]) => name === 'consume')[1];
  assert.equal(consume.questionCapabilityHash, capDigest(grant.capability));
  assert.notEqual(consume.questionCapabilityHash, hash(grant.capability));
  assert.equal(consume.ipHash, ipDigest(IP));
  for (const privateValue of [grant.capability, IP, CODE, PROVIDER_KEY]) {
    assert.equal(JSON.stringify(f.state.events).includes(privateValue), false);
  }
  assert.notEqual(await capability(f), grant.capability);
});

test('provider failure never returns capability and retains the consumed reservation', async () => {
  const f = fixture({ fetchImpl: async () => { throw new Error('synthetic private provider response'); } });
  await expectError(await mint(f), 502, 'voice_token_unavailable');
  assert.equal(f.state.capabilities.size, 1);
  assert.equal(f.state.sessions.size, 0);
  assert.equal(f.counts.mint, 1);
});

test('uncertain capability reservation never mints or retries', async () => {
  const f = fixture();
  const original = f.state.consumeSession.bind(f.state);
  f.state.consumeSession = async args => { await original(args); throw new Error('synthetic lost commit response'); };
  await expectError(await mint(f), 503, 'quota_unavailable');
  assert.equal(f.state.capabilities.size, 1);
  assert.equal(f.counts.mint, 0);
});

test('malformed capability reservation is never mistaken for definite success', async () => {
  for (const result of [null, undefined, { allowed: 1 }, { allowed: 'true' }]) {
    const f = fixture();
    f.state.consumeSession = async () => result;
    await expectError(await mint(f), 503, 'quota_unavailable');
    assert.equal(f.counts.mint, 0);
  }
});

test('question success uses reserved ledger only and commits exact nonce and allowlisted ID', async () => {
  const f = fixture();
  const cap = await capability(f);
  const response = await f.question(questionRequest(cap));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { questionId: 'childhood_home', nextSequence: 1 });
  assert.match(response.headers.get('cache-control'), /no-store/);
  const reserve = f.state.events.find(([name]) => name === 'reserve')[1];
  const commit = f.state.events.find(([name]) => name === 'commit')[1];
  assert.deepEqual(Object.keys(reserve).sort(), ['capabilityHash', 'ipHash', 'operationId', 'sequence']);
  assert.equal(reserve.capabilityHash, capDigest(cap));
  assert.equal(reserve.ipHash, ipDigest(IP));
  assert.match(reserve.operationId, /^[a-f0-9]{32}$/);
  assert.deepEqual(commit, { ...reserve, questionId: 'childhood_home' });
  assert.equal(f.selections[0].transcript, TRANSCRIPT);
  assert.equal(f.selections[0].providerKey, PROVIDER_KEY);
  assert.deepEqual(f.selections[0].selectedIds, ['birthplace']);
  assert.equal(f.selections[0].signal instanceof AbortSignal, true);
  assert.equal(JSON.stringify(f.state.events).includes(TRANSCRIPT), false);
  assert.equal(JSON.stringify(f.state.events).includes(cap), false);
});

test('question endpoint retains exact method, URL, origin, host, HTTPS and platform IP guards', async () => {
  const cases = [
    [{ method: 'GET', body: undefined }, 405, 'method_not_allowed'],
    [{ url: `${ORIGIN}${ROUTE}?model=other` }, 400, 'bad_request'],
    [{ url: `${ORIGIN}/api/interview/other` }, 400, 'bad_request'],
    [{ url: `https://evil.example${ROUTE}` }, 421, 'misdirected_request'],
    [{ headers: { host: null } }, 421, 'misdirected_request'],
    [{ headers: { host: 'evil.example' } }, 421, 'misdirected_request'],
    [{ headers: { 'x-forwarded-proto': 'http' } }, 421, 'misdirected_request'],
    [{ headers: { origin: null } }, 403, 'forbidden'],
    [{ headers: { origin: 'https://evil.example' } }, 403, 'forbidden'],
    [{ headers: { 'sec-fetch-site': 'cross-site' } }, 403, 'forbidden'],
    [{ headers: { 'x-vercel-forwarded-for': null, 'x-real-ip': IP } }, 403, 'forbidden'],
    [{ headers: { 'x-vercel-forwarded-for': `${IP}, 198.51.100.1` } }, 403, 'forbidden'],
  ];
  for (const [options, status, code] of cases) {
    const f = fixture();
    await expectError(await f.question(questionRequest('a'.repeat(43), options)), status, code);
    assert.equal(f.state.events.length, 0);
    assert.equal(f.counts.select, 0);
  }
});

test('only a valid capability bound to the platform IP authorizes selection', async () => {
  const f = fixture();
  for (const authorization of [null, 'Basic invalid', 'Bearer short', `Bearer ${'a'.repeat(44)}`]) {
    await expectError(await f.question(questionRequest('a'.repeat(43), { headers: { authorization } })), 401, 'unauthorized');
  }
  assert.equal(f.state.events.length, 0);
  const sessionToken = await bearer(f);
  await expectError(await f.question(questionRequest(sessionToken)), 401, 'unauthorized');
  const cap = await capability(f);
  await expectError(await f.question(questionRequest(cap, { headers: { 'x-vercel-forwarded-for': '198.51.100.70' } })), 401, 'unauthorized');
  assert.equal(f.counts.select, 0);
});

test('strict JSON media type rejects unsupported encodings and parameters before quota', async () => {
  for (const contentType of [null, 'text/plain', 'text/json', 'application/problem+json',
    'application/json; charset=utf-16', 'application/json; charset=utf-8; extra=true']) {
    const f = fixture();
    await expectError(await f.question(questionRequest('a'.repeat(43), {
      headers: { 'content-type': contentType },
    })), 415, 'unsupported_media_type');
    assert.equal(f.state.events.length, 0);
  }
});

test('exact request shape rejects client prompts/models/IDs, malformed values and duplicate keys before quota', async () => {
  const valid = { version: 'bank-v1', sequence: 0, transcript: TRANSCRIPT };
  const bodies = [null, '', 'not json', '[]', '{}',
    ...[undefined, null, '', ' ', 42, true, {}, [], '\ud800', 'a'.repeat(4001)].map(transcript => JSON.stringify({ ...valid, transcript })),
    ...[-1, 8, 0.5, '0', true, null].map(sequence => JSON.stringify({ ...valid, sequence })),
    JSON.stringify({ ...valid, version: 'bank-v2' }),
    ...['prompt', 'model', 'selectedIds', 'askedIds', 'questionId'].map(key => JSON.stringify({ ...valid, [key]: 'injected' })),
    '{"version":"bank-v1","sequence":0,"transcript":"first","transcript":"last"}',
    '{"version":"bank-v1","sequence":0,"transcript":"first","\\u0074ranscript":"last"}',
    new Uint8Array([0xc3, 0x28]),
  ];
  for (const body of bodies) {
    const f = fixture();
    await expectError(await f.question(questionRequest('a'.repeat(43), { body })), 400, 'bad_request');
    assert.equal(f.state.events.length, 0);
    assert.equal(f.counts.select, 0);
  }
});

test('well-formed 4000-character Chinese and split UTF-8 bodies remain valid', async () => {
  const f = fixture();
  const cap = await capability(f);
  const text = '马'.repeat(4000);
  assert.equal(Buffer.byteLength(text), 12000);
  const bytes = new TextEncoder().encode(JSON.stringify({ transcript: text, sequence: 0, version: 'bank-v1' }));
  let offset = 0;
  const body = new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(offset + 127, bytes.length);
    controller.enqueue(bytes.slice(offset, end)); offset = end;
  } });
  const response = await f.question(questionRequest(cap, {
    body, headers: { 'content-type': 'application/json; charset=UTF-8', 'transfer-encoding': 'chunked' },
  }));
  assert.equal(response.status, 200);
  assert.equal(f.selections[0].transcript, text);
});

test('exactly 16384 streamed request bytes are accepted with actual byte accounting', async () => {
  const f = fixture();
  const cap = await capability(f);
  const value = JSON.stringify({ version: 'bank-v1', sequence: 0, transcript: TRANSCRIPT });
  const body = ' '.repeat(16384 - Buffer.byteLength(value)) + value;
  assert.equal((await f.question(questionRequest(cap, { body, headers: { 'content-length': '16384' } }))).status, 200);
});

test('oversized declared or actual request bytes are cancelled before quota even with lying Content-Length', async () => {
  for (const declared of [undefined, '1', '16385']) {
    let cancelled = false;
    let chunks = 0;
    const body = new ReadableStream({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(5000).fill(32)); },
      cancel() { cancelled = true; },
    });
    const f = fixture();
    await expectError(await f.question(questionRequest('a'.repeat(43), {
      body, headers: declared === undefined ? {} : { 'content-length': declared },
    })), 413, 'request_too_large');
    assert.equal(cancelled, true);
    assert.ok(chunks <= 5);
    assert.equal(f.state.events.length, 0);
  }
});

test('invalid declared lengths and complete body length mismatch fail before quota', async () => {
  for (const declared of ['-1', '1.5', '0001', 'invalid', '0', '1']) {
    const f = fixture();
    await expectError(await f.question(questionRequest('a'.repeat(43), {
      headers: { 'content-length': declared },
    })), 400, 'bad_request');
    assert.equal(f.state.events.length, 0);
  }
});

test('request-body deadline is one second even when an unfinished stream ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered;
  const reading = new Promise(resolve => { entered = resolve; });
  let cancelled = false;
  const body = new ReadableStream({ pull() { entered(); }, cancel() { cancelled = true; return new Promise(() => {}); } });
  const f = fixture();
  const pending = f.question(questionRequest('a'.repeat(43), { body }));
  await reading;
  t.mock.timers.tick(1000);
  await expectError(await pending, 408, 'request_timeout');
  assert.equal(cancelled, true);
  assert.equal(f.state.events.length, 0);
});

test('aborted request-body read returns promptly and never reserves', async () => {
  const controller = new AbortController();
  let entered;
  const reading = new Promise(resolve => { entered = resolve; });
  let cancelled = false;
  const body = new ReadableStream({ pull() { entered(); }, cancel() { cancelled = true; } });
  const f = fixture();
  const pending = f.question(questionRequest('a'.repeat(43), { body, signal: controller.signal }));
  await reading; controller.abort();
  await expectError(await pending, 499, 'request_cancelled');
  assert.equal(cancelled, true);
  assert.equal(f.state.events.length, 0);
});

test('monotonic read deadline also rejects a late body before the timeout callback runs', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 'bank-v1', sequence: 0, transcript: TRANSCRIPT }));
  const body = new ReadableStream({ pull(controller) {
    now = 1001;
    controller.enqueue(bytes);
    controller.close();
  } });
  const f = fixture();
  await expectError(await f.question(questionRequest('a'.repeat(43), { body })), 408, 'request_timeout');
  assert.equal(f.state.events.length, 0);
});

test('uncertain question reserve retains pending lock without selection, retry or unlock', async () => {
  const f = fixture();
  const cap = await capability(f);
  const reserve = f.state.reserveQuestion.bind(f.state);
  f.state.reserveQuestion = async args => { await reserve(args); throw new Error(`${CODE} ${TRANSCRIPT}`); };
  await expectError(await f.question(questionRequest(cap)), 503, 'quota_unavailable');
  assert.equal(f.counts.select, 0);
  assert.ok(f.state.capabilities.get(capDigest(cap)).pending);
  f.state.reserveQuestion = reserve;
  await expectError(await f.question(questionRequest(cap)), 401, 'unauthorized');
  assert.equal(f.counts.select, 0);
});

test('malformed reserved ledger is rejected before selection', async () => {
  for (const grant of [null, { allowed: 1 }, { allowed: true },
    { allowed: true, selectedIds: [] }, { allowed: true, selectedIds: ['proud'] },
    { allowed: true, selectedIds: ['birthplace', 'childhood_home'] }]) {
    const f = fixture();
    const cap = await capability(f);
    f.state.reserveQuestion = async () => grant;
    await expectError(await f.question(questionRequest(cap)), 503, 'quota_unavailable');
    assert.equal(f.counts.select, 0);
  }
});

test('selector failure or unallowlisted/free-form output is never committed or returned', async () => {
  for (const result of [null, 'childhood_home', { questionId: 'birthplace' }, { questionId: 'unknown' },
    { questionId: 'childhood_home', text: 'Injected question' }, new Error(`${PROVIDER_KEY} ${TRANSCRIPT}`)]) {
    const f = fixture({ selectQuestion: async () => { if (result instanceof Error) throw result; return result; } });
    const cap = await capability(f);
    await expectError(await f.question(questionRequest(cap)), 502, 'question_unavailable');
    assert.equal(f.counts.select, 1);
    assert.equal(f.state.events.some(([name]) => name === 'commit'), false);
    await expectError(await f.question(questionRequest(cap)), 401, 'unauthorized');
    assert.equal(f.counts.select, 1);
  }
});

test('commit denial, malformed result and lost commit response fail closed without compensating writes', async () => {
  for (const mode of ['denied', 'malformed', 'uncertain']) {
    const f = fixture();
    const cap = await capability(f);
    const commit = f.state.commitQuestion.bind(f.state);
    f.state.commitQuestion = async args => {
      if (mode === 'denied') return { committed: false };
      if (mode === 'malformed') return { committed: true, nextSequence: 8 };
      await commit(args); throw new Error('synthetic lost commit response');
    };
    await expectError(await f.question(questionRequest(cap)), 503, 'quota_unavailable');
    assert.equal(f.counts.select, 1);
    const state = f.state.capabilities.get(capDigest(cap));
    assert.equal(mode === 'uncertain' ? state.sequence : Boolean(state.pending), mode === 'uncertain' ? 1 : true);
  }
});

test('concurrent same-sequence requests and a later replay cause at most one selection', async () => {
  const f = fixture();
  const cap = await capability(f);
  const responses = await Promise.all([f.question(questionRequest(cap)), f.question(questionRequest(cap))]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 401]);
  assert.equal(f.counts.select, 1);
  await expectError(await f.question(questionRequest(cap)), 401, 'unauthorized');
  assert.equal(f.counts.select, 1);
});

test('pre-abort and cancellation after reserve/select/commit never return a question or unlock', async () => {
  for (const phase of ['before', 'reserve', 'select', 'commit']) {
    const controller = new AbortController();
    const f = fixture({ selectQuestion: async args => {
      if (phase === 'select') controller.abort();
      return { questionId: fallbackQuestion(args.selectedIds).id };
    } });
    const cap = await capability(f);
    if (phase === 'before') controller.abort();
    if (phase === 'reserve' || phase === 'commit') {
      const method = phase === 'reserve' ? 'reserveQuestion' : 'commitQuestion';
      const original = f.state[method].bind(f.state);
      f.state[method] = async args => { const value = await original(args); controller.abort(); return value; };
    }
    await expectError(await f.question(questionRequest(cap, { signal: controller.signal })), 499, 'request_cancelled');
    const state = f.state.capabilities.get(capDigest(cap));
    assert.equal(f.counts.select, phase === 'before' || phase === 'reserve' ? 0 : 1);
    if (phase === 'reserve' || phase === 'select') assert.ok(state.pending);
    if (phase === 'commit') assert.deepEqual(state.selectedIds, ['birthplace', 'childhood_home']);
  }
});

test('actual selector wiring uses only the fixed Gateway endpoint and returns committed ID, not model prose', async () => {
  const f = fixture();
  const cap = await capability(f);
  let providerCalls = 0;
  const handler = createVercelVoiceHandler({ route: ROUTE, env: environment(), stateFactory: () => f.state,
    fetchImpl: async (url, options) => {
      providerCalls++;
      assert.equal(url, 'https://llm-gateway.assemblyai.com/v1/chat/completions');
      assert.equal(options.headers.Authorization, PROVIDER_KEY);
      assert.equal(options.method, 'POST');
      const payload = JSON.parse(options.body);
      assert.equal(payload.stream, false);
      assert.equal(JSON.parse(payload.messages[1].content).transcript, TRANSCRIPT);
      return Response.json({ choices: [{ finish_reason: 'stop', message: {
        role: 'assistant', content: '{"questionId":"childhood_home"}',
      } }] });
    },
  });
  const response = await handler(questionRequest(cap));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { questionId: 'childhood_home', nextSequence: 1 });
  assert.equal(providerCalls, 1);
});
