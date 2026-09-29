import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
const data = (value) => `data:text/javascript;base64,${Buffer.from(value).toString("base64")}`;
const modulePath = (value) => JSON.stringify(new URL(value, import.meta.url).href);
const base = data((await readFile(new URL("../src/voice/voiceClient.js", import.meta.url), "utf8"))
  .replace('"./copy.js"', modulePath("../src/voice/copy.js"))
  .replace('import processorUrl from "./pcm-processor.js?url&no-inline";', 'const processorUrl = "unused-replay";'));
let streaming = (await readFile(new URL("../src/voice/streamingClient.js", import.meta.url), "utf8"))
  .replace('"./voiceClient.js"', JSON.stringify(base));
for (const file of ["copy", "patienceController", "questionBank", "questionClient", "capabilities"]) streaming = streaming.replace(`"./${file}.js"`, modulePath(`../src/voice/${file}.js`));
const adapter = (await readFile(new URL("../src/research/replayClient.js", import.meta.url), "utf8"))
  .replace('"../voice/voiceClient.js"', JSON.stringify(base)).replace('"../voice/streamingClient.js"', JSON.stringify(data(streaming)));
const { createReplayClient, queueReplayFrame } = await import(data(adapter));

function environment() {
  const oldWindow = globalThis.window; const oldWS = globalThis.WebSocket;
  const played = []; const spoken = [];
  class Node extends EventTarget { connect() {} disconnect() {} }
  class Context extends Node {
    constructor() { super(); this.state = "suspended"; this.currentTime = 0; this.destination = new Node(); }
    async resume() { this.state = "running"; } async close() { this.state = "closed"; }
    createBuffer(_channels, length, rate) { return { copyToChannel() {}, duration: length / rate }; }
    createBufferSource() { const node = new Node(); node.start = () => played.push(node); node.stop = () => {}; return node; }
  }
  const synth = new Node(); synth.getVoices = () => [{ lang: "en-MY", localService: true }];
  synth.speak = (utterance) => spoken.push(utterance); synth.cancel = () => {};
  globalThis.window = { AudioContext: Context, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: synth, setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout };
  globalThis.WebSocket = { OPEN: 1, CLOSING: 2 };
  return { played, spoken, synth, restore: () => { globalThis.window = oldWindow; globalThis.WebSocket = oldWS; } };
}
const message = (client, value) => client.handleMessage({ data: JSON.stringify(value) });

for (const mode of ["baseline", "patient", "streaming"]) {
  test(`replay ${mode} uses production configuration and no microphone capture`, async () => {
    const env = environment(); let client;
    try {
      const records = []; const sent = [];
      client = createReplayClient({ mode, personalised: true, observe: (kind) => records.push(kind) });
      await client.prepareAudio(new AbortController().signal);
      assert.equal(client.mediaStream, null); assert.equal(client.worklet, null); assert.equal(client.mediaSource, null);
      client.socket = { readyState: 1, bufferedAmount: 0, send: (value) => sent.push(value), close() {} };
      client.configureSocket();
      if (mode !== "streaming") {
        const config = JSON.parse(sent[0]).session;
        if (mode === "patient") assert.deepEqual(config.input.turn_detection, { min_silence: 1200, max_silence: 6000, interrupt_response: true });
        else assert.equal(Object.hasOwn(config.input, "turn_detection"), false);
        message(client, { type: "session.ready", config });
        assert.equal(client.replayGreetingIdle, false);
        message(client, { type: "reply.started" });
        message(client, { type: "reply.audio", data: "AAAAAA==" });
        message(client, { type: "reply.done", status: "failed" });
        assert.equal(client.replayGreetingDone, false);
        message(client, { type: "reply.done", status: "completed" });
        assert.equal(client.replayGreetingIdle, false);
        for (const output of env.played) output.dispatchEvent(new Event("ended"));
      } else {
        assert.equal(client.personalised, false);
        assert.equal(client.socketUrl("synthetic-token-only").searchParams.get("sample_rate"), "16000");
        message(client, { type: "Begin", configuration: { model: "universal-3-5-pro", mode: "max_accuracy" } });
        await Promise.resolve();
        assert.equal(client.replayGreetingIdle, false); const speech = env.spoken[0];
        speech.onstart(); speech.onend();
        assert.equal(client.replayConfiguration.controlApplication, "unconfirmed");
      }
      assert.equal(client.replayGreetingIdle, true);
      const size = mode === "streaming" ? 1600 : 2400;
      assert.equal(queueReplayFrame(client, new ArrayBuffer(size)), true);
      if (mode === "streaming") assert.equal(sent.at(-1).byteLength, 1600);
      else assert.equal(Buffer.from(JSON.parse(sent.at(-1)).audio, "base64").length, 2400);
      assert.throws(() => queueReplayFrame(client, new ArrayBuffer(size - 2)));
      client.socket.bufferedAmount = client.captureSampleRate + 1;
      assert.throws(() => queueReplayFrame(client, new ArrayBuffer(size)));
      assert.doesNotMatch(JSON.stringify(records), /synthetic-token|remember|greeting|PRIVATE/);
    } finally { client?.dispose(); env.restore(); }
  });
}

test("unknown arm is rejected instead of enabling personalized questions", () => {
  assert.throws(() => createReplayClient({ mode: "bank" }));
});
test("missing local TTS fails before any capture or network", async () => {
  const env = environment(); const client = createReplayClient({ mode: "streaming" });
  try {
    window.SpeechSynthesisUtterance = undefined;
    await assert.rejects(client.prepareAudio(new AbortController().signal), /speech/);
    assert.equal(client.audioContext, null); assert.equal(client.socket, null);
  } finally { client.dispose(); env.restore(); }
});
test("provider fields are allowlisted in configuration receipt", async () => {
  const env = environment(); const client = createReplayClient({ mode: "baseline" });
  try {
    await client.prepareAudio(new AbortController().signal);
    message(client, { type: "session.ready", config: { token: "PRIVATE", system_prompt: "PRIVATE", input: { transcription_mode: "PRIVATE", turn_detection: { min_silence: -1, max_silence: "PRIVATE" } }, output: { voice: "PRIVATE" } } });
    assert.doesNotMatch(JSON.stringify(client.replayConfiguration), /PRIVATE/);
    assert.equal(client.replayConfiguration.minSilenceMs, null);
  } finally { client.dispose(); env.restore(); }
});
