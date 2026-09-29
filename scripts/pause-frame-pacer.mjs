import { setTimeout as delay } from "node:timers/promises";

// Private offline/live-harness scheduler, not a production voice component.
export const FRAME_PERIOD_MS = 50;
export const MIN_FRAME_SPACING_MS = 40;
export const MAX_CUMULATIVE_LATENESS_MS = 100;

export class PacingError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new PacingError(code); };

export function validGapSendSpan(span) {
  return typeof span === "number" && Number.isFinite(span) && Math.abs(span - 5_000) <= 100;
}

// Deadlines stay anchored to frame zero, rather than drifting with timer wakes.
// A 40 ms floor permits bounded recovery from ordinary timer jitter but forbids
// immediate catch-up bursts. A late frame (>100 ms from its ORIGINAL deadline)
// is never sent. Callbacks are synchronous, so phase marking and sending share
// the same clock sample. No network, payload, files, credentials or content here.
export function createFramePacer({
  now = () => performance.now(),
  sleep = (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
  signal,
} = {}) {
  if (typeof now !== "function" || typeof sleep !== "function") fail("pacing_configuration");
  let origin = null;
  let previousClock = -Infinity;
  let lastSent = null;
  let frameIndex = 0;
  let maxLateness = 0;
  let minSpacing = null;
  let pending = false;
  let stopped = false;
  function clock() {
    const value = now();
    if (!Number.isFinite(value) || value < 0 || value < previousClock) fail("pacing_clock");
    previousClock = value;
    return value;
  }
  const active = () => { if (signal?.aborted) fail("pacing_aborted"); };
  return Object.freeze({
    async send(sendFrame) {
      if (stopped) fail("pacing_stopped");
      if (pending) fail("pacing_concurrent");
      if (typeof sendFrame !== "function") fail("pacing_configuration");
      pending = true;
      try {
        active();
        let actual = clock();
        if (origin === null) origin = actual;
        const scheduled = origin + frameIndex * FRAME_PERIOD_MS;
        const earliest = Math.max(scheduled, lastSent === null ? scheduled : lastSent + MIN_FRAME_SPACING_MS);
        while (actual < earliest) {
          await sleep(Math.max(1, Math.ceil(earliest - actual)), signal);
          active();
          actual = clock();
        }
        active();
        const lateness = actual - scheduled;
        maxLateness = Math.max(maxLateness, lateness);
        if (lateness > MAX_CUMULATIVE_LATENESS_MS) fail("pacing_lag");
        const spacing = lastSent === null ? null : actual - lastSent;
        const receipt = { index: frameIndex, scheduledAtMs: scheduled, sentAtMs: actual, latenessMs: lateness, spacingMs: spacing };
        const returned = sendFrame(receipt);
        if (returned && typeof returned.then === "function") fail("pacing_async_sender");
        if (spacing !== null) minSpacing = minSpacing === null ? spacing : Math.min(minSpacing, spacing);
        lastSent = actual;
        frameIndex++;
        return receipt;
      } catch (error) {
        stopped = true;
        if (signal?.aborted) fail("pacing_aborted");
        throw error;
      } finally { pending = false; }
    },
    snapshot() {
      return { framesSent: frameIndex, maxLatenessMs: maxLateness, minSpacingMs: minSpacing };
    },
  });
}
