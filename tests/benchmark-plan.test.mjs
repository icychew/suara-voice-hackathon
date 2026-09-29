import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBenchmarkPlan, recordAttempt, runPlanCli, validateAttemptLedger } from '../scripts/benchmark-plan.mjs';

const inputs = { candidateCommit: 'a'.repeat(40), sourceSha256: 'b'.repeat(64) };
const receipt = { status: 'TRANSPORT_COMPLETE', receiptSha256: 'c'.repeat(64) };

test('18 fixed slots balance each arm at each position and all six orders', () => {
  const plan = createBenchmarkPlan(inputs);
  assert.equal(new Set(plan.attempts.map((row) => row.attemptId)).size, 18);
  const orders = [];
  for (let block = 1; block <= 6; block++) orders.push(plan.attempts.filter((r) => r.triplet === block).map((r) => r.arm).join(','));
  assert.equal(new Set(orders).size, 6);
  for (const arm of ['baseline', 'patient', 'streaming']) for (const position of [1, 2, 3]) {
    assert.equal(plan.attempts.filter((r) => r.arm === arm && r.position === position).length, 2);
  }
  assert.equal(validateAttemptLedger(plan).notRun, 18);
  assert.ok(Object.values(plan.gates).every((gate) => gate === 'PENDING'));
  assert.ok(Object.values(plan.reviewer).every((value) => value === null));
});

test('failed and cancelled attempts remain in the denominator without replacements or edits', () => {
  const original = createBenchmarkPlan(inputs);
  let plan = recordAttempt(original, { ...receipt, attemptId: 'T1-P1', status: 'FAILED' });
  plan = recordAttempt(plan, { ...receipt, attemptId: 'T1-P2', status: 'CANCELLED' });
  plan = recordAttempt(plan, { ...receipt, attemptId: 'T1-P3' });
  assert.equal(original.attempts[0].status, 'NOT_RUN');
  assert.throws(() => recordAttempt(plan, { ...receipt, attemptId: 'T1-P1' }), /next scheduled/);
  assert.deepEqual(validateAttemptLedger(plan), { scheduled: 18, attempted: 3, transportComplete: 1, failed: 1, cancelled: 1, notRun: 15, scored: 0, conclusion: 'INCONCLUSIVE' });
});

test('rejects skipped slots, altered order, fabricated scores and undocumented receipts', () => {
  const plan = createBenchmarkPlan(inputs);
  assert.throws(() => recordAttempt(plan, { ...receipt, attemptId: 'T2-P1' }), /next scheduled/);
  for (const change of [
    (p) => { p.attempts[0].arm = 'patient'; },
    (p) => { p.attempts.pop(); },
    (p) => { p.attempts[0].outcome = 'PASS'; },
    (p) => { p.attempts[1].status = 'FAILED'; p.attempts[1].receiptSha256 = 'c'.repeat(64); },
    (p) => { p.attempts[0].status = 'FAILED'; },
  ]) {
    const invalid = structuredClone(plan); change(invalid);
    assert.throws(() => validateAttemptLedger(invalid));
  }
});

test('18 transport-complete receipts still produce no score or benefit conclusion', () => {
  let plan = createBenchmarkPlan(inputs);
  for (const row of plan.attempts) plan = recordAttempt(plan, { ...receipt, attemptId: row.attemptId });
  const summary = validateAttemptLedger(plan);
  assert.equal(summary.attempted, 18); assert.equal(summary.scored, 0); assert.equal(summary.conclusion, 'INCONCLUSIVE');
  assert.throws(() => recordAttempt(plan, { ...receipt, attemptId: 'T7-P1' }), /next scheduled/);
});

test('requires exact fingerprints and validates CLI options', async () => {
  for (const candidateCommit of ['HEAD', 'a'.repeat(7), undefined]) assert.throws(() => createBenchmarkPlan({ ...inputs, candidateCommit }));
  assert.throws(() => createBenchmarkPlan({ ...inputs, sourceSha256: 'pending' }));
  await assert.rejects(runPlanCli(['--candidate', inputs.candidateCommit, '--source-sha256']), /Invalid/);
  await assert.rejects(runPlanCli(['--candidate', inputs.candidateCommit, '--candidate', inputs.candidateCommit]), /duplicate/);
  let text = ''; await runPlanCli(['--candidate', inputs.candidateCommit, '--source-sha256', inputs.sourceSha256], { stdout: (s) => { text += s; } });
  assert.equal(validateAttemptLedger(JSON.parse(text)).notRun, 18);
});

test('CLI refuses to overwrite an existing preregistration or ledger', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suara-plan-'));
  try {
    const file = join(dir, 'plan.json');
    const args = ['--candidate', inputs.candidateCommit, '--source-sha256', inputs.sourceSha256, '--out', file];
    await runPlanCli(args, { stdout: () => {} });
    const before = await readFile(file, 'utf8');
    await assert.rejects(runPlanCli(args, { stdout: () => {} }), { code: 'EEXIST' });
    assert.equal(await readFile(file, 'utf8'), before);
  } finally { await rm(join(dir, 'plan.json'), { force: true }); await rmdir(dir); }
});
