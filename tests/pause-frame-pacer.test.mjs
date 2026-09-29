import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFramePacer, validGapSendSpan, MIN_FRAME_SPACING_MS } from "../scripts/pause-frame-pacer.mjs";

function fixture(jitter = () => 0) {
  let clock = 1000; let waits = 0;
  return {
    now: () => clock,
    set: (value) => { clock = value; },
    sleep: async (duration) => { clock += duration + jitter(waits++); },
  };
}

test("anchored deadlines preserve exact 50 ms cadence with a deterministic clock", async () => {
  const time = fixture(); const pacer = createFramePacer(time); const sent = [];
  for (let i = 0; i <= 100; i++) await pacer.send((receipt) => sent.push(receipt));
  assert.equal(sent[100].sentAtMs - sent[0].sentAtMs, 5000);
  assert.ok(sent.every((receipt, i) => receipt.scheduledAtMs === 1000 + i * 50 && receipt.latenessMs === 0));
  assert.deepEqual(pacer.snapshot(), { framesSent: 101, maxLatenessMs: 0, minSpacingMs: 50 });
});

test("repeated 9 ms timer overshoot no longer inflates a five-second gap to 5900 ms", async () => {
  const time = fixture(() => 9); const pacer = createFramePacer(time); const times = [];
  for (let i = 0; i <= 100; i++) await pacer.send(({ sentAtMs }) => times.push(sentAtMs));
  assert.equal(times[100] - times[0], 5009);
  assert.equal(pacer.snapshot().maxLatenessMs, 9);
  assert.ok(pacer.snapshot().minSpacingMs >= MIN_FRAME_SPACING_MS);
  assert.ok(validGapSendSpan(times[100] - times[0]));
});

test("phase changes use actual sends on one schedule, including clause prefix and 100 zero frames", async () => {
  const time = fixture((i) => [9, 4, 0, 8][i % 4]); const pacer = createFramePacer(time);
  const phases = []; let gapStart; let gapEnd;
  for (let i = 0; i < 231; i++) {
    const phase = i < 60 ? "a" : i < 160 ? "gap" : "b";
    const receipt = await pacer.send(({ index, sentAtMs }) => {
      phases.push(phase);
      if (index === 60) gapStart = sentAtMs;
      if (index === 160) gapEnd = sentAtMs;
    });
    assert.equal(receipt.index, i);
  }
  assert.equal(phases.filter((phase) => phase === "gap").length, 100);
  assert.ok(validGapSendSpan(gapEnd - gapStart));
  assert.ok(pacer.snapshot().maxLatenessMs < 100);
});

test("a 100 ms late frame recovers gradually without back-to-back catch-up sends", async () => {
  const time = fixture((i) => i === 0 ? 100 : 0); const pacer = createFramePacer(time); const times = [];
  for (let i = 0; i < 15; i++) await pacer.send(({ sentAtMs }) => times.push(sentAtMs));
  assert.equal(pacer.snapshot().maxLatenessMs, 100);
  assert.equal(pacer.snapshot().minSpacingMs, 40);
  assert.ok(times.slice(1).every((stamp, i) => stamp - times[i] >= 40));
  assert.equal(times.at(-1), 1000 + 14 * 50);
});

test("a stalled wake beyond 100 ms cumulative lateness aborts before sending the stale frame", async () => {
  const time = fixture(() => 101); const pacer = createFramePacer(time); let sent = 0;
  await pacer.send(() => { sent++; });
  await assert.rejects(pacer.send(() => { sent++; }), { code: "pacing_lag" });
  assert.equal(sent, 1);
  assert.equal(pacer.snapshot().maxLatenessMs, 101);
  await assert.rejects(pacer.send(() => { sent++; }), { code: "pacing_stopped" });
});

test("persistent underspeed fails on cumulative lateness even though every timer overshoot is small", async () => {
  const time = fixture(() => 15); const pacer = createFramePacer(time);
  await assert.rejects(async () => { for (let i = 0; i < 50; i++) await pacer.send(() => {}); }, { code: "pacing_lag" });
  assert.ok(pacer.snapshot().framesSent < 50);
  assert.ok(pacer.snapshot().maxLatenessMs > 100);
});

test("pre-abort and abort during a wait cannot send another frame", async () => {
  const pre = new AbortController(); pre.abort();
  await assert.rejects(createFramePacer({ ...fixture(), signal: pre.signal }).send(() => assert.fail()), { code: "pacing_aborted" });
  const controller = new AbortController(); const time = fixture(); let sent = 0;
  const pacer = createFramePacer({ now: time.now, signal: controller.signal,
    sleep: async (duration) => { await time.sleep(duration); controller.abort(); } });
  await pacer.send(() => { sent++; });
  await assert.rejects(pacer.send(() => { sent++; }), { code: "pacing_aborted" });
  assert.equal(sent, 1);
});

test("invalid/backwards clocks and concurrent sends fail closed", async () => {
  await assert.rejects(createFramePacer({ now: () => NaN }).send(() => assert.fail()), { code: "pacing_clock" });
  const time = fixture(); const pacer = createFramePacer(time); await pacer.send(() => {});
  time.set(999);
  await assert.rejects(pacer.send(() => assert.fail()), { code: "pacing_clock" });
  let wake; let clock = 0;
  const concurrent = createFramePacer({ now: () => clock, sleep: () => new Promise((resolve) => { wake = resolve; }) });
  await concurrent.send(() => {});
  const pending = concurrent.send(() => {});
  await assert.rejects(concurrent.send(() => assert.fail()), { code: "pacing_concurrent" });
  clock = 50; wake(); await pending;
  assert.equal(concurrent.snapshot().framesSent, 2);
});

test("each gap independently requires 5000±100 ms, not merely matching another bad gap", () => {
  for (const value of [4900, 5000, 5100]) assert.equal(validGapSendSpan(value), true);
  for (const value of [null, NaN, Infinity, 4899.999, 5100.001, 5899]) assert.equal(validGapSendSpan(value), false);
});

test("runner uses scheduled phase callbacks, keeps quota checkpoint, and excludes the private pacer from deployment", async () => {
  const runner = await readFile(new URL("../scripts/qa-provider-pause.mjs", import.meta.url), "utf8");
  const ignore = await readFile(new URL("../.vercelignore", import.meta.url), "utf8");
  assert.match(runner, /return pacer\.send\(\(\{ sentAtMs \}\) =>/);
  assert.match(runner, /gapStartAt = sentAtMs/);
  assert.match(runner, /validGapSendSpan\(sentAtMs - gapStartAt\)/);
  assert.match(runner, /run\.gapSendSpanValid && validGapSendSpan\(run\.actualGapSendSpanMs\)/);
  assert.match(runner, /args\[6\] === "4"/);
  assert.match(runner, /SUARA_DAILY_TOKEN_LIMIT === "6"/);
  assert.doesNotMatch(runner, /lastSent \+ 50/);
  assert.ok(ignore.split(/\r?\n/).includes("scripts/pause-frame-pacer.mjs"));
});
