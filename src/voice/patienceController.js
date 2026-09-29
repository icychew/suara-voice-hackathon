/**
 * Experimental, provider-I/O-free S1/S3 request controller.
 *
 * A proposal is not a send or acknowledgement. Even submitted proposals have
 * unconfirmed application status; mid-stream requests cannot undo prior audio.
 * Text cues are hypotheses, not calibrated probabilities of speaker intent.
 * Internal word gaps are a truncated sample: they can support an experimental
 * widening candidate, never confidence, tightening, or an inferred forced end.
 * The 10,000 ms ceiling is local Suara policy, not an asserted provider limit.
 */

const WINDOW = 60;
const MIN_SAMPLES = 12;
const RHYTHM_FLOOR_MS = 250;
const MARGIN_MS = 1200;
const COOLDOWN_MS = 500;
const MAX_WORDS = 10000;
const MAX_TRANSCRIPT_LENGTH = 32000;
const CJK = /[\u4e00-\u9fff]/u;
const PUNCTUATION = /\p{P}$/u;
const CONNECTOR = /\p{Pc}$/u;
const WORD_JOINER = /[\p{L}\p{N}\p{M}\p{Pc}\p{Pd}'’]$/u;

const CONTINUE_EN = [
  'and then', 'and', 'then', 'so', 'because', 'but', 'after that', 'after',
  'before', 'when', 'while', 'until', 'since', 'although', 'the thing is',
  'you know', 'actually', 'last time', 'that time', 'at that time', 'next thing',
  'and also', 'also', 'plus', 'or', 'which', 'who', 'that', 'if', 'unless',
  'even though', 'as for',
].sort((a, b) => b.length - a.length);
const CONTINUE_ZH = [
  '然后', '所以', '因为', '但是', '可是', '不过', '后来', '还有', '而且', '那个',
  '就是', '那时候', '当时', '接着', '跟着', '结果', '其实', '虽然', '如果',
  '要是', '除了', '另外', '至于',
].sort((a, b) => b.length - a.length);
const FILLERS = ['umm', 'um', 'uh', 'er', 'eh', 'mm', '那个', '这个', 'itu', 'apa'];
const DANGLING = [
  'she', 'he', 'they', 'we', 'i', 'it', 'you', 'my', 'his', 'her', 'their',
  'our', 'the', 'a', 'an', 'this', 'that', 'these', 'those', 'is', 'was', 'were',
  'are', 'had', 'has', 'have', 'will', 'would', 'can', 'cannot', 'must', 'got',
  'very', 'more', 'one of', 'some of', 'to', 'for', 'with', 'from', 'at', 'in',
  'on', 'of', 'by', 'about', '我', '他', '她', '我们', '他们', '的', '把', '被', '跟', '对',
].sort((a, b) => b.length - a.length);
const COMPLETION = [
  "that's all", 'thats all', "that's it", 'thats it', "that's the whole thing",
  "so that's how", 'and that was it', 'finished', 'nothing else', 'no more',
  'up to now', 'until now', "that's my story", 'end of story', '就这样',
  '就是这样', '没有了', '完了', '差不多', '讲完了', '说完了', '就酱', '到这里',
  '这样而已', '没有什么了',
];
const PARTICLES = [
  ['ah', 0.55], ['hor', 0.30], ['eh', 0.45], ['lah', -0.55], ['lor', -0.50],
  ['loh', -0.50], ['meh', -0.25], ['mah', -0.20], ['one', -0.35],
  ['already', -0.30], ['ya', -0.15], ['咯', -0.45], ['啦', -0.55],
  ['咧', 0.25], ['嘛', -0.20], ['吧', -0.20], ['呢', 0.30],
];

function validInteger(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function thresholds(minimum, maximum) {
  if (!validInteger(minimum, 50, 10000) || !validInteger(maximum, 50, 10000)
      || minimum >= maximum) {
    throw new RangeError('Thresholds must be ordered integer milliseconds in 50..10000.');
  }
  return Object.freeze({ minimum, maximum });
}

function matchesTail(text, marker) {
  if (CJK.test(marker)) return text.endsWith(marker);
  // Whitespace is collapsed before matching. Marker lists contain no dynamic
  // regular expressions; a Latin marker must not be part of a longer word.
  if (!text.endsWith(marker)) return false;
  const start = text.length - marker.length;
  // Inspect a Unicode code point, not the final UTF-16 surrogate of one.
  return start === 0 || !WORD_JOINER.test(text.slice(0, start));
}

/** Scalar-only heuristic score; never returns or retains transcript content. */
export function scorePatienceMarkers(transcript) {
  if (typeof transcript !== 'string' || transcript.length > MAX_TRANSCRIPT_LENGTH) {
    throw new TypeError('Partial transcript must be a string of at most 32000 characters.');
  }
  let tail = transcript.trim().toLowerCase();
  while (PUNCTUATION.test(tail) && !CONNECTOR.test(tail)) {
    tail = tail.replace(/\p{P}$/u, '').trimEnd();
  }
  if (!tail) return 0;
  tail = tail.replace(/\s+/gu, ' ');
  let score = 0;
  let hasCue = false;
  let hasContinuation = false;
  const particle = PARTICLES.find(([marker]) => matchesTail(tail, marker));
  if (particle) {
    score += particle[1];
    hasCue = true;
  }
  if (FILLERS.some((marker) => matchesTail(tail, marker))) {
    score += 0.50;
    hasCue = true;
    hasContinuation = true;
  }
  if (CONTINUE_EN.some((marker) => matchesTail(tail, marker))
      || CONTINUE_ZH.some((marker) => matchesTail(tail, marker))) {
    score += 0.70;
    hasCue = true;
    hasContinuation = true;
  }
  if (!hasCue && DANGLING.some((marker) => matchesTail(tail, marker))) {
    score += 0.45;
    hasContinuation = true;
  }
  if (!hasContinuation && ['了', '的了', '过了'].some((marker) => tail.endsWith(marker))) {
    score -= 0.35;
  }
  if (COMPLETION.some((marker) => matchesTail(tail, marker))) score -= 0.85;
  if (/[.!?。！？]\s*$/u.test(transcript.trim())) score -= 0.15;
  return Math.max(-1, Math.min(1, score));
}

function wordGaps(words) {
  if (!Array.isArray(words) || words.length > MAX_WORDS) {
    throw new TypeError('Final words must be an array of at most 10000 timestamp objects.');
  }
  const gaps = [];
  let previousEnd = null;
  for (const word of words) {
    if (!word || typeof word !== 'object' || Array.isArray(word)
        || typeof word.start !== 'number' || typeof word.end !== 'number'
        || !Number.isFinite(word.start) || !Number.isFinite(word.end)
        || word.start < 0 || word.end < word.start
        || word.end > Number.MAX_SAFE_INTEGER
        || (previousEnd !== null && word.start < previousEnd)) {
      throw new TypeError('Word timestamps must be finite, ordered, non-overlapping milliseconds.');
    }
    if (previousEnd !== null) {
      const gap = Math.trunc(word.start - previousEnd);
      if (gap >= RHYTHM_FLOOR_MS) gaps.push(gap);
    }
    previousEnd = word.end;
  }
  return gaps;
}

export function createPatienceController({
  mode = 'max_accuracy', initialMinimum = 1200, initialMaximum = 6000,
  ceiling = 10000, calibration = true, markers = true,
  nowMs = () => performance.now(),
} = {}) {
  const initial = thresholds(initialMinimum, initialMaximum);
  if (!['min_latency', 'balanced', 'max_accuracy'].includes(mode)) {
    throw new TypeError('Unsupported streaming mode.');
  }
  if (!validInteger(ceiling, initial.maximum, 10000)) {
    throw new RangeError('Ceiling must contain the initial thresholds.');
  }
  if (typeof calibration !== 'boolean' || typeof markers !== 'boolean'
      || typeof nowMs !== 'function') {
    throw new TypeError('Feature flags must be booleans and nowMs must be a function.');
  }
  let speakerBase = initial;
  let lastRequested = initial;
  let ready = false;
  let closed = false;
  let initialThresholdsVerified = false;
  let lastFinal = -1;
  let currentOrder = -1;
  let sequence = 0;
  let lastTime = null;
  let lastRequestedAt = null;
  let pending = null;
  let pauses = [];
  let turnsSeen = 0;

  function close() {
    closed = true;
    ready = false;
    pending = null;
  }

  function time() {
    let value;
    try {
      value = nowMs();
    } catch {
      close();
      throw new Error('Control clock failed.');
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
        || (lastTime !== null && value < lastTime)) {
      close();
      throw new RangeError('Control clock must be finite and monotonic.');
    }
    lastTime = value;
    return value;
  }

  function requireOrder(order) {
    if (!validInteger(order, 0)) throw new TypeError('turnOrder must be a nonnegative safe integer.');
  }

  function requireResolved() {
    if (pending !== null) throw new Error('Prior control proposal has not been resolved.');
  }

  function propose(order, target, reason, markerScore = null, reset = false) {
    requireResolved();
    if (target.minimum === lastRequested.minimum && target.maximum === lastRequested.maximum) return null;
    const now = time();
    if (!reset && lastRequestedAt !== null && now - lastRequestedAt < COOLDOWN_MS) return null;
    sequence += 1;
    pending = Object.freeze({
      sequence, turnOrder: order, minimum: target.minimum, maximum: target.maximum,
      reason, markerScore, applicationStatus: 'unconfirmed',
    });
    return pending;
  }

  function profile() {
    const ordered = [...pauses].sort((a, b) => a - b);
    const count = ordered.length;
    const middle = Math.floor(count / 2);
    return Object.freeze({
      samples: count,
      p50PauseMs: count ? Math.trunc(count % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2) : null,
      p90PauseMs: count ? ordered[Math.ceil(count * 0.90) - 1] : null,
      longestPauseMs: count ? ordered[count - 1] : null,
      turnsSeen, endpointObservations: 0, unknownEndpoints: turnsSeen,
      forcedEndRate: null, censored: null, confident: false,
    });
  }

  function begin(configuration) {
    if (closed || ready) throw new Error('Controller session cannot be restarted.');
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)
        || configuration.model !== 'universal-3-5-pro' || configuration.mode !== mode) {
      close();
      throw new Error('Streaming model/mode echo missing or mismatched.');
    }
    const expected = { min_turn_silence: initial.minimum, max_turn_silence: initial.maximum };
    for (const [field, value] of Object.entries(expected)) {
      if (Object.hasOwn(configuration, field)
          && (!Number.isSafeInteger(configuration[field]) || configuration[field] !== value)) {
        close();
        throw new Error('Initial threshold echo mismatched.');
      }
    }
    initialThresholdsVerified = Object.keys(expected).every((field) => Object.hasOwn(configuration, field));
    ready = true;
  }

  function partial(turnOrder, transcript) {
    requireOrder(turnOrder);
    if (!ready || closed || turnOrder <= lastFinal || turnOrder < currentOrder) return null;
    if (typeof transcript !== 'string' || transcript.length > MAX_TRANSCRIPT_LENGTH) {
      throw new TypeError('Invalid or oversized partial transcript.');
    }
    requireResolved();
    currentOrder = turnOrder;
    if (!markers || !transcript.trim()) return null;
    const markerScore = scorePatienceMarkers(transcript);
    let target = speakerBase;
    let reason = 'marker_release_to_speaker_base';
    if (markerScore > 0.30) {
      const maximum = Math.min(ceiling, Math.ceil(speakerBase.maximum * 1.5));
      const minimum = Math.min(maximum - 1, Math.ceil(speakerBase.minimum * 1.5));
      target = thresholds(minimum, maximum);
      reason = 'experimental_continuation_cue';
    }
    return propose(turnOrder, target, reason, markerScore);
  }

  function finishTurn(turnOrder, words) {
    requireOrder(turnOrder);
    if (!ready || closed || turnOrder <= lastFinal || turnOrder < currentOrder) {
      return Object.freeze({ accepted: false, update: null });
    }
    requireResolved();
    // Validate before changing any evidence/order. Even an ablation must not
    // silently accept malformed provider word data as a valid final turn.
    const gaps = wordGaps(words);
    if (calibration) {
      pauses = pauses.concat(gaps).slice(-WINDOW);
      turnsSeen = Math.min(WINDOW, turnsSeen + 1);
      const observed = profile();
      if (observed.samples >= MIN_SAMPLES) {
        const maximum = Math.min(ceiling, observed.p90PauseMs + MARGIN_MS);
        if (maximum > speakerBase.maximum) speakerBase = thresholds(speakerBase.minimum, maximum);
      }
    }
    currentOrder = turnOrder;
    lastFinal = turnOrder;
    const update = propose(turnOrder, speakerBase, 'final_reset_or_gap_widening', null, true);
    return Object.freeze({ accepted: true, update });
  }

  function submitted(update) {
    if (closed || pending === null || pending !== update) {
      throw new Error('Stale or foreign control proposal.');
    }
    const now = time();
    lastRequested = thresholds(update.minimum, update.maximum);
    lastRequestedAt = now;
    pending = null;
  }

  function snapshot() {
    return Object.freeze({
      experimental: true, applicationStatus: 'unconfirmed', mode, ready, closed,
      initialThresholdsVerified, calibrationEnabled: calibration, markersEnabled: markers,
      initial, speakerBase, lastRequested, ceiling, sequence, pending,
      lastFinal, currentOrder, profile: profile(),
    });
  }

  return Object.freeze({ begin, partial, finishTurn, submitted, close, snapshot });
}
