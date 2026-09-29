import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SESSION_PROMPT, SESSION_QUESTIONS } from '../src/voice/copy.js';

// Import the actual clients. Replace only Vite asset loading/import resolution,
// never the lifecycle/controller implementation being tested.
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const baseSource = (await readFile(new URL('../src/voice/voiceClient.js', import.meta.url), 'utf8'))
  .replace('import { SESSION_PROMPT, SESSION_QUESTIONS } from "./copy.js";',
    `const SESSION_PROMPT = ${JSON.stringify(SESSION_PROMPT)}; const SESSION_QUESTIONS = ${JSON.stringify(SESSION_QUESTIONS)};`)
  .replace('import processorUrl from "./pcm-processor.js?url&no-inline";',
    'const processorUrl = "/assets/suara-pcm-processor.js";');
const streamingSource = (await readFile(new URL('../src/voice/streamingClient.js', import.meta.url), 'utf8'))
  .replace('"./voiceClient.js"', JSON.stringify(dataUrl(baseSource)))
  .replace('"./copy.js"', JSON.stringify(new URL('../src/voice/copy.js', import.meta.url).href))
  .replace('"./patienceController.js"', JSON.stringify(new URL('../src/voice/patienceController.js', import.meta.url).href))
  .replace('"./questionBank.js"', JSON.stringify(new URL('../src/voice/questionBank.js', import.meta.url).href))
  .replace('"./questionClient.js"', JSON.stringify(new URL('../src/voice/questionClient.js', import.meta.url).href))
  .replace('"./capabilities.js"', JSON.stringify(new URL('../src/voice/capabilities.js', import.meta.url).href));
const { SuaraStreamingClient, buildStreamingUrl, chooseLocalEnglishVoice, waitForLocalVoice } = await import(dataUrl(streamingSource));
const CONFIG = { model: 'universal-3-5-pro', mode: 'max_accuracy' };
const LOCAL = { name: 'Synthetic local fixture voice', localService: true, lang: 'en-MY', default: true };

class FakeNode {
  listeners = new Map();
  connections = [];
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, payload = {}) { for (const listener of [...(this.listeners.get(type) || [])]) listener(payload); }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnected = true; }
}
class FakeWorklet extends FakeNode {
  static instances = [];
  constructor(context, name, options) {
    super(); Object.assign(this, { context, name, options, port: { onmessage: null } });
    FakeWorklet.instances.push(this);
  }
}
class FakeContext extends FakeNode {
  static instances = [];
  constructor() {
    super();
    this.sampleRate = 48000; this.currentTime = 0; this.state = 'suspended';
    this.destination = new FakeNode();
    this.audioWorklet = { addModule: async (url) => { this.module = url; } };
    FakeContext.instances.push(this);
  }
  async resume() { this.state = 'running'; }
  createMediaStreamSource() { return new FakeNode(); }
  createGain() { const node = new FakeNode(); node.gain = { value: 1 }; return node; }
  async close() { this.state = 'closed'; }
}
class FakeSocket extends FakeNode {
  static instances = [];
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) {
    super(); this.url = String(url); this.readyState = 0; this.sent = []; this.bufferedAmount = 0;
    FakeSocket.instances.push(this);
  }
  open() { this.readyState = 1; this.dispatch('open'); }
  message(message) { this.dispatch('message', { data: JSON.stringify(message) }); }
  send(payload) {
    if (this.throwOnSend) throw new Error('PRIVATE transport details');
    if (this.readyState !== 1) throw new Error('Socket is not open');
    this.sent.push(typeof payload === 'string' ? JSON.parse(payload) : payload);
  }
  close() { this.readyState = 3; }
}
class FakeSynth extends FakeNode {
  constructor(voices) { super(); this.voices = voices; this.spoken = []; this.speaking = false; this.pending = false; this.cancels = 0; }
  getVoices() { return this.voices; }
  speak(utterance) {
    if (this.throwOnSpeak) throw new Error('PRIVATE voice error');
    this.spoken.push(utterance); this.pending = true;
  }
  cancel() {
    this.cancels += 1;
    if (this.throwOnCancel) throw new Error('PRIVATE cancel error');
    this.pending = false; this.speaking = false;
  }
  start(utterance = this.spoken.at(-1)) { this.pending = false; this.speaking = true; utterance.onstart?.(); }
  end(utterance = this.spoken.at(-1)) { this.pending = false; this.speaking = false; utterance.onend?.(); }
}

function harness(options = {}) {
  const originals = new Map();
  const timers = [];
  const calls = [];
  const track = new FakeNode();
  track.stop = () => { track.stopped = true; };
  const stream = { getTracks: () => [track] };
  const synth = new FakeSynth(options.voices ?? [LOCAL]);
  let micCalls = 0;
  function replace(name, value) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const setTimeout = (callback, milliseconds) => {
    const timer = { callback, milliseconds, cleared: false }; timers.push(timer); return timer;
  };
  const clearTimeout = (timer) => { if (timer) timer.cleared = true; };
  FakeContext.instances = []; FakeSocket.instances = []; FakeWorklet.instances = [];
  replace('setTimeout', setTimeout); replace('clearTimeout', clearTimeout);
  replace('window', { AudioContext: FakeContext, speechSynthesis: synth,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }, setTimeout, clearTimeout });
  replace('navigator', { mediaDevices: { getUserMedia: async (constraints) => {
    micCalls += 1; stream.constraints = constraints;
    return options.getUserMedia ? options.getUserMedia(stream) : stream;
  } } });
  replace('AudioWorkletNode', FakeWorklet); replace('WebSocket', FakeSocket);
  replace('fetch', async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/capabilities') return options.capabilityFetch ? options.capabilityFetch(url, init) : Response.json({
      schemaVersion: 'suara.voice_capabilities/1', streaming: true, aiQuestions: true,
    });
    if (options.fetch) return options.fetch(url, init);
    return { ok: true, json: async () => ({ token: url === '/api/session' ? 'synthetic-local-bearer' : 'synthetic-provider-token' }) };
  });
  return { timers, calls, track, stream, synth, get micCalls() { return micCalls; },
    restore() {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
      }
    } };
}
async function until(predicate) {
  for (let i = 0; i < 100; i += 1) { if (predicate()) return; await new Promise(setImmediate); }
  assert.fail('Synthetic browser condition did not occur.');
}
async function opening(t, options = {}, clientOptions = {}) {
  const h = harness(options);
  const events = [];
  let now = 1000;
  const client = new SuaraStreamingClient({ accessCode: 'synthetic-access-code', now: () => now,
    ...clientOptions, onEvent: (event) => { events.push(event); clientOptions.onEvent?.(event, client); } });
  t.after(() => { try { client.dispose(); } finally { h.restore(); } });
  const started = client.start();
  const capturedStart = started.then(() => null, (error) => error);
  await until(() => FakeSocket.instances.length === 1);
  const socket = FakeSocket.instances[0];
  socket.open();
  return { h, events, client, socket, started, capturedStart, tick: (ms = 500) => { now += ms; } };
}
async function connected(t, options = {}, clientOptions = {}) {
  const result = await opening(t, options, clientOptions);
  result.socket.message({ type: 'Begin', configuration: CONFIG });
  await result.started;
  return result;
}
function final(order, transcript = 'My childhood was in Penang.') {
  return { type: 'Turn', turn_order: order, transcript, end_of_turn: true,
    turn_is_formatted: true, words: [{ start: 0, end: 100 }] };
}
function partial(order, transcript = 'and then ah') {
  return { type: 'Turn', turn_order: order, transcript, end_of_turn: false };
}

test('streaming URL is pinned to explicit provider, model, language and PCM configuration', () => {
  const url = buildStreamingUrl('synthetic-token-value');
  assert.equal(url.origin, 'wss://streaming.assemblyai.com');
  assert.equal(url.pathname, '/v3/ws');
  for (const [key, value] of Object.entries({ sample_rate: '16000', encoding: 'pcm_s16le',
    speech_model: 'universal-3-5-pro', mode: 'max_accuracy', min_turn_silence: '1200', max_turn_silence: '6000',
    continuous_partials: 'true', include_partial_turns: 'true' })) assert.equal(url.searchParams.get(key), value);
  assert.deepEqual(JSON.parse(url.searchParams.get('language_codes')), ['en', 'zh']);
  for (const token of ['', 1, true, null, 'a'.repeat(4097)]) assert.throws(() => buildStreamingUrl(token), { kind: 'token' });
});

test('host-disabled and uncertain optional modes fail before microphone, session bearer or provider token work', async (t) => {
  const cases = [
    ['Streaming disabled', false, Response.json({ schemaVersion: 'suara.voice_capabilities/1', streaming: false, aiQuestions: false }), 'streamingUnavailable'],
    ['AI bank disabled', true, Response.json({ schemaVersion: 'suara.voice_capabilities/1', streaming: true, aiQuestions: false }), 'questionsUnavailable'],
    ['Malformed flags', false, Response.json({ schemaVersion: 'suara.voice_capabilities/1', streaming: 'true', aiQuestions: false }), 'capabilities'],
    ['Host unavailable', false, Response.json({ error: 'PRIVATE' }, { status: 503 }), 'capabilities'],
    ['Wrong code', false, Response.json({ error: 'PRIVATE' }, { status: 401 }), 'access'],
  ];
  for (const [name, personalised, response, kind] of cases) await t.test(name, async subtest => {
    const h = harness({ capabilityFetch: async () => response });
    const client = new SuaraStreamingClient({ accessCode: 'synthetic-access-code', personalised });
    subtest.after(() => { client.dispose(); h.restore(); });
    await assert.rejects(client.start(), { kind });
    assert.deepEqual(h.calls.map(call => call.url), ['/api/capabilities']);
    assert.equal(h.micCalls, 0); assert.equal(FakeContext.instances.length, 0); assert.equal(FakeSocket.instances.length, 0);
    assert.equal(h.synth.spoken.length, 0);
  });
});

test('a stalled capability check times out before capture and late success cannot restart it', async t => {
  let resolveFetch;
  const h = harness({ capabilityFetch: () => new Promise(resolve => { resolveFetch = resolve; }) });
  const client = new SuaraStreamingClient({ accessCode: 'synthetic-access-code' });
  t.after(() => { client.dispose(); h.restore(); });
  const rejected = assert.rejects(client.start(), { kind: 'capabilities' });
  await until(() => Boolean(resolveFetch));
  h.timers.find(timer => timer.milliseconds === 5000 && !timer.cleared).callback();
  await rejected;
  resolveFetch(Response.json({ schemaVersion: 'suara.voice_capabilities/1', streaming: true, aiQuestions: true }));
  await new Promise(setImmediate);
  assert.equal(h.micCalls, 0); assert.equal(FakeSocket.instances.length, 0);
  assert.deepEqual(h.calls.map(call => call.url), ['/api/capabilities']);
});

test('voice selection never picks remote/default or wrong-language voices', () => {
  const remote = { lang: 'en-US', localService: false, default: true };
  const mandarin = { lang: 'zh-CN', localService: true, default: true };
  assert.equal(chooseLocalEnglishVoice([remote, mandarin]), null);
  assert.equal(chooseLocalEnglishVoice([remote, LOCAL, mandarin]), LOCAL);
  assert.equal(chooseLocalEnglishVoice(null), null);
});

test('full synthetic lifecycle authenticates, sends 800-frame PCM, queues control, speaks locally and drains final on termination', async (t) => {
  const { h, client, socket, started, events } = await opening(t);
  assert.deepEqual(h.calls.map((call) => call.url), ['/api/capabilities', '/api/session', '/api/streaming/token']);
  assert.equal(h.calls[0].init.headers['X-Suara-Access-Code'], 'synthetic-access-code');
  assert.equal(h.calls[2].init.headers.Authorization, 'Bearer synthetic-local-bearer');
  assert.equal(Object.hasOwn(h.calls[2].init, 'body'), false);
  for (const { init } of h.calls) { assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'same-origin'); }
  assert.equal(client.accessCode, '');
  assert.equal(socket.url.includes('synthetic-access-code'), false);
  assert.equal(socket.url.includes('synthetic-local-bearer'), false);
  const worklet = FakeWorklet.instances[0];
  assert.deepEqual(worklet.options.processorOptions, { inputSampleRate: 48000, targetSampleRate: 16000, frameSamples: 800 });
  const capture = worklet.port.onmessage;
  capture({ data: new ArrayBuffer(1600) });
  assert.equal(socket.sent.length, 0, 'no PCM before Begin');
  socket.message({ type: 'Begin', configuration: CONFIG });
  await started;
  assert.equal(h.synth.spoken.length, 1);
  assert.equal(h.synth.spoken[0].voice, LOCAL);
  h.synth.start(); h.synth.end();
  const frame = new ArrayBuffer(1600);
  capture({ data: frame });
  assert.equal(socket.sent.at(-1), frame);
  assert.equal(client.inputFramesQueued, 800);
  socket.message(partial(0));
  assert.deepEqual(socket.sent.at(-1), { type: 'UpdateConfiguration', min_turn_silence: 1800, max_turn_silence: 9000 });
  socket.message(final(0));
  await Promise.resolve();
  assert.equal(h.synth.spoken.length, 2);
  assert.equal(events.filter((event) => event.type === 'user-transcript').length, 1);
  assert.equal(client.updatesQueued, 2);
  const control = events.filter((event) => event.type === 'streaming-control').at(-1);
  assert.equal(control.applicationStatus, 'unconfirmed');
  assert.equal(control.profile.confident, false);
  assert.equal(control.initialThresholdsVerified, false);
  await client.end();
  assert.equal(h.track.stopped, true);
  assert.deepEqual(socket.sent.at(-1), { type: 'Terminate' });
  const before = socket.sent.length;
  capture({ data: frame });
  socket.message(final(1, 'A final memory during drain.'));
  socket.message(partial(2));
  assert.equal(events.filter((event) => event.type === 'user-transcript').length, 2);
  assert.equal(socket.sent.length, before);
  socket.message({ type: 'Termination' });
  assert.equal(client.providerEnded, true);
  assert.equal(client.isCleanedUp, true);
  assert.equal(FakeContext.instances[0].state, 'closed');
  const count = events.length;
  socket.message(final(2)); capture({ data: frame });
  assert.equal(events.length, count);
});

test('duplicate and stale turns cannot duplicate transcripts, questions or gap samples', async (t) => {
  const { socket, h, client, events } = await connected(t);
  socket.message(final(2)); await Promise.resolve();
  const spoken = h.synth.spoken.length;
  socket.message(final(2)); socket.message(final(1)); socket.message(partial(1));
  await Promise.resolve();
  assert.equal(h.synth.spoken.length, spoken);
  assert.equal(client.patience.snapshot().profile.turnsSeen, 1);
  assert.equal(events.filter((event) => event.type === 'user-transcript').length, 1);
  socket.message({ ...final(3), turn_is_formatted: false });
  assert.equal(events.filter((event) => event.type === 'user-transcript').length, 1);
  socket.message(final(3)); await Promise.resolve();
  assert.equal(events.filter((event) => event.type === 'user-transcript').length, 2);
});

test('three completed answers produce closing speech and Terminate only after local output ends', async (t) => {
  const { socket, h, client } = await connected(t);
  h.synth.start(); h.synth.end();
  for (let order = 0; order < 3; order += 1) {
    socket.message(final(order)); await Promise.resolve();
    assert.equal(client.isEnding, false);
    h.synth.start(); h.synth.end();
  }
  assert.equal(h.synth.spoken.length, 4);
  assert.equal(client.isEnding, true);
  assert.deepEqual(socket.sent.at(-1), { type: 'Terminate' });
});

test('stop before Begin prevents queued greeting, microphone sends and duplicate readiness', async (t) => {
  const { client, h, socket, started, events } = await opening(t);
  const capture = FakeWorklet.instances[0].port.onmessage;
  await client.end();
  socket.message({ type: 'Begin', configuration: CONFIG });
  capture({ data: new ArrayBuffer(1600) });
  await started;
  assert.equal(h.synth.spoken.length, 0);
  assert.equal(events.some((event) => event.type === 'ready'), false);
  assert.equal(socket.sent.some((payload) => payload instanceof ArrayBuffer), false);
});

test('stop while local voices load performs no capture or token request', async (t) => {
  const h = harness({ voices: [] });
  const client = new SuaraStreamingClient();
  t.after(() => { client.dispose(); h.restore(); });
  const started = client.start();
  await client.end();
  h.synth.voices = [LOCAL]; h.synth.dispatch('voiceschanged');
  await started;
  assert.equal(h.micCalls, 0); assert.equal(h.calls.length, 0);
  assert.equal(FakeContext.instances.length, 0);
  assert.equal(h.synth.listeners.get('voiceschanged').size, 0);
});

test('remote-only voice availability times out before capture, credentials or token work', async (t) => {
  const h = harness({ voices: [{ ...LOCAL, localService: false }] });
  const client = new SuaraStreamingClient();
  t.after(() => { client.dispose(); h.restore(); });
  const rejected = assert.rejects(client.start(), { kind: 'speech' });
  h.timers.find((timer) => timer.milliseconds === 2000).callback();
  await rejected;
  assert.equal(h.micCalls, 0); assert.equal(h.calls.length, 0);
  assert.equal(FakeContext.instances.length, 0);
});

test('voice loading resolves only explicit local English and removes listeners', async (t) => {
  const h = harness({ voices: [] }); t.after(() => h.restore());
  const controller = new AbortController();
  const pending = waitForLocalVoice(h.synth, controller.signal);
  h.synth.voices = [{ ...LOCAL, localService: false }]; h.synth.dispatch('voiceschanged');
  h.synth.voices = [LOCAL]; h.synth.dispatch('voiceschanged');
  assert.equal(await pending, LOCAL);
  assert.equal(h.synth.listeners.get('voiceschanged').size, 0);
  assert.equal(h.timers[0].cleared, true);
});

test('queued local output is cancelled by speech, stop or reset before its microtask', async (t) => {
  for (const operation of ['speech', 'stop', 'reset']) await t.test(operation, async (subtest) => {
    const { client, socket, h } = await connected(subtest);
    const spoken = h.synth.spoken.length;
    socket.message(final(0));
    if (operation === 'speech') socket.message({ type: 'SpeechStarted' });
    else if (operation === 'stop') await client.end();
    else client.dispose();
    await Promise.resolve();
    assert.equal(h.synth.spoken.length, spoken);
  });
});

test('saved speech callbacks are inert after reset and never revive output', async (t) => {
  const { client, h, events } = await connected(t);
  const utterance = h.synth.spoken.at(-1);
  const callbacks = [utterance.onstart, utterance.onend, utterance.onerror];
  client.dispose(); const count = events.length;
  for (const callback of callbacks) callback();
  assert.equal(events.length, count);
  assert.equal(h.synth.spoken.length, 1);
});

for (const config of [{}, { ...CONFIG, model: 'other' }, { ...CONFIG, mode: 'balanced' },
  { ...CONFIG, min_turn_silence: 1 }, { ...CONFIG, max_turn_silence: '6000' }]) {
  test(`invalid Begin configuration fails startup and releases resources: ${JSON.stringify(config)}`, async (t) => {
    const { socket, client, capturedStart, h } = await opening(t);
    socket.message({ type: 'Begin', configuration: config });
    assert.equal((await capturedStart).kind, 'configuration');
    assert.equal(h.track.stopped, true); assert.equal(client.isCleanedUp, true);
    assert.equal(h.synth.spoken.length, 0);
  });
}

test('Termination before Begin is a startup failure, not a successful conversation', async (t) => {
  const { socket, capturedStart, h } = await opening(t);
  socket.message({ type: 'Termination' });
  assert.equal((await capturedStart)?.kind, 'connection');
  assert.equal(h.synth.spoken.length, 0);
  assert.equal(h.track.stopped, true);
});

test('a synchronous reset from ready produces no later event or greeting', async (t) => {
  let boundary;
  const { socket, events, h, started } = await opening(t, {}, { onEvent(event, client) {
    if (event.type === 'ready') { client.dispose(); boundary = true; }
    else if (boundary) assert.fail(`Unexpected post-reset event: ${event.type}`);
  } });
  socket.message({ type: 'Begin', configuration: CONFIG }); await started;
  assert.equal(events.at(-1).type, 'ready');
  assert.equal(h.synth.spoken.length, 0);
});

for (const frame of [new ArrayBuffer(0), new ArrayBuffer(1598), new ArrayBuffer(1602), new Uint8Array(1600), null]) {
  test(`invalid PCM frame fails closed (${frame?.byteLength ?? 'null'} bytes)`, async (t) => {
    const { client, h, socket, events } = await connected(t);
    FakeWorklet.instances[0].port.onmessage({ data: frame });
    assert.equal(client.isCleanedUp, true); assert.equal(h.track.stopped, true);
    assert.equal(socket.sent.some((payload) => payload instanceof ArrayBuffer), false);
    assert.deepEqual(events.at(-1), { type: 'error', kind: 'connection' });
  });
}

for (const operation of ['capture', 'control', 'speech-context']) {
  test(`streaming backlog rejects ${operation} without silent loss or burst replay`, async (t) => {
    const { client, h, socket } = await connected(t);
    const before = socket.sent.length;
    socket.bufferedAmount = 16001;
    if (operation === 'capture') FakeWorklet.instances[0].port.onmessage({ data: new ArrayBuffer(1600) });
    else if (operation === 'control') socket.message(partial(0));
    else { socket.message(final(0)); await Promise.resolve(); }
    assert.equal(client.isCleanedUp, true); assert.equal(h.track.stopped, true);
    assert.deepEqual(socket.sent.slice(before), [{ type: 'Terminate' }]);
  });
}

test('provider errors and malformed messages are sanitized and release all resources', async (t) => {
  for (const payload of [{ type: 'Error', error: 'PRIVATE raw provider error' }, null, 123, 'invalid-json', 'a'.repeat(256001)]) {
    await t.test(typeof payload === 'string' ? `raw-${payload.length}` : JSON.stringify(payload), async (subtest) => {
      const { client, h, socket, events } = await connected(subtest);
      if (typeof payload === 'string') socket.dispatch('message', { data: payload }); else socket.message(payload);
      assert.equal(client.isCleanedUp, true); assert.equal(h.track.stopped, true);
      assert.deepEqual(events.at(-1), { type: 'error', kind: 'connection' });
      assert.equal(JSON.stringify(events).includes('PRIVATE raw provider error'), false);
    });
  }
});

test('invalid final word timestamps fail without storing a transcript', async (t) => {
  const { socket, client, events } = await connected(t);
  socket.message({ ...final(0), words: [{ start: 20, end: 10 }] });
  assert.equal(client.isCleanedUp, true);
  assert.equal(events.some((event) => event.type === 'user-transcript'), false);
});

test('local TTS never receives a user transcript and outgoing context is question-bank-only', async (t) => {
  const { socket, h, events } = await connected(t);
  socket.message(final(0, 'PRIVATE_NARRATOR_STORY')); await Promise.resolve();
  assert.equal(h.synth.spoken.some((utterance) => utterance.text.includes('PRIVATE_NARRATOR_STORY')), false);
  assert.equal(JSON.stringify(socket.sent).includes('PRIVATE_NARRATOR_STORY'), false);
  assert.equal(JSON.stringify(events.filter((event) => event.type === 'streaming-control')).includes('PRIVATE_NARRATOR_STORY'), false);
  assert.equal(events.find((event) => event.type === 'user-transcript').text, 'PRIVATE_NARRATOR_STORY');
});

test('local speech timeout fails visibly and cancels output', async (t) => {
  const { client, h, events } = await connected(t);
  h.timers.find((timer) => timer.milliseconds === 5000 && !timer.cleared).callback();
  assert.equal(client.isCleanedUp, true); assert.equal(h.track.stopped, true);
  assert.deepEqual(events.at(-1), { type: 'error', kind: 'speech' });
});

test('Streaming capture-source mute cancels local speech and terminates without revival', async t => {
  const { client, h, socket, events } = await connected(t);
  h.synth.start();
  h.track.muted = true;
  h.track.dispatch('mute');
  assert.equal(client.isCleanedUp, true);
  assert.equal(h.track.stopped, true);
  assert.equal(h.synth.cancels, 1);
  assert.deepEqual(socket.sent.at(-1), { type: 'Terminate' });
  assert.deepEqual(events.at(-1), { type: 'error', kind: 'microphone' });
  const count = events.length;
  h.track.muted = false;
  h.track.dispatch('unmute');
  assert.equal(events.length, count);
  assert.equal(h.synth.spoken.length, 1);
});

test('TTS cancellation exceptions must not leak microphone, socket or audio resources', async (t) => {
  const { client, h, socket } = await connected(t);
  h.synth.start(); h.synth.throwOnCancel = true;
  assert.doesNotThrow(() => client.dispose());
  assert.equal(h.track.stopped, true);
  assert.equal(socket.readyState, FakeSocket.CLOSED);
  assert.equal(FakeContext.instances[0].state, 'closed');
});

test('dispose during active speech emits no late transcript into a reset session', async (t) => {
  const { client, h, events } = await connected(t);
  h.synth.start(); const before = events.length;
  client.dispose();
  assert.equal(events.length, before);
});

test('capture permission resolved after stop releases the late stream without token work', async (t) => {
  let resolveMedia;
  const h = harness({ getUserMedia: () => new Promise((resolve) => { resolveMedia = resolve; }) });
  const client = new SuaraStreamingClient({ accessCode: 'synthetic-access-code' });
  t.after(() => { client.dispose(); h.restore(); });
  const started = client.start();
  await until(() => Boolean(resolveMedia));
  await client.end(); resolveMedia(h.stream); await started;
  assert.equal(h.track.stopped, true); assert.deepEqual(h.calls.map(call => call.url), ['/api/capabilities']);
});

test('terminated or timed-out drain makes old capture, final, TTS and deadline callbacks inert', async (t) => {
  const { client, h, socket, events } = await connected(t);
  const capture = FakeWorklet.instances[0].port.onmessage;
  const utterance = h.synth.spoken.at(-1);
  const oldStart = utterance.onstart;
  await client.end(); client.endTimer.callback();
  const count = events.length; const sent = socket.sent.length;
  capture({ data: new ArrayBuffer(1600) }); oldStart(); socket.message(final(99));
  for (const timer of h.timers.filter((timer) => timer.cleared)) timer.callback();
  assert.equal(events.length, count); assert.equal(socket.sent.length, sent);
});

for (const operation of ['provider-error', 'socket-error', 'socket-close', 'begin-timeout']) {
  test(`startup ${operation} rejects without greeting or lingering capture`, async (t) => {
    const { socket, capturedStart, h, client } = await opening(t);
    if (operation === 'provider-error') socket.message({ type: 'Error', error: 'PRIVATE details' });
    else if (operation === 'begin-timeout') client.connectTimer.callback();
    else socket.dispatch(operation === 'socket-error' ? 'error' : 'close');
    assert.equal((await capturedStart)?.kind, 'connection');
    assert.equal(h.track.stopped, true); assert.equal(h.synth.spoken.length, 0);
    assert.equal(client.isCleanedUp, true);
  });
}

for (const operation of ['capture', 'control', 'question-context']) {
  test(`socket send failure during ${operation} still closes local resources`, async (t) => {
    const { socket, h, client } = await connected(t);
    socket.throwOnSend = true;
    if (operation === 'capture') FakeWorklet.instances[0].port.onmessage({ data: new ArrayBuffer(1600) });
    else if (operation === 'control') socket.message(partial(0));
    else { socket.message(final(0)); await Promise.resolve(); }
    assert.equal(h.track.stopped, true); assert.equal(client.isCleanedUp, true);
    assert.equal(FakeContext.instances[0].state, 'closed');
  });
}

test('busy external speech refuses startup without cancelling another app or opening capture', async (t) => {
  const h = harness();
  h.synth.speaking = true;
  const client = new SuaraStreamingClient();
  t.after(() => { client.dispose(); h.restore(); });
  await assert.rejects(client.start(), { kind: 'speech' });
  assert.equal(h.micCalls, 0); assert.equal(h.calls.length, 0); assert.equal(h.synth.cancels, 0);
});

test('onend without an observed onstart cannot claim a completed spoken question', async (t) => {
  const { client, h, events } = await connected(t);
  h.synth.end();
  assert.equal(client.isCleanedUp, true);
  assert.equal(events.some((event) => event.type === 'agent-transcript' && event.interrupted === false), false);
});

for (const trigger of ['speech-started', 'partial', 'next-question']) {
  test(`${trigger} cancellation failure visibly ends the session instead of continuing over uncancelled output`, async (t) => {
    const { client, socket, h, events } = await connected(t);
    h.synth.start(); h.synth.throwOnCancel = true;
    socket.message(trigger === 'speech-started' ? { type: 'SpeechStarted' } : trigger === 'partial' ? partial(0) : final(0));
    await Promise.resolve();
    assert.equal(client.isCleanedUp, true);
    assert.equal(h.track.stopped, true);
    assert.equal(FakeContext.instances[0].state, 'closed');
    assert.deepEqual(events.at(-1), { type: 'error', kind: 'speech' });
    const count = h.synth.spoken.length;
    socket.message(final(1)); await Promise.resolve();
    assert.equal(h.synth.spoken.length, count);
  });
}

test('duplicate Begin and metadata cannot acknowledge controls or reset session timers', async (t) => {
  const { socket, h, client } = await connected(t);
  const timers = h.timers.length;
  socket.message({ type: 'Begin', configuration: CONFIG });
  socket.message({ type: 'UpdateConfiguration', min_turn_silence: 1, max_turn_silence: 2 });
  socket.message({ type: 'SessionInformation', forced_end: true, user_intent: 'finished' });
  assert.equal(h.timers.length, timers);
  assert.equal(client.patience.snapshot().applicationStatus, 'unconfirmed');
  assert.equal(client.patience.snapshot().profile.endpointObservations, 0);
});

const BANK = (await import('../src/voice/questionBank.js')).QUESTION_BY_ID;
const QUESTION_CAP = 'A'.repeat(43);
const QUESTION_GRANT = Object.freeze({ policy: 'bank-v1', capability: QUESTION_CAP,
  nextSequence: 0, expires_in_seconds: 600, max_selections: 8 });
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value),
  { status, headers: { 'Content-Type': 'application/json' } });
function bankFetch(select = async () => jsonResponse({ questionId: 'childhood_home', nextSequence: 1 }), grant = QUESTION_GRANT) {
  return async (url, init) => {
    if (url === '/api/session') return jsonResponse({ token: 'synthetic-local-bearer' });
    if (url === '/api/streaming/token') return jsonResponse({ token: 'synthetic-provider-token', question_access: grant });
    if (url === '/api/interview/question') return select(init);
    throw new Error('Unexpected synthetic endpoint');
  };
}
async function bankConnected(t, select, clientOptions = {}) {
  const result = await connected(t, { fetch: bankFetch(select) }, { personalised: true, ...clientOptions });
  result.h.synth.start(); result.h.synth.end();
  assert.deepEqual(result.client.askedIds, ['birthplace']);
  return result;
}

test('personalised opt-in requests a grant, keeps it out of URLs/events and starts the opening only on TTS onstart', async (t) => {
  const { client, h, socket, events } = await connected(t, { fetch: bankFetch() }, { personalised: true });
  assert.equal(h.calls[0].init.headers['X-Suara-Question-Policy'], undefined);
  assert.equal(h.calls[2].init.headers['X-Suara-Question-Policy'], 'bank-v1');
  assert.deepEqual(client.questionGrant, { capability: QUESTION_CAP, sequence: 0 });
  assert.equal(socket.url.includes(QUESTION_CAP), false);
  assert.equal(JSON.stringify(events).includes(QUESTION_CAP), false);
  assert.equal(client.askedIds.length, 0);
  assert.equal(client.pendingQuestion.questionId, 'birthplace');
  assert.equal(h.synth.spoken.at(-1).text.includes(BANK.birthplace.text_en), true);
  h.synth.start(); h.synth.start();
  assert.deepEqual(client.askedIds, ['birthplace']);
  assert.equal(client.pendingQuestion, null);
  assert.equal(events.filter((event) => event.type === 'question-selection' && event.source === 'bank').length, 1);
});

test('missing or malformed personalised grants reject before creating a provider socket', async (t) => {
  for (const grant of [undefined, null, { ...QUESTION_GRANT, capability: 123 },
    { ...QUESTION_GRANT, policy: 'other' }, { ...QUESTION_GRANT, nextSequence: 1 }]) {
    await t.test(grant === undefined ? 'missing' : JSON.stringify(grant), async (subtest) => {
      const h = harness({ fetch: bankFetch(undefined, grant === undefined ? {} : grant) });
      const client = new SuaraStreamingClient({ personalised: true, accessCode: 'synthetic-access-code' });
      subtest.after(() => { client.dispose(); h.restore(); });
      await assert.rejects(client.start(), { kind: 'token' });
      assert.equal(FakeSocket.instances.length, 0); assert.equal(h.track.stopped, true);
      assert.equal(client.questionGrant, null); assert.equal(h.synth.spoken.length, 0);
    });
  }
});

test('default and non-boolean opt-in sessions never request grants or forward answer text', async (t) => {
  for (const personalised of [undefined, false, 'true', 1]) await t.test(String(personalised), async (subtest) => {
    const { socket, h, client } = await connected(subtest, { fetch: bankFetch() }, { personalised });
    h.synth.start(); h.synth.end();
    socket.message(partial(0, 'PRIVATE_PARTIAL'));
    socket.message(final(0, 'PRIVATE_FINAL'));
    await Promise.resolve();
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls.some((call) => call.init.headers['X-Suara-Question-Policy']), false);
    assert.equal(client.questionGrant, null); assert.deepEqual(client.recentAnswers, []);
    assert.equal(JSON.stringify(h.calls).includes('PRIVATE_FINAL'), false);
  });
});

test('personalised AI selection speaks only bank text and advances sequence exactly once', async (t) => {
  const { socket, h, client, events } = await bankConnected(t);
  socket.message(partial(0, 'PRIVATE_PARTIAL'));
  assert.equal(h.calls.length, 3);
  socket.message(final(0, 'PRIVATE_FINAL_ANSWER'));
  await until(() => h.synth.spoken.length === 2);
  const call = h.calls.find((entry) => entry.url === '/api/interview/question');
  assert.deepEqual(JSON.parse(call.init.body), { version: 'bank-v1', sequence: 0, transcript: 'PRIVATE_FINAL_ANSWER' });
  assert.equal(call.init.headers.Authorization, `Bearer ${QUESTION_CAP}`);
  assert.equal(call.init.body.includes('PRIVATE_PARTIAL'), false);
  assert.equal(h.synth.spoken.at(-1).text, BANK.childhood_home.text_en);
  assert.equal(h.synth.spoken.at(-1).text.includes('PRIVATE'), false);
  assert.equal(client.questionGrant.sequence, 1);
  assert.deepEqual(client.askedIds, ['birthplace']);
  h.synth.start(); h.synth.start(); h.synth.end();
  assert.deepEqual(client.askedIds, ['birthplace', 'childhood_home']);
  assert.equal(events.filter((event) => event.type === 'question-selection' && event.source === 'ai').length, 1);
});

test('second AI call includes only the last two finals and the exact next sequence', async (t) => {
  const { socket, h, client } = await bankConnected(t, async (init) => {
    const body = JSON.parse(init.body);
    return jsonResponse({ questionId: body.sequence === 0 ? 'childhood_home' : 'parents', nextSequence: body.sequence + 1 });
  });
  socket.message(final(0, 'My first final.')); await until(() => h.synth.spoken.length === 2);
  h.synth.start(); h.synth.end();
  socket.message(partial(1, 'PRIVATE_PARTIAL_NOT_FOR_GATEWAY'));
  socket.message(final(1, 'My second final.')); await until(() => h.synth.spoken.length === 3);
  const calls = h.calls.filter((call) => call.url === '/api/interview/question');
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].init.body), { version: 'bank-v1', sequence: 1,
    transcript: 'My first final.\nMy second final.' });
  assert.equal(client.questionGrant.sequence, 2);
  assert.equal(h.synth.spoken.at(-1).text, BANK.parents.text_en);
});

test('large well-formed final uses one surrogate-safe excerpt trim instead of invalidating AI selection', async (t) => {
  const { socket, h } = await bankConnected(t);
  socket.message(final(0, '😀' + 'x'.repeat(3999)));
  await until(() => h.synth.spoken.length === 2);
  const calls = h.calls.filter((call) => call.url === '/api/interview/question');
  assert.equal(calls.length, 1);
  const transcript = JSON.parse(calls[0].init.body).transcript;
  assert.equal(transcript.isWellFormed(), true); assert.equal(transcript, 'x'.repeat(3999));
});

for (const uncertain of ['invalid-id', 'extra-text', 'wrong-sequence', 'http-error', 'transport-error', 'timeout']) {
  test(`selection ${uncertain} permanently abandons its capability and uses chronological local fallback`, async (t) => {
    const { socket, h, client } = await bankConnected(t, async () => {
      if (uncertain === 'invalid-id') return jsonResponse({ questionId: 'unknown', nextSequence: 1 });
      if (uncertain === 'extra-text') return jsonResponse({ questionId: 'childhood_home', nextSequence: 1, text: 'PRIVATE GENERATED SPEECH' });
      if (uncertain === 'wrong-sequence') return jsonResponse({ questionId: 'childhood_home', nextSequence: 9 });
      if (uncertain === 'http-error') return jsonResponse({ error: 'PRIVATE SERVER' }, 503);
      if (uncertain === 'transport-error') throw new Error('PRIVATE TRANSPORT');
      return new Promise(() => {});
    });
    socket.message(final(0));
    if (uncertain === 'timeout') h.timers.find((timer) => timer.milliseconds === 5000 && !timer.cleared).callback();
    await until(() => h.synth.spoken.length === 2);
    assert.equal(client.questionGrant, null);
    assert.equal(h.synth.spoken.at(-1).text, BANK.childhood_home.text_en);
    h.synth.start(); h.synth.end();
    socket.message(final(1)); await until(() => h.synth.spoken.length === 3);
    assert.equal(h.synth.spoken.at(-1).text, BANK.parents.text_en);
    assert.equal(h.calls.filter((call) => call.url === '/api/interview/question').length, 1);
  });
}

test('barge-in aborts pending selection, abandons capability and suppresses late answer without retry', async (t) => {
  let resolveSelection; let selectionSignal;
  const { socket, h, client } = await bankConnected(t, (init) => {
    selectionSignal = init.signal;
    return new Promise((resolve) => { resolveSelection = resolve; });
  });
  socket.message(final(0)); await until(() => Boolean(resolveSelection));
  socket.message({ type: 'SpeechStarted' });
  assert.equal(selectionSignal.aborted, true); assert.equal(client.questionGrant, null);
  resolveSelection(jsonResponse({ questionId: 'parents', nextSequence: 1 }));
  await new Promise(setImmediate);
  assert.equal(h.synth.spoken.length, 1);
  socket.message(final(1)); await until(() => h.synth.spoken.length === 2);
  assert.equal(h.synth.spoken.at(-1).text, BANK.childhood_home.text_en);
  assert.equal(h.calls.filter((call) => call.url === '/api/interview/question').length, 1);
});

test('unstarted AI-selected question survives barge-in and is replayed without skipping or spending another sequence', async (t) => {
  const { socket, h, client } = await bankConnected(t, async () => jsonResponse({ questionId: 'parents', nextSequence: 1 }));
  socket.message(final(0)); await until(() => h.synth.spoken.length === 2);
  const unstarted = h.synth.spoken.at(-1); const oldStart = unstarted.onstart;
  assert.equal(client.pendingQuestion.questionId, 'parents'); assert.deepEqual(client.askedIds, ['birthplace']);
  socket.message({ type: 'SpeechStarted' }); oldStart();
  assert.deepEqual(client.askedIds, ['birthplace']);
  assert.equal(client.questionGrant.sequence, 1);
  socket.message(final(1)); await until(() => h.synth.spoken.length === 3);
  assert.equal(h.synth.spoken.at(-1).text, BANK.parents.text_en);
  assert.equal(h.calls.filter((call) => call.url === '/api/interview/question').length, 1);
  h.synth.start(); h.synth.start();
  assert.deepEqual(client.askedIds, ['birthplace', 'parents']);
  assert.equal(client.pendingQuestion, null);
});

test('a pending unstarted opening remains the opening even when final speech arrives first', async (t) => {
  const { socket, h, client } = await connected(t, { fetch: bankFetch() }, { personalised: true });
  socket.message({ type: 'SpeechStarted' });
  socket.message(final(0)); await until(() => h.synth.spoken.length === 2);
  assert.equal(h.synth.spoken.at(-1).text.includes(BANK.birthplace.text_en), true);
  assert.deepEqual(client.askedIds, []); assert.equal(h.calls.length, 3);
  h.synth.start(); assert.deepEqual(client.askedIds, ['birthplace']);
});

for (const operation of ['stop', 'reset']) {
  test(`${operation} clears an in-flight selection and late completion cannot emit or speak`, async (t) => {
    let resolveSelection;
    const { socket, h, client, events } = await bankConnected(t, () => new Promise((resolve) => { resolveSelection = resolve; }));
    socket.message(final(0)); await until(() => Boolean(resolveSelection));
    if (operation === 'reset') client.dispose();
    else { await client.end(); socket.message({ type: 'Termination' }); }
    const eventCount = events.length; const speechCount = h.synth.spoken.length;
    resolveSelection(jsonResponse({ questionId: 'parents', nextSequence: 1 })); await new Promise(setImmediate);
    assert.equal(events.length, eventCount); assert.equal(h.synth.spoken.length, speechCount);
    assert.equal(client.questionGrant, null); assert.equal(client.selectionController, null);
    assert.equal(client.pendingQuestion, null); assert.deepEqual(client.recentAnswers, []); assert.deepEqual(client.askedIds, []);
  });
}

test('personalised fallback stops at eight started bank questions without extra selection requests', async (t) => {
  const { socket, h, client } = await bankConnected(t, async () => jsonResponse({ error: 'unavailable' }, 503));
  for (let order = 0; order < 7; order += 1) {
    socket.message(final(order)); await until(() => h.synth.spoken.length === order + 2);
    h.synth.start(); h.synth.start(); h.synth.end();
  }
  assert.equal(client.askedIds.length, 8);
  assert.equal(new Set(client.askedIds).size, 8);
  assert.equal(h.calls.filter((call) => call.url === '/api/interview/question').length, 1);
  socket.message(final(7)); await until(() => h.synth.spoken.length === 9);
  assert.equal(client.askedIds.length, 8);
  assert.equal(client.isEnding, false);
  h.synth.start(); h.synth.end();
  assert.equal(client.isEnding, true);
  assert.deepEqual(socket.sent.at(-1), { type: 'Terminate' });
});

test('AI winding-down choice is followed by closing without requesting an ineligible later question', async (t) => {
  const { socket, h, client } = await bankConnected(t, async () => jsonResponse({ questionId: 'anything_else', nextSequence: 1 }));
  socket.message(final(0)); await until(() => h.synth.spoken.length === 2);
  h.synth.start(); h.synth.end();
  assert.deepEqual(client.askedIds, ['birthplace', 'anything_else']);
  socket.message(final(1)); await until(() => h.synth.spoken.length === 3);
  h.synth.start(); h.synth.end();
  assert.equal(client.isEnding, true);
  assert.equal(h.calls.filter((call) => call.url === '/api/interview/question').length, 1);
});
