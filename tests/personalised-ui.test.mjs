import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PERSONALISED_COPY, STREAMING_COPY } from '../src/voice/streamingCopy.js';

test('all three interface locales disclose the optional excerpt-processing route', () => {
  for (const locale of ['en', 'ms', 'zh']) {
    const copy = PERSONALISED_COPY[locale];
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(PERSONALISED_COPY.en).sort());
    assert.deepEqual(Object.keys(copy.overrides).sort(), Object.keys(PERSONALISED_COPY.en.overrides).sort());
    assert.deepEqual(Object.keys(copy.selection).sort(), ['ai', 'bank', 'fallback', 'pending']);
    assert.match(copy.overrides.consent, /AssemblyAI LLM Gateway/);
    assert.match(copy.overrides.consentDetail, /4,000/);
    assert.match(copy.detail, /Vercel/);
    assert.equal(copy.overrides.privacyItems.length, 3);
    assert.equal(copy.overrides.questions.length, 3);
    assert.notEqual(copy.overrides.consentDetail, STREAMING_COPY[locale].overrides.consentDetail);
  }
});

test('AI plan is opt-in, resets consent and is excluded from operator comparison UI', async () => {
  const app = await readFile(new URL('../src/voice/VoiceDemoApp.jsx', import.meta.url), 'utf8');
  assert.match(app, /\[personalised, setPersonalised\] = useState\(false\)/);
  assert.match(app, /setPersonalised\(event.target.checked\); setConsent\(false\)/);
  assert.match(app, /personalised: mode === "streaming" && personalised/);
  assert.match(app, /!onTiming \? \[\["streaming"/);
  assert.match(app, /personalised \? personalCopy.overrides : \{\}/);
  assert.ok(app.match(/setPersonalised\(false\)/g).length >= 3);
});

test('complete question-bank MIT notice accompanies built static assets', async () => {
  const notice = await readFile(new URL('../licenses/suara-question-bank-MIT.txt', import.meta.url), 'utf8');
  const distributed = await readFile(new URL('../public/licenses/suara-question-bank-MIT.txt', import.meta.url), 'utf8');
  assert.equal(distributed.replaceAll('\r\n', '\n'), notice.replaceAll('\r\n', '\n'));
});
