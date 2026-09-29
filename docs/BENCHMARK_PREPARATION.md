# Offline benchmark preparation

Human recording and participant outreach remain on hold. A plan or passing
software check does not clear consent, provider, reviewer or acoustic gates.

The fixed comparison is managed baseline, managed patient (1,200/6,000 ms and
interruption enabled, subject to the actual provider configuration echo), and
Streaming Universal-3.5 Pro max accuracy. The three fixed questions, source and
conversion must match. Streaming is a different whole-system path, so this is
not a clean causal estimate of silence settings alone. Optional generated
questions remain off.

After permission and an exact source are established, create a new plan:

```text
node scripts/benchmark-plan.mjs --candidate <full-40-character-commit> --source-sha256 <64-character-WAV-hash> --out <new-private-plan.json>
```

The CLI is offline and never reads audio or calls a provider. It refuses to
overwrite an existing file. Keep real source fingerprints and ledgers in
restricted storage outside Git and cloud-sync folders. File mode 0600 is not a
Windows access-control audit; verify the destination's ACLs separately.

The schedule contains six triplets (18 attempts): all six arm permutations,
each arm twice in each position and six times overall. These are repeats of
one source, not 18 independent speakers. This small pilot cannot establish
older-adult benefit or a population-level effect.

All attempts start NOT_RUN, all readiness gates start PENDING and the reviewer
fields are blank. Those fields are a checklist, not an authorization engine.
The candidate and hash are caller-supplied; the tool does not attest the deployed
code, source rights, settings or provider behavior. Lock the completed plan and
its hash before collection, with the actual configuration, permitted source,
budget, stop rules, failure denominators and analysis plan recorded alongside it.
Retain every attempt and amendment; do not replace failed slots silently.

For offline ledger handling, `recordAttempt(plan, { attemptId, status,
receiptSha256 })` returns a copy with only the next slot completed. Terminal
statuses are TRANSPORT_COMPLETE, FAILED and CANCELLED. An attempted slot cannot
be overwritten through the helper. `validateAttemptLedger(plan)` checks schedule,
sequence and receipt-hash syntax and reports every failure in the denominator.
Neither helper verifies the referenced receipts or makes the JSON tamper-proof.
Never put raw recordings, transcripts or identifiable notes in this ledger.

Validate each actual matched triplet separately:

```text
node scripts/benchmark-validate.mjs --input <private-triplet-export.json>
```

A complete or structurally matched transport record is still NOT_SCORED and
INCONCLUSIVE. Preserve failed/partial exports and do not select only successful
triplets. Transport timestamps, provider reply receipts and browser playback
callbacks do not establish audible onset or whether a speaker intended to continue.

Before recording, finalize the participant information and separate choices for
local recording, cloud replay and private reviewer access. Name the reviewers,
material shared, withdrawal contact, retention/deletion dates and reporting uses.
Explicitly permit the accepted independent reviewer to hear the source-only
recording and lock intent labels before seeing arm outputs or condition mapping.
Later scoring requires consented, identity-minimized source-plus-output clips,
validated acoustic alignment and an assessment of compromised blinding. Removed
labels do not make a voice anonymous. Actual reviewer acceptance and availability
must be recorded; no software test supplies them.

Offline regression command (no provider calls):

```text
node --test tests/benchmark-plan.test.mjs tests/benchmark-validate.test.mjs tests/replay-source.test.mjs tests/replay-pacer.test.mjs tests/replay-run.test.mjs
```

These tests exercise synthetic fixtures and failure handling. They do not run
the human benchmark, confirm subjective playback quality or supply independent
reviewer labels. No completed human attempts are supplied by this document.
