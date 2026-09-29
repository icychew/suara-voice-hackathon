import test from 'node:test';
import assert from 'node:assert/strict';
import { createPatienceController, scorePatienceMarkers } from '../src/voice/patienceController.js';

const CONFIG = { model: 'universal-3-5-pro', mode: 'max_accuracy' };
function session(options = {}) {
  let now = 0;
  const controller = createPatienceController({ nowMs: () => now, ...options });
  controller.begin(CONFIG);
  return { controller, tick: (ms = 500) => { now += ms; } };
}
function wordsWithGaps(gaps) {
  let end = 100;
  const words = [{ start: 0, end }];
  for (const gap of gaps) {
    const start = end + gap;
    end = start + 100;
    words.push({ start, end });
  }
  return words;
}

test('construction validates all scalars without coercion', () => {
  for (const options of [
    { initialMinimum: '1200' }, { initialMinimum: true }, { initialMinimum: 49 },
    { initialMinimum: 1200.5 }, { initialMaximum: 1200 }, { initialMaximum: 10001 },
    { initialMaximum: Infinity }, { ceiling: 5999 }, { ceiling: '10000' },
    { ceiling: 10001 }, { mode: 'automatic' }, { calibration: 0 }, { markers: 'true' },
    { nowMs: 1 },
  ]) assert.throws(() => createPatienceController(options));
});

test('begin requires exact model/mode, closes mismatches, and rejects restart', () => {
  for (const config of [undefined, null, [], {}, { model: CONFIG.model },
    { ...CONFIG, model: 'universal-streaming-english' }, { ...CONFIG, mode: 'balanced' }]) {
    const c = createPatienceController();
    assert.throws(() => c.begin(config));
    assert.equal(c.snapshot().closed, true);
    assert.throws(() => c.begin(CONFIG));
  }
  const { controller: c } = session();
  assert.throws(() => c.begin(CONFIG));
});

test('absent or partial threshold echoes remain unknown; exact complete echo verifies only initial thresholds', () => {
  for (const extra of [{}, { min_turn_silence: 1200 }]) {
    const c = createPatienceController();
    c.begin({ ...CONFIG, ...extra });
    assert.equal(c.snapshot().initialThresholdsVerified, false);
  }
  const c = createPatienceController();
  c.begin({ ...CONFIG, min_turn_silence: 1200, max_turn_silence: 6000 });
  assert.equal(c.snapshot().initialThresholdsVerified, true);
  assert.equal(c.snapshot().applicationStatus, 'unconfirmed');
});

test('mismatched threshold echoes fail closed, including strings and booleans', () => {
  for (const extra of [
    { min_turn_silence: '1200' }, { min_turn_silence: true },
    { max_turn_silence: 5999 }, { max_turn_silence: null },
  ]) {
    const c = createPatienceController();
    assert.throws(() => c.begin({ ...CONFIG, ...extra }));
    assert.equal(c.snapshot().closed, true);
  }
});

test('pre-begin and post-close events cannot produce proposals or samples', () => {
  const c = createPatienceController();
  assert.equal(c.partial(0, 'because'), null);
  assert.deepEqual(c.finishTurn(0, []), { accepted: false, update: null });
  c.begin(CONFIG);
  const p = c.partial(0, 'because');
  c.close();
  c.close();
  assert.equal(c.partial(1, 'then ah'), null);
  assert.equal(c.finishTurn(1, []).accepted, false);
  assert.throws(() => c.submitted(p));
  assert.equal(c.snapshot().pending, null);
});

test('turn orders are nonnegative safe integers, not coerced IDs', () => {
  const { controller: c } = session();
  for (const order of [-1, 0.5, '0', true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => c.partial(order, 'because'));
    assert.throws(() => c.finishTurn(order, []));
  }
});

test('partial validation is bounded and does not advance the active order on invalid input', () => {
  const { controller: c } = session();
  for (const transcript of [null, [], 123, 'a'.repeat(32001)]) {
    assert.throws(() => c.partial(9, transcript));
  }
  assert.equal(c.snapshot().currentOrder, -1);
  assert.equal(c.partial(0, '   '), null);
  assert.equal(c.partial(0, 'a'.repeat(32000)), null);
});

test('continuation proposal is bounded, immutable, and unconfirmed', () => {
  const { controller: c } = session();
  const p = c.partial(0, 'because that time ah');
  assert.deepEqual(p, {
    sequence: 1, turnOrder: 0, minimum: 1800, maximum: 9000,
    reason: 'experimental_continuation_cue', markerScore: 0.55,
    applicationStatus: 'unconfirmed',
  });
  assert.throws(() => { p.maximum = 1; });
  assert.equal(c.snapshot().lastRequested.maximum, 6000);
  c.submitted(p);
  assert.equal(c.snapshot().lastRequested.maximum, 9000);
  assert.equal(c.snapshot().applicationStatus, 'unconfirmed');
});

test('only the exact pending proposal can be submitted, at most once', () => {
  const { controller: c } = session();
  assert.throws(() => c.submitted(null));
  const p = c.partial(0, 'then ah');
  assert.throws(() => c.submitted({ ...p }));
  c.submitted(p);
  assert.throws(() => c.submitted(p));
});

test('pending proposals reject event mutation until resolved', () => {
  const { controller: c } = session();
  const p = c.partial(0, 'because');
  const before = c.snapshot();
  assert.throws(() => c.partial(1, 'because'));
  assert.throws(() => c.finishTurn(1, wordsWithGaps(Array(12).fill(6000))));
  assert.deepEqual(c.snapshot(), before);
  c.submitted(p);
});

test('repeated continuation partials never compound from last-requested thresholds', () => {
  const { controller: c, tick } = session();
  c.submitted(c.partial(0, 'and then'));
  for (let i = 0; i < 100; i += 1) {
    tick();
    assert.equal(c.partial(0, 'and then'), null);
  }
  assert.equal(c.snapshot().lastRequested.maximum, 9000);
  assert.equal(c.snapshot().speakerBase.maximum, 6000);
  assert.equal(c.snapshot().sequence, 1);
});

test('cooldown applies from submitted time and final reset bypasses it', () => {
  const { controller: c, tick } = session();
  const p = c.partial(0, 'because');
  tick(1000);
  c.submitted(p);
  tick(499);
  assert.equal(c.partial(0, 'That is my story.'), null);
  tick(1);
  const reset = c.partial(0, "that's all");
  assert.equal(reset.maximum, 6000);
  c.submitted(reset);
  tick(500);
  c.submitted(c.partial(0, 'then ah'));
  const final = c.finishTurn(0, []);
  assert.equal(final.accepted, true);
  assert.equal(final.update.maximum, 6000);
  assert.equal(final.update.reason, 'final_reset_or_gap_widening');
});

test('empty partial never releases an active marker hold', () => {
  const { controller: c, tick } = session();
  c.submitted(c.partial(0, 'then ah'));
  tick();
  assert.equal(c.partial(0, ''), null);
  assert.equal(c.snapshot().lastRequested.maximum, 9000);
});

test('completion releases only to speaker base, never below initial settings', () => {
  const { controller: c, tick } = session();
  assert.equal(c.partial(0, "that's all"), null);
  c.submitted(c.partial(0, 'then ah'));
  tick();
  const p = c.partial(0, 'finished');
  assert.equal(p.minimum, 1200);
  assert.equal(p.maximum, 6000);
});

test('maximum and minimum marker extension obey the local ceiling and strict order', () => {
  const { controller: c } = session({ initialMinimum: 9500, initialMaximum: 9999 });
  const p = c.partial(0, 'because');
  assert.equal(p.minimum, 9999);
  assert.equal(p.maximum, 10000);
  const { controller: capped } = session({ ceiling: 6000 });
  const q = capped.partial(0, 'because');
  assert.equal(q.maximum, 6000);
  assert.equal(q.minimum, 1800);
});

test('stale and duplicate finals or partials cannot replay calibration evidence', () => {
  const { controller: c } = session();
  assert.equal(c.finishTurn(5, wordsWithGaps([500])).accepted, true);
  for (const order of [0, 4, 5]) {
    assert.equal(c.finishTurn(order, []).accepted, false);
    assert.equal(c.partial(order, 'because'), null);
  }
  assert.equal(c.snapshot().profile.samples, 1);
  assert.equal(c.snapshot().profile.turnsSeen, 1);
  assert.equal(c.partial(8, ''), null);
  assert.equal(c.finishTurn(7, []).accepted, false);
  assert.equal(c.snapshot().lastFinal, 5);
});

test('malformed final words fail atomically, without samples or order changes', () => {
  const { controller: c } = session();
  const bad = [
    null, {}, 'words', [{ start: true, end: 1 }], [{ start: 0, end: '1' }],
    [{ start: NaN, end: 1 }], [{ start: 0, end: Infinity }],
    [{ start: -1, end: 1 }], [{ start: 2, end: 1 }],
    [{ start: 0, end: 2 }, { start: 1, end: 3 }],
    [...wordsWithGaps([500]), { start: 999, end: undefined }],
    Array(10001).fill({ start: 0, end: 0 }),
    [{ start: 0, end: Number.MAX_SAFE_INTEGER + 1 }],
  ];
  for (const words of bad) {
    const before = c.snapshot();
    assert.throws(() => c.finishTurn(3, words));
    assert.deepEqual(c.snapshot(), before);
  }
});

test('only qualifying internal gaps count; zero words and near-ceiling gaps do not imply endpoint intent', () => {
  const { controller: c } = session();
  c.finishTurn(0, []);
  c.finishTurn(1, wordsWithGaps([0, 249, 250, 5999]));
  assert.deepEqual(c.snapshot().profile, {
    samples: 2, p50PauseMs: 3124, p90PauseMs: 5999, longestPauseMs: 5999,
    turnsSeen: 2, endpointObservations: 0, unknownEndpoints: 2,
    forcedEndRate: null, censored: null, confident: false,
  });
  assert.equal(c.snapshot().speakerBase.maximum, 6000);
});

test('twelve observed gaps can widen max, never min or confidence', () => {
  const { controller: c } = session();
  assert.equal(c.finishTurn(0, wordsWithGaps(Array(11).fill(6500))).update, null);
  const final = c.finishTurn(1, wordsWithGaps([6500]));
  assert.equal(final.update.minimum, 1200);
  assert.equal(final.update.maximum, 7700);
  c.submitted(final.update);
  assert.equal(c.snapshot().profile.confident, false);
  assert.equal(c.snapshot().profile.forcedEndRate, null);
});

test('many short gaps never tighten thresholds or establish calibrated confidence', () => {
  const { controller: c } = session();
  const result = c.finishTurn(0, wordsWithGaps(Array(60).fill(500)));
  assert.equal(result.update, null);
  assert.deepEqual(c.snapshot().speakerBase, { minimum: 1200, maximum: 6000 });
  assert.equal(c.snapshot().profile.confident, false);
});

test('calibration widens only to ceiling and later short gaps cannot shrink speaker base', () => {
  const { controller: c } = session();
  const first = c.finishTurn(0, wordsWithGaps(Array(12).fill(20000)));
  assert.equal(first.update.maximum, 10000);
  c.submitted(first.update);
  assert.equal(c.finishTurn(1, wordsWithGaps(Array(60).fill(500))).update, null);
  assert.equal(c.snapshot().speakerBase.maximum, 10000);
  assert.equal(c.snapshot().profile.longestPauseMs, 500);
});

test('nearest-rank p90 and median summarize observed gaps, not missing endpoint pauses', () => {
  const { controller: c } = session();
  const gaps = Array.from({ length: 20 }, (_, index) => 250 + index * 100);
  c.finishTurn(0, wordsWithGaps(gaps));
  assert.equal(c.snapshot().profile.p50PauseMs, 1200);
  assert.equal(c.snapshot().profile.p90PauseMs, 1950);
});

test('gap and turn evidence are independent bounded rolling windows', () => {
  const { controller: c } = session();
  c.finishTurn(0, wordsWithGaps(Array(65).fill(500)));
  for (let order = 1; order < 1000; order += 1) c.finishTurn(order, []);
  const s = c.snapshot();
  assert.equal(s.profile.samples, 60);
  assert.equal(s.profile.turnsSeen, 60);
  assert.equal(s.profile.unknownEndpoints, 60);
  assert.equal(s.lastFinal, 999);
});

test('calibration and marker ablations operate independently', () => {
  const { controller: noMarkers } = session({ markers: false });
  assert.equal(noMarkers.partial(0, 'because'), null);
  assert.equal(noMarkers.finishTurn(0, wordsWithGaps(Array(12).fill(6500))).update.maximum, 7700);
  const { controller: noCalibration } = session({ calibration: false });
  noCalibration.submitted(noCalibration.partial(0, 'because'));
  const final = noCalibration.finishTurn(0, wordsWithGaps(Array(12).fill(20000)));
  assert.equal(final.update.maximum, 6000);
  assert.equal(noCalibration.snapshot().profile.samples, 0);
  const { controller: neither } = session({ calibration: false, markers: false });
  assert.equal(neither.partial(0, 'because'), null);
  assert.equal(neither.finishTurn(0, wordsWithGaps(Array(12).fill(20000))).update, null);
  assert.throws(() => neither.finishTurn(1, null));
});

test('marker extensions after calibration derive from the new speaker base', () => {
  const { controller: c, tick } = session();
  c.submitted(c.finishTurn(0, wordsWithGaps(Array(12).fill(6500))).update);
  tick();
  const p = c.partial(1, 'because');
  assert.equal(p.maximum, 10000);
  c.submitted(p);
  tick();
  const release = c.partial(1, 'finished');
  assert.equal(release.maximum, 7700);
  assert.equal(release.minimum, 1200);
});

test('invalid or backwards clocks permanently close the controller', () => {
  for (const value of [NaN, Infinity, -1, '100', true]) {
    const { controller: c } = session({ nowMs: () => value });
    assert.throws(() => c.partial(0, 'because'));
    assert.equal(c.snapshot().closed, true);
  }
  let now = 10;
  const { controller: c } = session({ nowMs: () => now });
  const p = c.partial(0, 'because');
  now = 9;
  assert.throws(() => c.submitted(p));
  assert.equal(c.snapshot().closed, true);
  assert.equal(c.snapshot().lastRequested.maximum, 6000);
});

test('clock exceptions are sanitized and close pending state', () => {
  const { controller: c } = session({ nowMs: () => { throw new Error('private provider value'); } });
  assert.throws(() => c.partial(0, 'because'), (error) => {
    assert.equal(error.message, 'Control clock failed.');
    return true;
  });
  assert.equal(c.snapshot().closed, true);
});

test('snapshots and proposals retain no transcript, word text, IDs, or secrets', () => {
  const { controller: c } = session();
  const transcript = 'PRIVATE_NARRATOR_TOKEN because';
  c.submitted(c.partial(0, transcript));
  c.submitted(c.finishTurn(0, [{ start: 0, end: 1, text: 'PRIVATE_WORD', speaker: 'PRIVATE_ID' }]).update);
  const s = c.snapshot();
  const json = JSON.stringify(s);
  for (const privateText of ['PRIVATE', transcript, 'PRIVATE_WORD', 'PRIVATE_ID']) {
    assert.equal(json.includes(privateText), false);
  }
  assert.throws(() => { s.profile.samples = 42; });
  assert.throws(() => { s.lastRequested.maximum = 42; });
  assert.throws(() => { s.ready = false; });
});

test('English, Mandarin, and Malaysian cue fixtures are explicit heuristic results', () => {
  const fixtures = [
    ['then ah', 0.55], ['because', 0.70], ['and   then', 0.70],
    ['my mother she', 0.45], ['um', 0.50], ['eh', 0.95], ['finished', -0.85],
    ["that's all", -0.85], ['like that lah', -0.55], ['lor', -0.50],
    ['然后', 0.70], ['因为', 0.70], ['那个', 1], ['他', 0.45],
    ['我讲完了', -1], ['没有了', -1], ['过去了', -0.35],
    ['itu', 0.50], ['apa', 0.50],
  ];
  for (const [text, expected] of fixtures) {
    assert.ok(Math.abs(scorePatienceMarkers(text) - expected) < 1e-10, text);
  }
});

test('lexical tails do not produce substring false positives or erase joined words', () => {
  for (const text of [
    'museum', 'maximum', 'teacher', 'un-finished', 'unfinished', 'somewhere',
    'lah_', 'x_lah', 'x-lah', 'x—lah', 'x’lah', 'élah', 'a\u0301lah', '𐐀lah',
  ]) assert.equal(scorePatienceMarkers(text), 0, text);
  assert.equal(scorePatienceMarkers('It is finished but there is more'), 0.45);
  assert.equal(scorePatienceMarkers('It was finished yesterday'), 0);
});

test('punctuation nudges independently without dropping the spoken-tail cue', () => {
  assert.ok(Math.abs(scorePatienceMarkers('then ah...') - 0.40) < 1e-10);
  assert.equal(scorePatienceMarkers('then ah，'), 0.55);
  assert.equal(scorePatienceMarkers('then ah\u{10100}'), 0.55);
  assert.ok(Math.abs(scorePatienceMarkers('然后。') - 0.55) < 1e-10);
  assert.equal(scorePatienceMarkers('finished!'), -1);
  assert.equal(scorePatienceMarkers('   '), 0);
  assert.equal(scorePatienceMarkers('...'), 0);
});

test('scalar marker API rejects malformed and oversized input', () => {
  for (const input of [undefined, null, 1, false, {}, 'a'.repeat(32001)]) {
    assert.throws(() => scorePatienceMarkers(input));
  }
});
