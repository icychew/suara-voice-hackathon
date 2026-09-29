import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// Only bypass the Vite-only client import. Production controller + pacer run
// unchanged; transport is injected and is explicitly not provider evidence.
const code = (await readFile(new URL("../src/research/replayRun.js", import.meta.url), "utf8"))
  .replace('import { createReplayClient, queueReplayFrame } from "./replayClient.js";', 'const createReplayClient = () => { throw new Error("no live client"); }; const queueReplayFrame = () => false;')
  .replace('"./replayPacer.js"', JSON.stringify(new URL("../src/research/replayPacer.js", import.meta.url).href));
const { ReplayRun } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const metadata = { schema: 1, sourceSha256: "a".repeat(64), sourceRateHz: 48000, sourceFrames: 4800,
  durationMs: 100, chunkMs: 50, chunkCount: 2, conversion: "fir63-hamming-causal-v1", filterDelaySourceFrames: 31 };
const source = { metadata, frameAt: (rate) => new ArrayBuffer(rate / 10) };

function harness(options = {}) {
  let clock = 100; const updates = []; const sent = []; let client;
  const run = new ReplayRun({ mode: options.mode || "baseline", source, accessCode: "synthetic-replay-code-only", consent: true,
    now: () => clock, sleep: async (ms, signal) => { if (signal?.aborted) throw new Error("abort"); clock += ms; },
    onUpdate: (event) => { updates.push(event); options.onUpdate?.(event, run); },
    clientFactory: (args) => {
      client = { captureSampleRate: args.mode === "streaming" ? 16000 : 24000, isReady: true, isEnding: false, isCleanedUp: false,
        replyInProgress: false, playbackSources: new Set(), speech: null, pendingQuestion: null, providerEnded: false,
        replayGreetingIdle: options.noGreeting !== true, replayConfiguration: { protocol: "fixture" },
        async start() { args.observe("configuration_received"); options.start?.(args, client, run); },
        async end() { this.isEnding = true; this.providerEnded = options.noAck !== true; this.isCleanedUp = true; },
        dispose() { this.isCleanedUp = true; this.isReady = false; this.disposed = true; }, args,
      };
      return client;
    },
    send: (target, frame) => {
      sent.push(frame.byteLength);
      if (sent.length === 2 && !options.noFinal) target.args.observe("user_final_received");
      if (options.stopAt === sent.length) run.stop();
      if (options.throwAt === sent.length) throw new Error("PRIVATE wire token/audio");
      return true;
    }, ...options.overrides,
  });
  return { run, sent, updates, client: () => client, clock: () => clock };
}

for (const mode of ["baseline", "patient", "streaming"]) {
  test(`real pacer + runner completes ${mode} with explicit equal tail`, async () => {
    const h = harness({ mode });
    const report = await h.run.start();
    assert.equal(report.status, "complete"); assert.equal(report.error, null);
    assert.equal(report.cleanEnd, true); assert.equal(report.inputComplete, true);
    assert.equal(report.replay.framesSent, 202); assert.equal(report.replay.submittedSourceFrames, 484800);
    assert.equal(report.appendedSilenceFrames, 480000); assert.equal(report.source.sourceFrames, 4800);
    assert.ok(h.sent.every((bytes) => bytes === (mode === "streaming" ? 1600 : 2400)));
    assert.equal(report.replay.elapsedMs, 10100); assert.equal(h.clock(), 10700);
    assert.equal(h.client().args.personalised, false); assert.equal(h.client().disposed, true);
    assert.equal(report.events.find((event) => event.kind === "user_final_received").submittedSourceFrames, 2400);
    assert.equal(report.interpretation, "transport_observations_only");
    assert.doesNotMatch(JSON.stringify(report), /synthetic-replay-code-only|PRIVATE|token|transcript text/);
    assert.equal(h.run.accessCode, ""); assert.equal(h.run.source, null);
    await assert.rejects(h.run.start());
  });
}

test("no greeting means no input and bounded failed run", async () => {
  const h = harness({ noGreeting: true }); const report = await h.run.start();
  assert.equal(h.sent.length, 0); assert.equal(report.error, "greeting_timeout");
  assert.equal(report.inputComplete, false); assert.equal(h.client().disposed, true);
});
test("uncertain send never retries or automatically starts another arm", async () => {
  const h = harness({ throwAt: 3 }); const report = await h.run.start();
  assert.equal(h.sent.length, 3); assert.equal(report.error, "pacing_failed");
  assert.equal(report.replay.framesSent, 2); assert.equal(report.inputComplete, false);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|wire token/);
});
test("stop revokes sending and releases all resources", async () => {
  const h = harness({ stopAt: 4 }); const report = await h.run.start();
  assert.equal(h.sent.length, 4); assert.equal(report.error, "cancelled");
  assert.equal(report.status, "inconclusive"); assert.equal(h.client().disposed, true);
});
test("a clean transport without a final transcript is not marked complete", async () => {
  const report = await harness({ noFinal: true }).run.start();
  assert.equal(report.inputComplete, true); assert.equal(report.cleanEnd, true);
  assert.equal(report.status, "inconclusive"); assert.equal(report.error, "no_final_transcript");
});
test("missing termination acknowledgement is not clean ending", async () => {
  const report = await harness({ noAck: true }).run.start();
  assert.equal(report.cleanEnd, false); assert.equal(report.error, "unclean_end");
});
test("provider controlled fields never enter content-free observations", async () => {
  const h = harness({ start: (args) => {
    args.observe("PRIVATE token or text"); args.onTiming({ type: "ready", token: "PRIVATE", transcript: "PRIVATE" });
    args.onEvent({ type: "user-transcript", text: "PRIVATE" });
  } });
  assert.doesNotMatch(JSON.stringify(await h.run.start()), /PRIVATE/);
});
test("bounded observation overflow is explicitly inconclusive", async () => {
  const h = harness({ start: (args) => { for (let i = 0; i < 4100; i++) args.observe("provider_receipt:Turn.partial"); } });
  const report = await h.run.start();
  assert.equal(report.events.length, 4096); assert.equal(report.eventsTruncated, true); assert.equal(report.error, "event_limit");
});
test("invalid consent, mode, code and source fail before any client or send", () => {
  for (const overrides of [{ consent: false }, { mode: "bank" }, { accessCode: "" }, { source: { ...source, metadata: { ...metadata, chunkCount: 10000 } } }]) {
    assert.throws(() => harness({ overrides }), /configuration/);
  }
});
test("dispose before starting never obtains a provider token", async () => {
  const h = harness(); h.run.dispose(); await assert.rejects(h.run.start()); assert.equal(h.client(), undefined);
});
