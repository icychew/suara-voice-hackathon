import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  QUESTION_BANK, QUESTION_BY_ID, MAX_INTERVIEW_QUESTIONS, QUESTION_POLICY,
  OPENING_QUESTION_ID, eligibleQuestions, fallbackQuestion,
} from '../src/voice/questionBank.js';
import { SESSION_QUESTIONS } from '../src/voice/copy.js';

test('bank metadata is the exact pinned 25-question EN/ZH source', () => {
  assert.equal(QUESTION_BANK.length, 25);
  assert.equal(new Set(QUESTION_BANK.map((question) => question.id)).size, 25);
  assert.deepEqual([...new Set(QUESTION_BANK.map((question) => question.era))],
    ['childhood', 'youth', 'adulthood', 'reflection']);
  assert.deepEqual(QUESTION_BANK.map((question) => question.order),
    Array.from({ length: 25 }, (_, index) => (index + 1) * 10));
  for (const question of QUESTION_BANK) {
    assert.deepEqual(Object.keys(question).sort(), ['era', 'id', 'order', 'text_en', 'text_zh']);
    assert.equal(typeof question.text_en, 'string');
    assert.equal(typeof question.text_zh, 'string');
    assert.match(question.text_zh, /[\u3400-\u9fff]/u);
  }
  // Computed from archive agent/questions.py at 71b2d43, then compared to this
  // port. Stable tuple order makes this independent of JS property ordering.
  const tuples = QUESTION_BANK.map(({ id, era, text_en, text_zh, order }) =>
    [id, era, text_en, text_zh, order]);
  assert.equal(createHash('sha256').update(JSON.stringify(tuples)).digest('hex'),
    '60028f91fb7997634308243f10db32e5ea919c2a056c2a78c99b491ec5af8ff1');
});

test('bank policy and opening are explicit and stable', () => {
  assert.equal(MAX_INTERVIEW_QUESTIONS, 8);
  assert.equal(QUESTION_POLICY, 'bank-v1');
  assert.equal(OPENING_QUESTION_ID, 'birthplace');
  assert.equal(fallbackQuestion([]), QUESTION_BY_ID[OPENING_QUESTION_ID]);
});

test('bank array, entries and null-prototype lookup are immutable', () => {
  assert.equal(Object.isFrozen(QUESTION_BANK), true);
  assert.equal(Object.isFrozen(QUESTION_BY_ID), true);
  assert.equal(Object.getPrototypeOf(QUESTION_BY_ID), null);
  assert.equal(Object.keys(QUESTION_BY_ID).length, 25);
  for (const question of QUESTION_BANK) {
    assert.equal(Object.isFrozen(question), true);
    assert.equal(QUESTION_BY_ID[question.id], question);
  }
  assert.throws(() => QUESTION_BANK.push({}), TypeError);
  assert.throws(() => { QUESTION_BANK[0].text_en = 'Injected question'; }, TypeError);
  assert.throws(() => { QUESTION_BY_ID.birthplace = {}; }, TypeError);
  assert.throws(() => { QUESTION_BY_ID.injected = {}; }, TypeError);
  assert.equal(QUESTION_BY_ID.__proto__, undefined);
  assert.equal(QUESTION_BY_ID.constructor, undefined);
});

test('empty history makes all ordered bank questions eligible without changing the bank', () => {
  const eligible = eligibleQuestions([]);
  assert.deepEqual(eligible, QUESTION_BANK);
  assert.notEqual(eligible, QUESTION_BANK);
  assert.equal(Object.isFrozen(eligible), true);
  assert.throws(() => eligible.reverse(), TypeError);
});

test('eligibility excludes asked IDs and earlier chronology after an intentional jump', () => {
  const asked = Object.freeze(['birthplace', 'first_work', 'proud']);
  const eligible = eligibleQuestions(asked);
  assert.deepEqual(eligible.map((question) => question.id),
    ['regret', 'changed', 'tradition', 'advice', 'anything_else']);
  assert.equal(fallbackQuestion(asked), QUESTION_BY_ID.regret);
  assert.deepEqual(asked, ['birthplace', 'first_work', 'proud']);
});

test('deterministic fallback never duplicates and closes at the eight-question cap', () => {
  const asked = [];
  for (let index = 0; index < MAX_INTERVIEW_QUESTIONS; index += 1) {
    const question = fallbackQuestion(asked);
    assert.equal(question, QUESTION_BANK[index]);
    assert.equal(asked.includes(question.id), false);
    asked.push(question.id);
  }
  assert.deepEqual(eligibleQuestions(asked), []);
  assert.equal(Object.isFrozen(eligibleQuestions(asked)), true);
  assert.equal(fallbackQuestion(asked), null);
});

test('chronological exhaustion closes before the maximum without inventing a question', () => {
  assert.deepEqual(eligibleQuestions(['birthplace', 'anything_else']), []);
  assert.equal(fallbackQuestion(['anything_else']), null);
});

test('history must be a dense array of strict, known string IDs', () => {
  for (const invalid of [undefined, null, '', 'birthplace', {}, new Set(),
    [null], [undefined], [0], [true], [new String('birthplace')],
    ['Birthplace'], [' birthplace'], ['birthplace '], ['not-a-question'],
    ['__proto__'], ['constructor'], ['toString'], new Array(1),
    ['birthplace', , 'parents']]) {
    assert.throws(() => eligibleQuestions(invalid), TypeError);
    assert.throws(() => fallbackQuestion(invalid), TypeError);
  }
  const inherited = [];
  inherited.length = 1;
  Object.setPrototypeOf(inherited, { 0: 'birthplace' });
  assert.throws(() => eligibleQuestions(inherited), TypeError);
});

test('duplicate, reversed, and over-cap histories are rejected rather than repaired', () => {
  for (const invalid of [['birthplace', 'birthplace'], ['parents', 'birthplace'],
    ['birthplace', 'advice', 'proud']]) {
    assert.throws(() => eligibleQuestions(invalid), TypeError);
  }
  assert.throws(() => eligibleQuestions(QUESTION_BANK.slice(0, 9).map((question) => question.id)), RangeError);
});

test('all eight IDs are validated before treating a capped session as closed', () => {
  const duplicate = QUESTION_BANK.slice(0, 7).map((question) => question.id).concat('birthplace');
  const unknown = QUESTION_BANK.slice(0, 7).map((question) => question.id).concat('missing');
  assert.throws(() => eligibleQuestions(duplicate), TypeError);
  assert.throws(() => eligibleQuestions(unknown), TypeError);
});

test('the original matched three-question demo is not replaced by archive openers', () => {
  assert.deepEqual(SESSION_QUESTIONS, [
    'What is one place from your early life that still feels vivid to you?',
    'What family food or tradition means the most to you, and who did you share it with?',
    'What memory or lesson would you most want your family to carry forward?',
  ]);
});

test('source provenance and complete MIT notice accompany the copied questions', () => {
  const source = readFileSync(new URL('../src/voice/questionBank.js', import.meta.url), 'utf8');
  const license = readFileSync(new URL('../licenses/suara-question-bank-MIT.txt', import.meta.url), 'utf8');
  assert.match(source, /71b2d43c016c0af22cfa56adecf031fc45b9abf3/);
  assert.match(source, /licenses\/suara-question-bank-MIT\.txt/);
  assert.match(license, /^MIT License\r?\n/);
  assert.match(license, /Copyright \(c\) 2026 Suara Voice Archive/);
  assert.match(license, /The above copyright notice and this permission notice shall be included/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.match(license, /OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE/);
});
