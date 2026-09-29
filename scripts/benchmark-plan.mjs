// Offline preparation only. This module never opens audio or contacts providers.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ORDERS = [
  ['baseline', 'patient', 'streaming'], ['patient', 'streaming', 'baseline'],
  ['streaming', 'baseline', 'patient'], ['baseline', 'streaming', 'patient'],
  ['streaming', 'patient', 'baseline'], ['patient', 'baseline', 'streaming'],
];
const TERMINAL = new Set(['TRANSPORT_COMPLETE', 'FAILED', 'CANCELLED']);
const hash = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);

export function createBenchmarkPlan({ candidateCommit, sourceSha256 } = {}) {
  if (!hash(candidateCommit, 40) || !hash(sourceSha256, 64)) throw new Error('Exact candidate commit and source SHA-256 required');
  return {
    schema: 1, purpose: 'offline_benchmark_preparation', protocol: 'public-fixed-three-replay-v1',
    candidateCommit, sourceSha256,
    authorization: 'This plan does not authorize recording, outreach, provider upload or spending.',
    design: 'Six counterbalanced triplets; all six arm orders; no automatic replacements.',
    gates: {
      providerControlsAndLimitations: 'PENDING', consentAndStorage: 'PENDING',
      reviewerAcceptanceAndIndependence: 'PENDING', sourceIntentLock: 'PENDING',
      candidateConfigurationAndBudget: 'PENDING', acousticAlignment: 'PENDING',
    },
    reviewer: { code: null, acceptanceReference: null, priorExposureDisclosure: null, sourceIntentLockReference: null },
    attempts: ORDERS.flatMap((order, block) => order.map((arm, position) => ({
      attemptId: `T${block + 1}-P${position + 1}`, triplet: block + 1, position: position + 1, arm,
      status: 'NOT_RUN', receiptSha256: null, outcome: 'NOT_SCORED',
    }))),
    interpretation: 'Transport completion is not an acoustic score or evidence of participant benefit.',
  };
}

export function validateAttemptLedger(plan) {
  const expected = createBenchmarkPlan(plan);
  if (plan.schema !== expected.schema || plan.protocol !== expected.protocol || plan.purpose !== expected.purpose
      || !Array.isArray(plan.attempts) || plan.attempts.length !== 18) throw new Error('Invalid fixed benchmark ledger');
  let unrunSeen = false;
  for (let index = 0; index < 18; index += 1) {
    const actual = plan.attempts[index];
    const slot = expected.attempts[index];
    if (!actual || ['attemptId', 'triplet', 'position', 'arm'].some((key) => actual[key] !== slot[key])
        || actual.outcome !== 'NOT_SCORED') throw new Error('Schedule or unscored outcome changed');
    if (actual.status === 'NOT_RUN') {
      unrunSeen = true;
      if (actual.receiptSha256 !== null) throw new Error('Unrun attempt has a receipt');
    } else if (!TERMINAL.has(actual.status) || !hash(actual.receiptSha256, 64) || unrunSeen) {
      throw new Error('Invalid, skipped or undocumented attempt');
    }
  }
  return {
    scheduled: 18,
    attempted: plan.attempts.filter((row) => TERMINAL.has(row.status)).length,
    transportComplete: plan.attempts.filter((row) => row.status === 'TRANSPORT_COMPLETE').length,
    failed: plan.attempts.filter((row) => row.status === 'FAILED').length,
    cancelled: plan.attempts.filter((row) => row.status === 'CANCELLED').length,
    notRun: plan.attempts.filter((row) => row.status === 'NOT_RUN').length,
    scored: 0, conclusion: 'INCONCLUSIVE',
  };
}

// Adds one terminal receipt to the next slot, preserving every prior attempt.
// It does not verify receipt contents, consent or readiness. Validate actual
// triplet exports separately and keep independent scoring in its own sheet.
export function recordAttempt(plan, { attemptId, status, receiptSha256 } = {}) {
  validateAttemptLedger(plan);
  if (!TERMINAL.has(status) || !hash(receiptSha256, 64)) throw new Error('Terminal status and receipt SHA-256 required');
  const index = plan.attempts.findIndex((row) => row.status === 'NOT_RUN');
  if (index < 0 || plan.attempts[index].attemptId !== attemptId) throw new Error('Only the next scheduled attempt can be recorded');
  const next = structuredClone(plan);
  Object.assign(next.attempts[index], { status, receiptSha256 });
  validateAttemptLedger(next);
  return next;
}

export async function runPlanCli(args, { stdout = (text) => process.stdout.write(text) } = {}) {
  if (args.length === 1 && args[0] === '--help') {
    stdout('Offline plan only: node scripts/benchmark-plan.mjs --candidate <40-char commit> --source-sha256 <64-char hash> [--out <new private file>]\n');
    return;
  }
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--candidate', '--source-sha256', '--out'].includes(key) || options[key] !== undefined
        || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Invalid or duplicate option; use --help');
    options[key] = args[index + 1];
  }
  const plan = createBenchmarkPlan({ candidateCommit: options['--candidate'], sourceSha256: options['--source-sha256'] });
  const text = `${JSON.stringify(plan, null, 2)}\n`;
  if (options['--out']) {
    // Refuse to erase an earlier preregistration or attempt ledger.
    await writeFile(resolve(options['--out']), text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    stdout('Created offline preparation plan. All 18 attempts remain NOT_RUN. Recording and provider use are not authorized by this file.\n');
  } else stdout(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPlanCli(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
