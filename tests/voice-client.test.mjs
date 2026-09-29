import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SESSION_PROMPT, SESSION_QUESTIONS } from "../src/voice/copy.js";
import { TimingTrace, exportTiming } from "../src/research/timing.js";

const clientSource = await readFile(
  new URL("../src/voice/voiceClient.js", import.meta.url),
  "utf8",
);

async function loadVoiceClient() {
  const transformed = clientSource
    .replace(
      'import { SESSION_PROMPT, SESSION_QUESTIONS } from "./copy.js";',
      `const SESSION_PROMPT = ${JSON.stringify(SESSION_PROMPT)};\nconst SESSION_QUESTIONS = ${JSON.stringify(SESSION_QUESTIONS)};`,
    )
    .replace(
      'import processorUrl from "./pcm-processor.js?url&no-inline";',
      'const processorUrl = "/assets/suara-pcm-processor.js";',
    );
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}`;
  return import(dataUrl);
}

const { SESSION_LIMIT_MS, SuaraVoiceClient, buildSessionUpdate } = await loadVoiceClient();

class FakeNode {
  constructor() {
    this.connections = [];
    this.disconnected = false;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, payload = {}) {
    for (const listener of this.listeners.get(type) || []) listener(payload);
  }

  connect(node) {
    this.connections.push(node);
    return node;
  }

  disconnect() {
    this.disconnected = true;
  }
}

class FakeWorkletNode extends FakeNode {
  static instances = [];

  constructor(context, name, options) {
    super();
    this.context = context;
    this.name = name;
    this.options = options;
    this.port = { onmessage: null };
    FakeWorkletNode.instances.push(this);
  }
}

class FakeAudioContext extends FakeNode {
  static instances = [];

  constructor() {
    super();
    this.audioWorklet = {
      addModule: async (url) => {
        this.workletModule = url;
      },
    };
    this.currentTime = 0;
    this.destination = new FakeNode();
    this.sampleRate = 48_000;
    this.state = "suspended";
    this.sources = [];
    FakeAudioContext.instances.push(this);
  }

  async resume() {
    this.state = "running";
  }

  createMediaStreamSource(stream) {
    const source = new FakeNode();
    source.stream = stream;
    return source;
  }

  createGain() {
    const gain = new FakeNode();
    gain.gain = { value: 1 };
    return gain;
  }

  createBuffer(channels, length, sampleRate) {
    return {
      channels,
      copied: null,
      copyToChannel(samples) {
        this.copied = samples;
      },
      duration: length / sampleRate,
      length,
      sampleRate,
    };
  }

  createBufferSource() {
    const source = new FakeNode();
    source.start = (at) => { source.startedAt = at; };
    source.stop = () => { source.stopped = true; };
    this.sources.push(source);
    return source;
  }

  async close() {
    this.state = "closed";
  }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  static throwOnConnectingClose = false;

  constructor(url) {
    this.listeners = new Map();
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.bufferedAmount = 0;
    this.url = url.toString();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, payload = {}) {
    for (const listener of this.listeners.get(type) || []) listener(payload);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open");
  }

  message(payload) {
    this.dispatch("message", { data: JSON.stringify(payload) });
  }

  send(payload) {
    if (this.throwOnSend) throw new Error("transport is unavailable");
    this.sent.push(JSON.parse(payload));
  }

  close(code, reason) {
    if (this.readyState === FakeWebSocket.CONNECTING && FakeWebSocket.throwOnConnectingClose) {
      throw new Error("connecting socket cannot close yet");
    }
    this.closeCall = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
  }
}

function response(payload, ok = true) {
  return {
    ok,
    async json() {
      return payload;
    },
  };
}

function installBrowserHarness(fetchImpl, { getUserMediaImpl } = {}) {
  const originals = new Map();
  const timers = [];
  const track = new FakeNode();
  track.stopped = false;
  track.stop = () => { track.stopped = true; };
  const stream = { getTracks: () => [track] };

  function replaceGlobal(name, value) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
  }

  FakeAudioContext.instances = [];
  FakeWebSocket.instances = [];
  FakeWebSocket.throwOnConnectingClose = false;
  FakeWorkletNode.instances = [];

  replaceGlobal("window", {
    AudioContext: FakeAudioContext,
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    setTimeout(callback, milliseconds) {
      const timer = { callback, cleared: false, milliseconds };
      timers.push(timer);
      return timer;
    },
  });
  replaceGlobal("navigator", {
    mediaDevices: {
      async getUserMedia(constraints) {
        stream.constraints = constraints;
        if (getUserMediaImpl) return getUserMediaImpl(constraints, stream);
        return stream;
      },
    },
  });
  replaceGlobal("AudioWorkletNode", FakeWorkletNode);
  replaceGlobal("WebSocket", FakeWebSocket);
  replaceGlobal("fetch", fetchImpl);
  replaceGlobal("btoa", (value) => Buffer.from(value, "binary").toString("base64"));

  return {
    stream,
    timers,
    track,
    restore() {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

async function waitFor(predicate, message = "condition") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

test("session configuration keeps the language and mode boundaries explicit", () => {
  const baseline = buildSessionUpdate("baseline");
  const patient = buildSessionUpdate("patient");

  assert.equal(baseline.type, "session.update");
  assert.deepEqual(baseline.session.input.language_codes, ["en", "zh"]);
  assert.equal("turn_detection" in baseline.session.input, false);
  assert.deepEqual(patient.session.input.turn_detection, {
    interrupt_response: true,
    max_silence: 6000,
    min_silence: 1200,
  });
  assert.equal(patient.session.output.voice, "alba");
  assert.equal(patient.session.output.format.encoding, "audio/pcm");
  assert.match(patient.session.system_prompt, /English or Mandarin/i);
  assert.doesNotMatch(patient.session.system_prompt, /mixture|mix of both/i);
  assert.match(patient.session.system_prompt, /Always speak back in clear, warm English/i);
  assert.equal(SESSION_QUESTIONS.length, 3);
  assert.equal(SESSION_LIMIT_MS, 600_000);
});

test("start performs a no-store local-session exchange before an authorized empty token POST", async (t) => {
  const calls = [];
  const localBearer = "local-browser-bearer-value";
  const providerToken = "temporary-provider-token-value";
  const harness = installBrowserHarness(async (url, options) => {
    calls.push({ options, url });
    if (url === "/api/session") return response({ token: localBearer });
    if (url === "/api/voice/token") return response({ token: providerToken });
    throw new Error(`Unexpected URL: ${url}`);
  });
  t.after(() => harness.restore());

  const events = [];
  const client = new SuaraVoiceClient({ mode: "patient", accessCode: "judge-access-code", onEvent: (event) => events.push(event) });
  const startPromise = client.start();
  await waitFor(() => FakeWebSocket.instances.length === 1, "voice WebSocket");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/api/session");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.headers["X-Suara-Access-Code"], "judge-access-code");

  assert.equal(calls[1].url, "/api/voice/token");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.cache, "no-store");
  assert.equal(calls[1].options.credentials, "same-origin");
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${localBearer}`);
  assert.equal(Object.hasOwn(calls[1].options, "body"), false);
  assert.equal(calls[1].options.headers["X-Suara-Access-Code"], undefined);
  assert.equal(client.accessCode, "");

  const socket = FakeWebSocket.instances[0];
  assert.equal(new URL(socket.url).origin, "wss://agents.assemblyai.com");
  assert.equal(new URL(socket.url).searchParams.get("token"), providerToken);
  assert.equal(socket.url.includes(localBearer), false);

  socket.open();
  assert.equal(socket.sent[0].type, "session.update");
  assert.deepEqual(socket.sent[0].session.input.language_codes, ["en", "zh"]);

  const worklet = FakeWorkletNode.instances[0];
  worklet.port.onmessage({ data: new Int16Array([1, -1]).buffer });
  assert.equal(socket.sent.some((message) => message.type === "input.audio"), false);

  socket.message({
    config: { input: { turn_detection: { interrupt_response: true, max_silence: 6000, min_silence: 1200 } } },
    type: "session.ready",
  });
  await startPromise;
  worklet.port.onmessage({ data: new Int16Array([1, -1]).buffer });
  const audioMessage = socket.sent.find((message) => message.type === "input.audio");
  assert.equal(typeof audioMessage.audio, "string");
  assert.equal(audioMessage.audio.length > 0, true);
  assert.equal(events.some((event) => event.type === "ready"), true);
  assert.equal(events.some((event) => event.type === "status" && event.status === "listening"), true);
});

test("patient mode fails closed when session.ready does not echo the requested timing", async (t) => {
  const harness = installBrowserHarness(async (url) => (
    url === "/api/session"
      ? response({ token: "local-browser-bearer-value" })
      : response({ token: "temporary-provider-token-value" })
  ));
  t.after(() => harness.restore());

  const events = [];
  const client = new SuaraVoiceClient({ mode: "patient", onEvent: (event) => events.push(event) });
  const startPromise = client.start();
  await waitFor(() => FakeWebSocket.instances.length === 1, "patient voice WebSocket");
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.message({
    config: { input: { turn_detection: { interrupt_response: true, max_silence: 3000, min_silence: 1200 } } },
    type: "session.ready",
  });
  await assert.rejects(startPromise, { kind: "configuration" });

  assert.equal(events.some((event) => event.type === "error" && event.kind === "configuration"), true);
  assert.deepEqual(socket.sent.at(-1), { type: "session.end" });
  assert.equal(harness.track.stopped, true);
  assert.equal(socket.closeCall?.code, 1000);
});

test("transcripts remain event data, and a normal finish sends session.end and tears audio down", async (t) => {
  const harness = installBrowserHarness(async (url) => (
    url === "/api/session"
      ? response({ token: "local-browser-bearer-value" })
      : response({ token: "temporary-provider-token-value" })
  ));
  t.after(() => harness.restore());

  const events = [];
  const client = new SuaraVoiceClient({ onEvent: (event) => events.push(event) });
  const startPromise = client.start();
  await waitFor(() => FakeWebSocket.instances.length === 1, "voice WebSocket");
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.message({ type: "session.ready" });
  await startPromise;

  socket.message({ item_id: "memory-1", text: "We made dumplings every Sunday.", type: "transcript.user" });
  socket.message({
    interrupted: false,
    item_id: "agent-1",
    reply_id: "reply-1",
    text: "That Sunday tradition sounds vivid.",
    type: "transcript.agent",
  });

  assert.deepEqual(events.find((event) => event.type === "user-transcript"), {
    itemId: "memory-1",
    text: "We made dumplings every Sunday.",
    type: "user-transcript",
  });
  assert.deepEqual(events.find((event) => event.type === "agent-transcript"), {
    interrupted: false,
    itemId: "agent-1",
    replyId: "reply-1",
    text: "That Sunday tradition sounds vivid.",
    type: "agent-transcript",
  });

  await client.end("user");
  assert.deepEqual(socket.sent.at(-1), { type: "session.end" });
  socket.message({ type: "session.ended" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.track.stopped, true);
  assert.equal(FakeAudioContext.instances[0].state, "closed");
  assert.equal(events.some((event) => event.type === "ended"), true);
});

test("disposing during a pending microphone request stops a late stream and never opens a socket", async (t) => {
  let resolveMicrophone;
  const pendingMicrophone = new Promise((resolve) => {
    resolveMicrophone = resolve;
  });
  let fetchCalls = 0;
  const harness = installBrowserHarness(
    async () => {
      fetchCalls += 1;
      return response({ token: "token-that-must-not-be-used" });
    },
    { getUserMediaImpl: () => pendingMicrophone },
  );
  t.after(() => harness.restore());

  const events = [];
  const client = new SuaraVoiceClient({ onEvent: (event) => events.push(event) });
  const startPromise = client.start();
  await waitFor(() => Boolean(harness.stream.constraints), "pending microphone request");

  client.dispose();
  resolveMicrophone(harness.stream);
  await startPromise;

  assert.equal(harness.track.stopped, true);
  assert.equal(FakeAudioContext.instances[0].state, "closed");
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("a socket that opens after connecting-state cleanup is closed without sending configuration", async (t) => {
  const harness = installBrowserHarness(async (url) => (
    url === "/api/session"
      ? response({ token: "local-browser-bearer-value" })
      : response({ token: "temporary-provider-token-value" })
  ));
  t.after(() => harness.restore());

  const events = [];
  const client = new SuaraVoiceClient({ onEvent: (event) => events.push(event) });
  const startPromise = client.start();
  await waitFor(() => FakeWebSocket.instances.length === 1, "connecting voice WebSocket");
  const socket = FakeWebSocket.instances[0];
  FakeWebSocket.throwOnConnectingClose = true;

  client.dispose();
  await startPromise;
  assert.equal(socket.closeCall, undefined);

  socket.open();
  assert.deepEqual(socket.closeCall, { code: 1000, reason: "Suara session ended" });
  assert.deepEqual(socket.sent, []);
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("disposing during a pending token request stops capture and prevents later token or socket work", async (t) => {
  let resolveSessionToken;
  const pendingSessionToken = new Promise((resolve) => {
    resolveSessionToken = resolve;
  });
  const calls = [];
  const harness = installBrowserHarness(async (url) => {
    calls.push(url);
    if (url === "/api/session") return pendingSessionToken;
    return response({ token: "provider-token-that-must-not-be-used" });
  });
  t.after(() => harness.restore());

  const events = [];
  const client = new SuaraVoiceClient({ onEvent: (event) => events.push(event) });
  const startPromise = client.start();
  await waitFor(() => calls.length === 1, "local session request");

  client.dispose();
  resolveSessionToken(response({ token: "late-local-browser-bearer" }));
  await startPromise;

  assert.deepEqual(calls, ["/api/session"]);
  assert.equal(harness.track.stopped, true);
  assert.equal(FakeAudioContext.instances[0].state, "closed");
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("the ten-minute timer emits a limit event and closes the provider session", async (t) => {
  const harness = installBrowserHarness(async (url) => (
    url === "/api/session"
      ? response({ token: "local-browser-bearer-value" })
      : response({ token: "temporary-provider-token-value" })
  ));
  t.after(() => harness.restore());

  const events = [];
  const client = new SuaraVoiceClient({ onEvent: (event) => events.push(event) });
  const startPromise = client.start();
  await waitFor(() => FakeWebSocket.instances.length === 1, "voice WebSocket");
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.message({ type: "session.ready" });
  await startPromise;

  const limitTimer = harness.timers.find((timer) => timer.milliseconds === SESSION_LIMIT_MS);
  assert.ok(limitTimer, "a ten-minute limit timer is registered after session.ready");
  limitTimer.callback();

  assert.equal(events.some((event) => event.type === "limit"), true);
  assert.deepEqual(socket.sent.at(-1), { type: "session.end" });
  assert.equal(harness.track.stopped, true);
});

async function connectedClient(t, clientOptions = {}, config = undefined) {
  const harness = installBrowserHarness(async () => response({ token: "test-temporary-token" }));
  const events = [];
  const client = new SuaraVoiceClient({ ...clientOptions, onEvent: (event) => events.push(event) });
  t.after(() => { client.dispose(); harness.restore(); });
  const started = client.start();
  await waitFor(() => FakeWebSocket.instances.length === 1);
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.message({ type: "session.ready", config });
  await started;
  return { client, socket, events, harness, context: FakeAudioContext.instances[0] };
}

const pcmAudio = Buffer.from([0, 128, 0, 0, 255, 127]).toString("base64");

test("ending ignores queued ready/audio/deltas/errors and preserves the requested end reason", async (t) => {
  const { client, socket, events, harness, context } = await connectedClient(t);
  const timerCount = harness.timers.length;
  socket.message({ type: "session.ready" });
  assert.equal(harness.timers.length, timerCount, "duplicate ready must not reset the limit");
  await client.end("limit");
  const afterEnd = events.length;
  for (const message of [
    { type: "session.ready" }, { type: "reply.started" },
    { type: "reply.audio", data: pcmAudio }, { type: "transcript.user.delta", text: "stale" },
    { type: "session.error" }, { type: "input.speech.started" },
  ]) socket.message(message);
  assert.equal(events.length, afterEnd);
  assert.equal(context.sources.length, 0);
  for (const timer of harness.timers.filter((entry) => entry.cleared)) timer.callback();
  assert.equal(events.length, afterEnd, "even an already-queued cleared timer is inert");
  socket.message({ type: "session.ended" });
  assert.deepEqual(events.at(-1), { type: "ended", reason: "limit" });
  const count = events.length;
  socket.message({ type: "session.ready" });
  socket.dispatch("close");
  assert.equal(events.length, count);
  assert.equal(harness.timers.every((timer) => timer.cleared), true);
});

test("disposing blocks all late events including queued worklet and playback callbacks", async (t) => {
  const { client, socket, events, context } = await connectedClient(t);
  const capture = FakeWorkletNode.instances[0].port.onmessage;
  socket.message({ type: "reply.audio", data: pcmAudio });
  const source = context.sources[0];
  client.dispose();
  const count = events.length;
  const sent = socket.sent.length;
  capture({ data: new Int16Array([123]).buffer });
  source.dispatch("ended");
  socket.message({ type: "reply.audio", data: pcmAudio });
  socket.message({ type: "transcript.agent", text: "late" });
  socket.message({ type: "session.ended" });
  assert.equal(events.length, count);
  assert.equal(socket.sent.length, sent);
  assert.equal(source.stopped, true);
  assert.equal(source.disconnected, true);
  assert.equal(client.playbackSources.size, 0);
});

test("reply completion stays speaking until the last scheduled PCM chunk actually ends", async (t) => {
  const { socket, events, context } = await connectedClient(t);
  context.currentTime = 5;
  socket.message({ type: "reply.started" });
  socket.message({ type: "reply.audio", data: pcmAudio });
  socket.message({ type: "reply.audio", data: pcmAudio });
  const [first, second] = context.sources;
  assert.deepEqual([...first.buffer.copied], [-1, 0, 32767 / 32768]);
  assert.equal(first.buffer.sampleRate, 24_000);
  assert.equal(first.startedAt, 5);
  assert.equal(second.startedAt, 5 + first.buffer.duration);
  socket.message({ type: "reply.done", status: "completed" });
  assert.equal(events.at(-1).status, "speaking");
  first.dispatch("ended");
  assert.equal(events.at(-1).status, "speaking");
  second.dispatch("ended");
  assert.equal(events.at(-1).status, "listening");
  assert.equal(second.disconnected, true);
});

test("barge-in stops every queued source and discards old audio until a new reply starts", async (t) => {
  const { client, socket, events, context } = await connectedClient(t);
  socket.message({ type: "reply.started" });
  socket.message({ type: "reply.audio", data: pcmAudio });
  socket.message({ type: "reply.audio", data: pcmAudio });
  socket.message({ type: "input.speech.started" });
  assert.equal(context.sources.every((source) => source.stopped && source.disconnected), true);
  assert.equal(client.playbackSources.size, 0);
  socket.message({ type: "reply.audio", data: pcmAudio });
  socket.message({ type: "reply.done", status: "interrupted" });
  assert.equal(context.sources.length, 2);
  assert.equal(events.at(-1).status, "listening");
  context.currentTime = 10;
  socket.message({ type: "input.speech.stopped" });
  socket.message({ type: "reply.started" });
  socket.message({ type: "reply.audio", data: pcmAudio });
  assert.equal(context.sources.length, 3);
  assert.equal(context.sources[2].startedAt, 10);
});

test("audio overload fails visibly instead of silently losing input frames", async (t) => {
  const { client, socket, events, harness } = await connectedClient(t);
  socket.bufferedAmount = 256_001;
  FakeWorkletNode.instances[0].port.onmessage({ data: new Int16Array([10, 20]).buffer });
  assert.equal(client.isCleanedUp, true);
  assert.equal(harness.track.stopped, true);
  assert.deepEqual(events.at(-1), { type: "error", kind: "connection" });
  assert.equal(socket.sent.some((message) => message.type === "input.audio"), false);
  assert.deepEqual(socket.sent.at(-1), { type: "session.end" });
});

for (const operation of ["capture", "end", "dispose"]) {
  test(`a failed socket send during ${operation} still releases microphone and audio`, async (t) => {
    const { client, socket, harness, context } = await connectedClient(t);
    socket.throwOnSend = true;
    if (operation === "capture") FakeWorkletNode.instances[0].port.onmessage({ data: new ArrayBuffer(2) });
    else await client[operation]();
    assert.equal(harness.track.stopped, true);
    assert.equal(context.state, "closed");
    assert.equal(client.isCleanedUp, true);
  });
}

for (const type of ["error", "close", "timeout", "session.ended", "send"]) {
  test(`startup ${type} rejects with a real error rather than resolving as cancellation`, async (t) => {
    const harness = installBrowserHarness(async () => response({ token: "test-temporary-token" }));
    t.after(() => harness.restore());
    const events = [];
    const client = new SuaraVoiceClient({ onEvent: (event) => events.push(event) });
    const started = client.start();
    const rejection = assert.rejects(started, { kind: "connection" });
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const socket = FakeWebSocket.instances[0];
    if (type === "send") socket.throwOnSend = true;
    socket.open();
    if (type === "timeout") client.connectTimer.callback();
    else if (type === "session.ended") socket.message({ type });
    else if (type !== "send") socket.dispatch(type);
    await rejection;
    assert.equal(harness.track.stopped, true);
    assert.equal(events.filter((event) => event.type === "error").length, 1);
    assert.equal(client.isCleanedUp, true);
  });
}

for (const [endpoint, status, kind] of [["/api/session", 401, "access"], ["/api/session", 429, "capacity"], ["/api/voice/token", 429, "capacity"]]) {
  test(`${endpoint} HTTP ${status} is reported as ${kind} without opening a provider socket`, async (t) => {
    const harness = installBrowserHarness(async (url) => url === endpoint
      ? { ok: false, status }
      : response({ token: "local-browser-token" }));
    t.after(() => harness.restore());
    const client = new SuaraVoiceClient({ accessCode: "private-code" });
    await assert.rejects(client.start(), { kind });
    assert.equal(harness.track.stopped, true);
    assert.equal(FakeWebSocket.instances.length, 0);
    assert.equal(client.accessCode, "");
  });
}

test("a stalled token exchange times out, aborts its request and releases capture", async (t) => {
  const harness = installBrowserHarness((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("request aborted")));
  }));
  t.after(() => harness.restore());
  const client = new SuaraVoiceClient();
  const rejection = assert.rejects(client.start(), { kind: "token" });
  await waitFor(() => Boolean(client.connectTimer));
  client.connectTimer.callback();
  await rejection;
  assert.equal(harness.track.stopped, true);
  assert.equal(FakeWebSocket.instances.length, 0);
});

test("capture-device removal and audio worklet failure cannot leave a silent live session", async (t) => {
  for (const source of ["track", "worklet"]) {
    await t.test(source, async (subtest) => {
      const { client, socket, events, harness } = await connectedClient(subtest);
      if (source === "track") harness.track.dispatch("ended");
      else FakeWorkletNode.instances[0].dispatch("processorerror");
      assert.equal(client.isCleanedUp, true);
      assert.deepEqual(socket.sent.at(-1), { type: "session.end" });
      assert.equal(events.at(-1).kind, source === "track" ? "microphone" : "audio");
    });
  }
});

test("a capture-source mute ends visibly, preserves received finals and cannot resume on unmute", async (t) => {
  const { client, socket, events, harness, context } = await connectedClient(t);
  socket.message({ type: "transcript.user", item_id: "synthetic-turn", text: "A synthetic memory." });
  const captured = FakeWorkletNode.instances[0].port.onmessage;
  harness.track.muted = true;
  harness.track.dispatch("mute");
  assert.equal(client.isCleanedUp, true);
  assert.equal(harness.track.stopped, true);
  assert.equal(context.state, "closed");
  assert.deepEqual(events.at(-1), { type: "error", kind: "microphone" });
  assert.equal(events.filter(event => event.type === "user-transcript").length, 1);
  assert.equal(socket.sent.filter(message => message.type === "session.end").length, 1);
  const eventCount = events.length;
  const sentCount = socket.sent.length;
  harness.track.muted = false;
  harness.track.dispatch("unmute");
  captured({ data: new ArrayBuffer(2400) });
  assert.equal(events.length, eventCount);
  assert.equal(socket.sent.length, sentCount);
});

test("an unavailable capture source rejects startup before token exchange", async (t) => {
  for (const state of [{ muted: true }, { readyState: "ended" }]) await t.test(JSON.stringify(state), async subtest => {
    let fetches = 0;
    const harness = installBrowserHarness(async () => { fetches++; return response({ token: "synthetic-token" }); });
    Object.assign(harness.track, state);
    const client = new SuaraVoiceClient();
    subtest.after(() => { client.dispose(); harness.restore(); });
    await assert.rejects(client.start(), { kind: "microphone" });
    assert.equal(fetches, 0);
    assert.equal(harness.track.stopped, true);
    assert.equal(FakeWebSocket.instances.length, 0);
    assert.equal(FakeAudioContext.instances[0].state, "closed");
  });
});

test("a mute notification during intentional teardown does not replace the requested ending", async (t) => {
  const { client, socket, events, harness } = await connectedClient(t);
  await client.end("user");
  harness.track.muted = true;
  harness.track.dispatch("mute");
  socket.message({ type: "session.ended" });
  assert.deepEqual(events.at(-1), { type: "ended", reason: "user" });
  assert.equal(events.some(event => event.type === "error"), false);
});

test("malformed JSON objects are ignored and malformed PCM fails without a later speaking event", async (t) => {
  const { client, socket, events } = await connectedClient(t);
  const before = events.length;
  socket.dispatch("message", { data: "not-json" });
  socket.message(null);
  socket.message(12);
  assert.equal(events.length, before);
  socket.message({ type: "reply.audio", data: Buffer.from([1]).toString("base64") });
  assert.equal(client.isCleanedUp, true);
  assert.deepEqual(events.at(-1), { type: "error", kind: "audio" });
});

test("a disposed client cannot be restarted or allocate a new audio context", async (t) => {
  const { client } = await connectedClient(t);
  client.dispose();
  await assert.rejects(client.start(), { kind: "generic" });
  assert.equal(FakeAudioContext.instances.length, 1);
});

test("a cleared token deadline cannot fail a session that already connected", async (t) => {
  const { client, harness, events } = await connectedClient(t);
  const before = events.length;
  const oldTokenDeadline = harness.timers.find((timer) => timer.milliseconds === 15_000);
  assert.equal(oldTokenDeadline.cleared, true);
  oldTokenDeadline.callback();
  assert.equal(client.isReady, true);
  assert.equal(events.length, before);
});

test("browser audio suspension ends a session instead of leaving an apparently live silent microphone", async (t) => {
  const { client, harness, context, socket, events } = await connectedClient(t);
  context.state = "suspended";
  context.dispatch("statechange");
  assert.equal(client.isCleanedUp, true);
  assert.equal(harness.track.stopped, true);
  assert.deepEqual(socket.sent.at(-1), { type: "session.end" });
  assert.deepEqual(events.at(-1), { type: "error", kind: "audio" });
});

for (const completion of ["acknowledgement", "timeout"]) {
  test(`authoritative transcripts drain during end but become inert after ${completion}`, async (t) => {
    const { client, socket, events, context } = await connectedClient(t);
    await client.end();
    const count = events.length;
    socket.message({ type: "transcript.user", item_id: "last-memory", text: "We always cooked together." });
    socket.message({ type: "transcript.agent", item_id: "last-reply", reply_id: "reply-1", text: "Thank you.", interrupted: true });
    assert.deepEqual(events.slice(count).map((event) => event.type), ["user-transcript", "agent-transcript"]);
    assert.equal(events.at(-2).text, "We always cooked together.");
    socket.message({ type: "transcript.agent.delta", delta: "late" });
    socket.message({ type: "reply.audio", data: pcmAudio });
    assert.equal(events.length, count + 2);
    assert.equal(context.sources.length, 0);
    if (completion === "timeout") client.endTimer.callback();
    else socket.message({ type: "session.ended" });
    const endedCount = events.length;
    socket.message({ type: "transcript.user", text: "too late" });
    socket.message({ type: "transcript.agent", text: "too late" });
    assert.equal(events.length, endedCount);
    assert.equal(events.at(-1).type, "ended");
  });
}

test("default voice sessions never start a timing clock or retain a timing trace", async (t) => {
  const { client, socket } = await connectedClient(t, { now: () => { throw new Error("timing disabled"); } });
  socket.message({ type: "reply.started" });
  socket.message({ type: "reply.audio", data: pcmAudio });
  await client.end();
  socket.message({ type: "session.ended" });
  assert.equal(client.onTiming, null);
  assert.equal(client.timingOrigin, null);
  assert.equal(Object.hasOwn(client, "timingEvents"), false);
});

test("timing callback emits sanitized scalars and one receipt/schedule per reply, with real queue drain", async (t) => {
  let now = 5_000;
  const records = [];
  const { client, socket, context } = await connectedClient(t, { onTiming: (event) => records.push(event), now: () => now }, {
    system_prompt: "SECRET_SENTINEL",
    input: { transcription_mode: "balanced", turn_detection: { min_silence: 1000, max_silence: 3000, interrupt_response: true,
      vad_threshold: 0.5, interruption_delay: 500, hidden: "SECRET_SENTINEL" } },
    output: { voice: "alba" },
  });
  context.getOutputTimestamp = () => ({ contextTime: context.currentTime, performanceTime: now + 20 });
  now += 100;
  socket.message({ type: "speech.unrecognized", text: "SECRET_SENTINEL" });
  socket.message({ type: "input.speech.stopped", session_id: "SECRET_SENTINEL" });
  now += 200;
  socket.message({ type: "reply.started", reply_id: "SECRET_SENTINEL" });
  for (let index = 0; index < 3; index += 1) socket.message({ type: "reply.audio", data: pcmAudio });
  socket.message({ type: "transcript.agent", text: "SECRET_SENTINEL", item_id: "SECRET_SENTINEL" });
  assert.equal(records.filter((event) => event.type === "first_audio_received").length, 1);
  assert.equal(records.filter((event) => event.type === "playback_scheduled").length, 1);
  assert.equal(records.find((event) => event.type === "playback_scheduled").outputStartEstimateMs, 320);
  assert.equal(records.some((event) => event.type === "playback_queue_drained"), false);
  socket.message({ type: "reply.done", status: "completed", reply_id: "SECRET_SENTINEL" });
  context.sources[0].dispatch("ended");
  context.sources[1].dispatch("ended");
  assert.equal(records.some((event) => event.type === "playback_queue_drained"), false);
  context.sources[2].dispatch("ended");
  assert.equal(records.filter((event) => event.type === "playback_queue_drained").length, 1);
  now += 500;
  await client.end();
  socket.message({ type: "session.ended", timestamp: 999999, session_id: "SECRET_SENTINEL" });
  assert.deepEqual(records.at(-1), { type: "ended", atMs: 800, completion: "provider_ended" });
  const trace = new TimingTrace({ consent: true, mode: "baseline", fixture: "english-food-v1", now: () => 0 });
  for (const record of records) assert.equal(trace.record(record), true, `valid record ${record.type}`);
  const exported = exportTiming([trace.snapshot()]);
  assert.equal(exported.includes("SECRET_SENTINEL"), false);
  assert.equal(exported.includes(pcmAudio), false);
});

test("local playback flush and provider interruption are separate diagnostics with no retained ids", async (t) => {
  const records = [];
  const { client, socket } = await connectedClient(t, { onTiming: (event) => records.push(event) });
  socket.message({ type: "reply.started" });
  socket.message({ type: "reply.audio", data: pcmAudio });
  socket.message({ type: "input.speech.started" });
  socket.message({ type: "reply.done", status: "interrupted", reply_id: "SECRET_SENTINEL" });
  assert.equal(records.filter((event) => event.type === "playback_flushed").length, 1);
  assert.equal(records.find((event) => event.type === "playback_flushed").reason, "speech_started");
  assert.equal(records.filter((event) => event.type === "provider_interrupted").length, 1);
  client.dispose();
  const count = records.length;
  socket.message({ type: "reply.started" });
  socket.message({ type: "session.ready" });
  assert.equal(records.length, count);
  assert.equal(JSON.stringify(records).includes("SECRET_SENTINEL"), false);
});

test("diagnostic callback failures do not break capture, playback or cleanup", async (t) => {
  const { client, socket, harness } = await connectedClient(t, { onTiming: () => { throw new Error("operator panel unavailable"); } });
  socket.message({ type: "reply.started" });
  socket.message({ type: "reply.audio", data: pcmAudio });
  assert.equal(client.playbackSources.size, 1);
  await client.end();
  socket.message({ type: "session.ended" });
  assert.equal(harness.track.stopped, true);
  assert.equal(client.isCleanedUp, true);
});

test("failed runs export failure instead of a fabricated successful ended event", async (t) => {
  const records = [];
  const { client, socket } = await connectedClient(t, { onTiming: (event) => records.push(event) });
  socket.dispatch("error");
  client.dispose();
  assert.equal(records.filter((event) => event.type === "failure").length, 1);
  assert.equal(records.filter((event) => event.type === "ended").length, 0);
  assert.equal(records.at(-1).kind, "connection");
});
