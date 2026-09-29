import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { replayFrames, ReplayError, REPLAY_ERROR_CODES } from "../src/research/replayPacer.js";

function source(chunkCount = 4, overrides = {}) {
  return { metadata: { chunkCount, chunkMs: 50, sourceFrames: chunkCount * 2400, sourceRateHz: 48000 },
    frameAt(rateHz) { return new ArrayBuffer(rateHz / 20 * 2); }, ...overrides };
}
function fixture(jitter = () => 0) {
  let clock = 1000;
  let waits = 0;
  const times = [];
  return { now: () => clock, sleep: async (duration) => { clock += duration + jitter(waits++); },
    sendFrame(frame) { times.push({ at: clock, bytes: frame.byteLength }); return true; },
    advance(ms) { clock += ms; }, set(value) { clock = value; }, times,
  };
}
function expectedError(code, framesSent = undefined) {
  return (error) => {
    assert.equal(error instanceof ReplayError, true);
    assert.equal(error.code, code); assert.equal(error.message, code); assert.equal(error.cause, undefined);
    assert.equal(error.partial.inputComplete, false);
    assert.equal(error.snapshot, error.partial);
    assert.equal(Object.isFrozen(error.partial), true);
    assert.equal(Object.isFrozen(error.partial.sendObservations), true);
    if (framesSent !== undefined) assert.equal(error.partial.framesSent, framesSent);
    assert.equal(JSON.stringify(error).includes("PRIVATE"), false);
    return true;
  };
}

for (const rateHz of [16000, 24000]) {
  test(`${rateHz} Hz replay sends exact sequential frames against one absolute source-time schedule`, async () => {
    const time = fixture(); const reads = []; const progress = [];
    const input = source(4, { frameAt(rate, index) { reads.push({ rate, index }); return new ArrayBuffer(rate / 20 * 2); } });
    const result = await replayFrames({ source: input, rateHz, ...time, onProgress: (event) => progress.push(event) });
    assert.deepEqual(time.times, [0, 50, 100, 150].map((at) => ({ at: at + 1000, bytes: rateHz / 20 * 2 })));
    assert.deepEqual(reads, [0, 1, 2, 3].map((index) => ({ rate: rateHz, index })));
    assert.equal(result.inputComplete, true); assert.equal(result.framesSent, 4);
    assert.equal(result.originMs, 1000);
    assert.equal(result.submittedSourceFrames, 9600); assert.equal(result.elapsedMs, 200);
    assert.equal(result.maxLatenessMs, 0); assert.equal(result.minSpacingMs, 50);
    assert.deepEqual(result.sendObservations[1], { index: 1, sourceStartFrame: 2400, sourceEndFrame: 4800,
      scheduledAtMs: 50, sentAtMs: 50, latenessMs: 0, spacingMs: 50 });
    assert.equal(progress.length, 5);
    assert.equal(progress.slice(0, -1).every((event) => event.inputComplete === false), true);
    assert.equal(progress.at(-1).inputComplete, true);
    assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.sendObservations[0]), true);
  });
}

test("source preparation precedes frame-zero anchor, so initial retrieval is not falsely counted as send delay", async () => {
  const time = fixture();
  const result = await replayFrames({ source: source(2, { frameAt(rate, index) {
    if (!index) time.advance(100); return new ArrayBuffer(rate / 20 * 2);
  } }), rateHz: 16000, ...time });
  assert.deepEqual(time.times.map((entry) => entry.at), [1100, 1150]);
  assert.equal(result.originMs, 1100);
  assert.equal(result.sendObservations[0].sentAtMs, 0); assert.equal(result.elapsedMs, 100);
});

test("the same approved source can be reused by distinct non-resumable comparison invocations", async () => {
  const input = source(2);
  const a = await replayFrames({ source: input, rateHz: 16000, ...fixture() });
  const b = await replayFrames({ source: input, rateHz: 24000, ...fixture() });
  assert.deepEqual(a, b);
});

test("invalid metadata, callback types and sample rates fail before source retrieval or send", async () => {
  let reads = 0; let sends = 0;
  const valid = source(2, { frameAt() { reads += 1; return new ArrayBuffer(1600); } });
  const base = { source: valid, rateHz: 16000, ...fixture(), sendFrame() { sends += 1; return true; } };
  for (const fields of [
    { source: null }, { rateHz: "16000" }, { rateHz: 48000 }, { now: null }, { sleep: 1 }, { onProgress: false }, { sendFrame: null },
    ...[{ chunkCount: 0 }, { chunkCount: 1401 }, { chunkCount: 1.5 }, { chunkMs: "50" }, { chunkMs: 49 },
      { sourceFrames: 4799 }, { sourceRateHz: 44100 }, { sourceRateHz: "48000" }].map((metadata) => ({
      source: { ...valid, metadata: { ...valid.metadata, ...metadata } },
    })),
    { source: { ...valid, frameAt: null } }, { signal: {} }, { signal: null },
  ]) await assert.rejects(replayFrames({ ...base, ...fields }), expectedError("replay_configuration", 0));
  for (const input of [null, [], "PRIVATE", { get source() { throw new Error("PRIVATE"); } }])
    await assert.rejects(replayFrames(input), expectedError("replay_configuration", 0));
  assert.equal(reads, 0); assert.equal(sends, 0);
});

test("augmented timeline permits exactly 1400 chunks and retains at most 1400 observations", async () => {
  const result = await replayFrames({ source: source(1400), rateHz: 16000, ...fixture() });
  assert.equal(result.framesSent, 1400); assert.equal(result.sendObservations.length, 1400);
  assert.equal(result.submittedSourceFrames, 3_360_000); assert.equal(result.elapsedMs, 70000);
  assert.equal(result.sendObservations.at(-1).sourceEndFrame, result.submittedSourceFrames);
});

test("scalar metadata is captured once and cannot expand the bounded run during validation", async () => {
  let reads = 0;
  const input = source(1);
  Object.defineProperty(input.metadata, "chunkCount", { get() { return ++reads === 1 ? 1 : 100000; } });
  const result = await replayFrames({ source: input, rateHz: 16000, ...fixture() });
  assert.equal(reads, 1); assert.equal(result.framesSent, 1);
});

test("repeated ordinary timer jitter does not accumulate one relative sleep per frame", async () => {
  const time = fixture(() => 9);
  const result = await replayFrames({ source: source(101), rateHz: 16000, ...time });
  assert.equal(time.times.at(-1).at - time.times[0].at, 5009);
  assert.equal(result.maxLatenessMs, 18); // Last chunk gets 50 ms plus the final wake's 9 ms.
  assert.ok(result.minSpacingMs >= 40); assert.equal(result.elapsedMs, 5068);
});

test("a frame exactly 100 ms late recovers gradually without catch-up bursts", async () => {
  const time = fixture((index) => index === 0 ? 100 : 0);
  const result = await replayFrames({ source: source(15), rateHz: 16000, ...time });
  assert.equal(result.maxLatenessMs, 100); assert.equal(result.minSpacingMs, 40);
  assert.ok(time.times.slice(1).every((entry, index) => entry.at - time.times[index].at >= 40));
  assert.equal(result.sendObservations.at(-1).sentAtMs, 700);
});

test("more than 100 ms lateness rejects before retrieving or sending the stale frame", async () => {
  const time = fixture(() => 101); let reads = 0;
  await assert.rejects(replayFrames({ source: source(5, { frameAt() { reads += 1; return new ArrayBuffer(1600); } }),
    rateHz: 16000, ...time }), expectedError("replay_lag", 1));
  assert.equal(reads, 1); assert.equal(time.times.length, 1);
});

test("slow source retrieval is included in lateness before the frame is sent", async () => {
  const time = fixture();
  await assert.rejects(replayFrames({ source: source(5, { frameAt(rate, index) {
    if (index === 1) time.advance(101); return new ArrayBuffer(1600);
  } }), rateHz: 16000, ...time }), expectedError("replay_lag", 1));
  assert.equal(time.times.length, 1);
});

test("persistent underspeed fails cumulatively rather than replaying a burst", async () => {
  const time = fixture(() => 15);
  await assert.rejects(replayFrames({ source: source(100), rateHz: 16000, ...time }), (error) => {
    expectedError("replay_lag")(error);
    assert.ok(error.partial.framesSent < 100); assert.ok(error.partial.maxLatenessMs > 100); return true;
  });
});

test("early wakes wait again; no-progress sleeper fails instead of spinning or sending early", async () => {
  const time = fixture(); let wakes = 0;
  const result = await replayFrames({ source: source(2), rateHz: 16000, ...time,
    sleep: async (duration) => { wakes += 1; time.advance(wakes === 1 ? 10 : duration); } });
  assert.deepEqual(result.sendObservations.map((item) => item.sentAtMs), [0, 50]);
  await assert.rejects(replayFrames({ source: source(2), rateHz: 16000, ...fixture(), sleep: async () => {} }),
    expectedError("replay_sleep", 1));
});

test("final completion waits fifty milliseconds after even a delayed last accepted send", async () => {
  const time = fixture((index) => index === 0 ? 80 : 0);
  const result = await replayFrames({ source: source(2), rateHz: 16000, ...time });
  assert.equal(result.sendObservations.at(-1).sentAtMs, 130);
  assert.equal(result.elapsedMs, 180); assert.equal(result.inputComplete, true);
  const one = await replayFrames({ source: source(1), rateHz: 16000, ...fixture() });
  assert.equal(one.elapsedMs, 50); assert.equal(one.minSpacingMs, null);
});

test("final completion lateness beyond policy remains incomplete despite all accepted frames", async () => {
  await assert.rejects(replayFrames({ source: source(1), rateHz: 16000, ...fixture(() => 101) }),
    expectedError("replay_lag", 1));
});

test("pre-abort makes no source read or send", async () => {
  const controller = new AbortController(); controller.abort("PRIVATE"); let reads = 0;
  await assert.rejects(replayFrames({ source: source(1, { frameAt() { reads += 1; } }), rateHz: 16000,
    ...fixture(), signal: controller.signal }), expectedError("replay_aborted", 0));
  assert.equal(reads, 0);
});

test("abort during source retrieval prevents any send of that frame", async () => {
  const controller = new AbortController(); const time = fixture();
  await assert.rejects(replayFrames({ source: source(2, { frameAt() {
    controller.abort("PRIVATE"); return new ArrayBuffer(1600);
  } }), rateHz: 16000, ...time, signal: controller.signal }), expectedError("replay_aborted", 0));
  assert.equal(time.times.length, 0);
});

test("abort during an ignored sleep settles promptly and removes its listener", async () => {
  const controller = new AbortController(); let entered;
  const sleeping = new Promise((resolve) => { entered = resolve; });
  const rejected = assert.rejects(replayFrames({ source: source(3), rateHz: 16000, ...fixture(), signal: controller.signal,
    sleep: () => { entered(); return new Promise(() => {}); } }), expectedError("replay_aborted", 1));
  await sleeping; controller.abort("PRIVATE"); await rejected;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("a known accepted send remains in the source cursor when it synchronously triggers cancellation", async () => {
  const controller = new AbortController();
  await assert.rejects(replayFrames({ source: source(2), rateHz: 16000, ...fixture(), signal: controller.signal,
    sendFrame() { controller.abort(); return true; } }), (error) => {
    expectedError("replay_aborted", 1)(error); assert.equal(error.partial.submittedSourceFrames, 2400); return true;
  });
});

test("false, missing, throwing and asynchronous sends are uncertain and never retried", async () => {
  for (const behavior of [() => false, () => undefined, () => { throw new Error("PRIVATE SEND"); },
    () => Promise.resolve(true), () => Promise.reject(new Error("PRIVATE ASYNC")), () => ({ then() {} })]) {
    let sends = 0;
    await assert.rejects(replayFrames({ source: source(3), rateHz: 16000, ...fixture(),
      sendFrame(frame) { sends += 1; return sends === 1 ? true : behavior(frame); } }), expectedError("replay_send_unknown", 1));
    assert.equal(sends, 2);
  }
});

test("invalid, reused or asynchronous source frames fail without incrementing the accepted cursor", async () => {
  const reused = new ArrayBuffer(1600);
  for (const getFrame of [() => new ArrayBuffer(1598), () => new Uint8Array(1600), () => null,
    () => { throw new Error("PRIVATE SOURCE"); }, () => Promise.reject(new Error("PRIVATE ASYNC SOURCE"))]) {
    await assert.rejects(replayFrames({ source: source(2, { frameAt: getFrame }), rateHz: 16000, ...fixture() }),
      expectedError("replay_source", 0));
  }
  await assert.rejects(replayFrames({ source: source(2, { frameAt: () => reused }), rateHz: 16000, ...fixture() }),
    expectedError("replay_source", 1));
});

test("invalid or decreasing clocks fail with only prior safe numeric evidence", async () => {
  for (const now of [() => NaN, () => Infinity, () => -1, () => "0", () => true,
    () => 1e100, () => { throw new Error("PRIVATE CLOCK"); }])
    await assert.rejects(replayFrames({ source: source(2), rateHz: 16000, ...fixture(), now }), expectedError("replay_clock", 0));
  const time = fixture();
  await assert.rejects(replayFrames({ source: source(2), rateHz: 16000, ...time,
    sendFrame() { time.set(999); return true; } }), expectedError("replay_clock", 1));
});

test("progress callbacks receive immutable content-free snapshots and failure is terminal", async () => {
  const time = fixture(); let calls = 0;
  await assert.rejects(replayFrames({ source: source(3, { privateText: "PRIVATE_SOURCE" }), rateHz: 16000, ...time,
    onProgress(value) {
      calls += 1; assert.equal(JSON.stringify(value).includes("PRIVATE"), false);
      assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.sendObservations[0]), true);
      throw new Error("PRIVATE PROGRESS");
    } }), expectedError("replay_progress", 1));
  assert.equal(calls, 1); assert.equal(time.times.length, 1);
  await assert.rejects(replayFrames({ source: source(2), rateHz: 16000, ...fixture(),
    onProgress: () => Promise.reject(new Error("PRIVATE ASYNC PROGRESS")) }), expectedError("replay_progress", 1));
});

test("progress failure at completion does not return a complete replay", async () => {
  await assert.rejects(replayFrames({ source: source(1), rateHz: 16000, ...fixture(),
    onProgress(value) { if (value.inputComplete) throw new Error("PRIVATE"); } }), expectedError("replay_progress", 1));
});

test("default browser sleep waits asynchronously and abort cleanup prevents a late send", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController(); let sends = 0;
  const rejected = assert.rejects(replayFrames({ source: source(2), rateHz: 16000, now: () => 0,
    signal: controller.signal, sendFrame() { sends += 1; return true; } }), expectedError("replay_aborted", 1));
  assert.equal(sends, 1);
  controller.abort(); await rejected; t.mock.timers.tick(1000); await new Promise(setImmediate);
  assert.equal(sends, 1); assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("default browser sleep completes only after the full last-chunk duration", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController(); let clock = 1000; let finished = false;
  const pending = replayFrames({ source: source(1), rateHz: 16000, now: () => clock,
    signal: controller.signal, sendFrame: () => true }).then((result) => { finished = true; return result; });
  clock += 49; t.mock.timers.tick(49); await new Promise(setImmediate);
  assert.equal(finished, false);
  clock += 1; t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.elapsedMs, 50); assert.equal(result.inputComplete, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("error code vocabulary is finite and never accepts arbitrary provider/error content", () => {
  assert.equal(Object.isFrozen(REPLAY_ERROR_CODES), true);
  assert.equal(new ReplayError("PRIVATE", {}).code, "replay_failure");
});
