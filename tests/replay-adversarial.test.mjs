import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// Import the actual production clients while replacing only Vite's asset URL.
// No token exchange, microphone, network or real speech is used by this suite.
const data = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const path = (file) => JSON.stringify(new URL(file, import.meta.url).href);
const base = data((await readFile(new URL("../src/voice/voiceClient.js", import.meta.url), "utf8"))
  .replace('"./copy.js"', path("../src/voice/copy.js"))
  .replace('import processorUrl from "./pcm-processor.js?url&no-inline";', 'const processorUrl = "unused-adversarial-replay";'));
let streaming = (await readFile(new URL("../src/voice/streamingClient.js", import.meta.url), "utf8"))
  .replace('"./voiceClient.js"', JSON.stringify(base));
for (const file of ["copy", "patienceController", "questionBank", "questionClient", "capabilities"])
  streaming = streaming.replace(`"./${file}.js"`, path(`../src/voice/${file}.js`));
const adapter = (await readFile(new URL("../src/research/replayClient.js", import.meta.url), "utf8"))
  .replace('"../voice/voiceClient.js"', JSON.stringify(base))
  .replace('"../voice/streamingClient.js"', JSON.stringify(data(streaming)));
const { createReplayClient, queueReplayFrame } = await import(data(adapter));
const controller = (await readFile(new URL("../src/research/replayRun.js", import.meta.url), "utf8"))
  .replace('import { createReplayClient, queueReplayFrame } from "./replayClient.js";', 'const createReplayClient = () => { throw new Error("no live client"); }; const queueReplayFrame = () => false;')
  .replace('"./replayPacer.js"', path("../src/research/replayPacer.js"));
const { ReplayRun, awaitReplayStart } = await import(data(controller));

function environment({ resume } = {}) {
  const priorWindow = globalThis.window;
  const priorWebSocket = globalThis.WebSocket;
  const played = []; const spoken = []; const contexts = [];
  class Node extends EventTarget { connect() {} disconnect() {} }
  class Context extends Node {
    constructor() { super(); this.state = "suspended"; this.currentTime = 0; this.destination = new Node(); contexts.push(this); }
    async resume() { if (resume) await resume(); if (this.state !== "closed") this.state = "running"; }
    async close() { this.state = "closed"; }
    createBuffer(_channels, count, rate) { return { copyToChannel() {}, duration: count / rate }; }
    createBufferSource() { const node = new Node(); node.start = () => played.push(node); node.stop = () => {}; return node; }
  }
  const synth = new Node();
  synth.getVoices = () => [{ lang: "en-MY", localService: true }];
  synth.speak = (utterance) => spoken.push(utterance); synth.cancel = () => {};
  globalThis.window = {
    AudioContext: Context, speechSynthesis: synth,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout,
  };
  globalThis.WebSocket = { OPEN: 1, CLOSING: 2 };
  return { played, spoken, contexts, restore() { globalThis.window = priorWindow; globalThis.WebSocket = priorWebSocket; } };
}
const message = (client, value) => client.handleMessage({ data: JSON.stringify(value) });
const managedConfig = { input: { transcription_mode: "balanced", turn_detection: { min_silence: 1200, max_silence: 6000, interrupt_response: true } }, output: { voice: "alba" } };
const streamingConfig = { model: "universal-3-5-pro", mode: "max_accuracy", min_turn_silence: 1200, max_turn_silence: 6000 };
async function ready(client) {
  await client.prepareAudio(new AbortController().signal);
  client.socket = { readyState: 1, bufferedAmount: 0, send() {}, close() {} };
  message(client, client.mode === "streaming" ? { type: "Begin", configuration: streamingConfig } : { type: "session.ready", config: managedConfig });
  await Promise.resolve();
}

for (const mode of ["baseline", "patient", "streaming"]) {
  test(`replay ${mode} retains the first accepted configuration despite duplicate provider metadata`, async () => {
    const env = environment(); const observations = [];
    const client = createReplayClient({ mode, observe: (kind) => observations.push(kind) });
    try {
      await ready(client);
      const original = structuredClone(client.replayConfiguration);
      message(client, mode === "streaming"
        ? { type: "Begin", configuration: { ...streamingConfig, min_turn_silence: 1, max_turn_silence: 2 } }
        : { type: "session.ready", config: { ...managedConfig, input: { turn_detection: { min_silence: 1, max_silence: 2 } } } });
      assert.deepEqual(client.replayConfiguration, original);
      assert.equal(observations.filter((kind) => kind === "configuration_received").length, 1);
    } finally { client.dispose(); env.restore(); }
  });
}

test("blank or malformed managed finals are not successful user-final observations", async () => {
  const env = environment(); const observations = [];
  const client = createReplayClient({ mode: "baseline", observe: (kind) => observations.push(kind) });
  try {
    await ready(client);
    for (const text of ["", " \r\n\t", null, 123, { PRIVATE: "not a transcript" }])
      message(client, { type: "transcript.user", text });
    assert.equal(observations.filter((kind) => kind === "user_final_received").length, 0);
    message(client, { type: "transcript.user", text: "Synthetic test sentence, not a human recording." });
    assert.equal(observations.filter((kind) => kind === "user_final_received").length, 1);
    assert.doesNotMatch(JSON.stringify(observations), /PRIVATE|Synthetic test sentence/);
  } finally { client.dispose(); env.restore(); }
});

test("an interrupted managed greeting cannot lend its audio to a later silent completion", async () => {
  const env = environment(); const client = createReplayClient({ mode: "baseline" });
  try {
    await ready(client);
    message(client, { type: "reply.started", reply_id: "first" });
    message(client, { type: "reply.audio", data: "AAAAAA==" });
    message(client, { type: "reply.done", status: "interrupted", reply_id: "first" });
    assert.equal(client.replayGreetingIdle, false);
    message(client, { type: "reply.started", reply_id: "second" });
    message(client, { type: "reply.done", status: "completed", reply_id: "second" });
    assert.equal(client.replayGreetingIdle, false);
    assert.equal(client.replayGreetingDone, false);
  } finally { client.dispose(); env.restore(); }
});

test("late output and finals after disposal cannot revive replay or leak content", async () => {
  const env = environment(); const observations = [];
  const client = createReplayClient({ mode: "baseline", observe: (kind) => observations.push(kind) });
  try {
    await ready(client); client.dispose(); const before = observations.length;
    for (const value of [
      { type: "reply.audio", data: "AAAAAA==" },
      { type: "reply.done", status: "completed" },
      { type: "transcript.user", text: "PRIVATE late content" },
      { type: "session.ready", config: managedConfig },
    ]) message(client, value);
    assert.equal(observations.length, before);
    assert.equal(client.replayGreetingIdle, false);
    assert.equal(env.played.length, 0);
    assert.throws(() => queueReplayFrame(client, new ArrayBuffer(2400)));
    assert.doesNotMatch(JSON.stringify(observations), /PRIVATE/);
  } finally { client.dispose(); env.restore(); }
});

test("Stop settles the replay run with a real production client whose AudioContext.resume never resolves", async () => {
  const env = environment({ resume: () => new Promise(() => {}) });
  const client = createReplayClient({ mode: "baseline", accessCode: "synthetic-replay-code-only" });
  const run = new ReplayRun({ mode: "baseline", source, accessCode: "synthetic-replay-code-only", consent: true,
    clientFactory: () => client });
  let tokenCalls = 0;
  client.fetchToken = async () => { tokenCalls += 1; throw new Error("Network must not be reached"); };
  let timeout;
  try {
    const started = run.start(); await Promise.resolve(); await Promise.resolve(); run.stop();
    const result = await Promise.race([
      started,
      new Promise((resolve) => { timeout = setTimeout(() => resolve("hung"), 150); }),
    ]);
    assert.notEqual(result, "hung"); assert.equal(result.error, "cancelled");
    assert.equal(result.status, "inconclusive"); assert.equal(tokenCalls, 0);
    assert.equal(env.contexts[0].state, "closed");
  } finally { clearTimeout(timeout); run.dispose(); client.dispose(); env.restore(); }
});

test("replay start timeout is bounded even if browser platform work ignores abort", async () => {
  const abort = new AbortController();
  await assert.rejects(awaitReplayStart(() => new Promise(() => {}), abort.signal, 5), { kind: "start_timeout" });
});

test("already-cancelled replay start never begins token or browser work", async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  await assert.rejects(awaitReplayStart(() => { calls += 1; }, abort.signal, 5), { kind: "cancelled" });
  assert.equal(calls, 0);
});

test("late provider-start rejection after timeout is consumed without altering the result", async () => {
  const abort = new AbortController(); let rejectStart;
  const operation = new Promise((_resolve, reject) => { rejectStart = reject; });
  await assert.rejects(awaitReplayStart(() => operation, abort.signal, 5), { kind: "start_timeout" });
  rejectStart(new Error("PRIVATE late provider detail"));
  await new Promise((resolve) => setImmediate(resolve));
});

const source = {
  metadata: { schema: 1, sourceSha256: "a".repeat(64), sourceRateHz: 48000, sourceFrames: 2400,
    durationMs: 50, chunkMs: 50, chunkCount: 1, conversion: "fir63-hamming-causal-v1", filterDelaySourceFrames: 31 },
  frameAt: (rate) => new ArrayBuffer(rate / 10),
};
function runner({ preSourceFinal = false, finishTransportDuringDrain = false, stopDuringEnd = false } = {}) {
  let clock = 100; let client; let observed;
  const run = new ReplayRun({
    mode: "baseline", source, accessCode: "synthetic-replay-code-only", consent: true,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    onUpdate: (event) => { if (event.phase === "ending" && stopDuringEnd) run.stop(); },
    clientFactory(args) {
      observed = args.observe;
      client = {
        isReady: true, isEnding: false, isCleanedUp: false, failureKind: null, providerEnded: false,
        replayGreetingIdle: true, replayConfiguration: { protocol: "fixture" },
        replyInProgress: false, playbackSources: new Set(), speech: null, pendingQuestion: null,
        async start() { if (preSourceFinal) observed("user_final_received"); },
        async end() { this.isEnding = true; this.isCleanedUp = true; this.providerEnded = true; },
        dispose() { this.isEnding = true; this.isCleanedUp = true; this.isReady = false; },
      };
      return client;
    },
    send() { return true; },
    async replay(options) {
      options.sendFrame(new ArrayBuffer(2400));
      options.onProgress({ framesSent: 1, submittedSourceFrames: 2400 });
      if (!preSourceFinal) observed("user_final_received");
      if (finishTransportDuringDrain) { client.isCleanedUp = true; client.isReady = false; client.providerEnded = true; }
      return { originMs: clock, inputComplete: true, submittedSourceFrames: 482400, framesSent: 201, sendObservations: [], elapsedMs: 10050 };
    },
  });
  return run;
}

test("a final observed before source exposure cannot satisfy replay acceptance", async () => {
  const report = await runner({ preSourceFinal: true }).start();
  assert.equal(report.status, "inconclusive"); assert.equal(report.error, "no_final_transcript");
  assert.equal(report.userFinals, 0);
});

test("an unsolicited provider end at output-drain boundary cannot become a clean successful run", async () => {
  const report = await runner({ finishTransportDuringDrain: true }).start();
  assert.equal(report.status, "inconclusive"); assert.equal(report.error, "connection");
  assert.equal(report.cleanEnd, false);
});

test("Stop in the ending update cannot be bypassed by an already-true cleanup predicate", async () => {
  const report = await runner({ stopDuringEnd: true }).start();
  assert.equal(report.status, "inconclusive"); assert.equal(report.error, "cancelled");
  assert.doesNotMatch(JSON.stringify(report), /synthetic-replay-code-only/);
});
