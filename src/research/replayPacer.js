// Browser-compatible operator pacing only: no microphone, provider, file or
// storage access. A send observation means synchronous local queue acceptance,
// not delivery, consumption, matched exposure or acoustic playback. Source frame
// coordinates describe the supplied 48 kHz timeline, including any explicit
// caller-added silence; they do not establish original-recording provenance.
const PERIOD_MS = 50;
const MIN_SPACING_MS = 40;
const MAX_LATENESS_MS = 100;
const SOURCE_FRAMES_PER_CHUNK = 2400;
const MAX_CHUNKS = 1400;
const CLOCK_CEILING = Number.MAX_SAFE_INTEGER - MAX_CHUNKS * PERIOD_MS;
export const REPLAY_ERROR_CODES = Object.freeze([
  "replay_configuration", "replay_clock", "replay_aborted", "replay_source",
  "replay_lag", "replay_sleep", "replay_send_unknown", "replay_progress", "replay_failure",
]);

export class ReplayError extends Error {
  constructor(code, partial) {
    const safeCode = REPLAY_ERROR_CODES.includes(code) ? code : "replay_failure";
    super(safeCode);
    this.name = "ReplayError";
    this.code = safeCode;
    this.partial = partial;
    this.snapshot = partial;
  }
}

function defaultSleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const finish = (aborted) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (aborted) reject(new Error("replay_aborted")); else resolve();
    };
    const cancel = () => finish(true);
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => finish(false), milliseconds);
    if (signal?.aborted) cancel();
  });
}

function discardThenable(value) {
  if (value !== null && (typeof value === "object" || typeof value === "function")
      && typeof value.then === "function") {
    // Invalid asynchronous callbacks must not create unhandled rejections.
    Promise.resolve(value).catch(() => {});
    return true;
  }
  return false;
}

/**
 * One sequential, non-resumable run per invocation. The immutable source may be
 * reused by a separately authorized comparison arm. Never retries any send.
 * Complete 50 ms chunks and at most 1400 content-free observations are retained.
 */
export async function replayFrames(options = {}) {
  let source, rateHz, sendFrame, now, sleep, signal, onProgress, frameAt, chunkCount;
  let origin = null;
  let previousClock = null;
  let lastSent = null;
  let maxLatenessMs = 0;
  let minSpacingMs = null;
  let closed = false;
  const observations = [];
  const seenBuffers = new WeakSet();

  function snapshot(inputComplete = false) {
    return Object.freeze({
      inputComplete,
      // Shared monotonic clock only; caller can map to run-relative receipt time.
      originMs: origin,
      submittedSourceFrames: observations.length * SOURCE_FRAMES_PER_CHUNK,
      framesSent: observations.length,
      maxLatenessMs,
      minSpacingMs,
      elapsedMs: origin === null || previousClock === null ? 0 : previousClock - origin,
      sendObservations: Object.freeze([...observations]),
    });
  }
  function fail(code) { throw new ReplayError(code, snapshot(false)); }
  function active() { if (signal?.aborted) fail("replay_aborted"); }
  function clock() {
    let value;
    try { value = now(); } catch { fail("replay_clock"); }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > CLOCK_CEILING
        || (previousClock !== null && value < previousClock)) fail("replay_clock");
    previousClock = value;
    return value;
  }
  function lateness(actual, scheduled) {
    const value = actual - scheduled;
    maxLatenessMs = Math.max(maxLatenessMs, value);
    if (value > MAX_LATENESS_MS) fail("replay_lag");
    return value;
  }
  function progress(inputComplete) {
    active();
    try { if (discardThenable(onProgress(snapshot(inputComplete)))) fail("replay_progress"); }
    catch { fail("replay_progress"); }
    active();
  }

  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) fail("replay_configuration");
    ({ source, rateHz, sendFrame, now = () => performance.now(), sleep = defaultSleep,
      signal, onProgress = () => {} } = options);
    if (!source || typeof source !== "object" || Array.isArray(source)
        || ![16000, 24000].includes(rateHz) || typeof sendFrame !== "function"
        || typeof now !== "function" || typeof sleep !== "function" || typeof onProgress !== "function"
        || (signal !== undefined && !(signal instanceof AbortSignal))) fail("replay_configuration");
    const metadata = source.metadata;
    frameAt = source.frameAt;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || typeof frameAt !== "function")
      fail("replay_configuration");
    // Capture scalar metadata once so mutable accessors cannot expand a run
    // between validation and iteration. No caller metadata enters snapshots.
    const { chunkCount: count, chunkMs, sourceRateHz, sourceFrames } = metadata;
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CHUNKS
        || chunkMs !== PERIOD_MS || sourceRateHz !== 48000
        || sourceFrames !== count * SOURCE_FRAMES_PER_CHUNK) fail("replay_configuration");
    chunkCount = count;
  } catch { fail("replay_configuration"); }

  let rejectAborted;
  const aborted = new Promise((_resolve, reject) => { rejectAborted = reject; });
  // A signal may cancel during source retrieval or sending, before the first
  // sleep attaches to this promise. Install a rejection handler immediately.
  aborted.catch(() => {});
  const cancelled = () => { if (!closed) rejectAborted(new ReplayError("replay_aborted", snapshot(false))); };

  async function waitUntil(earliest) {
    let actual = clock();
    let wakes = 0;
    while (actual < earliest) {
      active();
      if (++wakes > 100) fail("replay_sleep");
      const before = actual;
      try { await Promise.race([Promise.resolve(sleep(Math.max(1, Math.ceil(earliest - actual)), signal)), aborted]); }
      catch { if (signal?.aborted) fail("replay_aborted"); fail("replay_sleep"); }
      active();
      actual = clock();
      // No-progress custom sleepers must not spin in microtasks and starve the UI.
      if (actual <= before) fail("replay_sleep");
    }
    active();
    return actual;
  }

  try {
    signal?.addEventListener("abort", cancelled, { once: true });
    active();
    for (let index = 0; index < chunkCount; index += 1) {
      active();
      if (origin !== null) {
        const scheduled = origin + index * PERIOD_MS;
        const actual = await waitUntil(Math.max(scheduled, lastSent + MIN_SPACING_MS));
        lateness(actual, scheduled);
      } else clock();

      active();
      let frame;
      try {
        frame = frameAt.call(source, rateHz, index);
        if (discardThenable(frame) || !(frame instanceof ArrayBuffer)
            || frame.byteLength !== rateHz / 20 * 2 || seenBuffers.has(frame)) fail("replay_source");
      } catch { fail("replay_source"); }
      active();
      seenBuffers.add(frame);
      const actual = clock();
      if (origin === null) origin = actual;
      const scheduled = origin + index * PERIOD_MS;
      const late = lateness(actual, scheduled);
      const spacing = lastSent === null ? null : actual - lastSent;
      if (spacing !== null && spacing < MIN_SPACING_MS) fail("replay_lag");
      active();
      try {
        const result = sendFrame(frame);
        if (discardThenable(result) || result !== true) fail("replay_send_unknown");
      } catch { fail("replay_send_unknown"); }

      // Record known local acceptance before checking a cancellation/clock error
      // raised during send. Such a frame must not disappear from the safe cursor.
      observations.push(Object.freeze({
        index, sourceStartFrame: index * SOURCE_FRAMES_PER_CHUNK,
        sourceEndFrame: (index + 1) * SOURCE_FRAMES_PER_CHUNK,
        scheduledAtMs: index * PERIOD_MS, sentAtMs: actual - origin,
        latenessMs: late, spacingMs: spacing,
      }));
      if (spacing !== null) minSpacingMs = minSpacingMs === null ? spacing : Math.min(minSpacingMs, spacing);
      lastSent = actual;
      active();
      clock();
      progress(false);
    }

    // A delayed final send still receives its full final 50 ms. This is elapsed
    // input-scheduling time only, not proof that the provider consumed the frame.
    const endDeadline = origin + chunkCount * PERIOD_MS;
    const completedAt = await waitUntil(Math.max(endDeadline, lastSent + PERIOD_MS));
    lateness(completedAt, endDeadline);
    progress(true);
    active();
    clock();
    // An expensive progress callback can itself exceed the bounded schedule.
    lateness(previousClock, endDeadline);
    return snapshot(true);
  } finally {
    closed = true;
    signal?.removeEventListener("abort", cancelled);
  }
}
