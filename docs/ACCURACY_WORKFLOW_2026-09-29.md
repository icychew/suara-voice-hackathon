# Suara accuracy workflow and measured public-data pilot

Owner authorization: 29 September 2026, use existing provider credits to improve
Suara before the 30 September, 23:00 MYT submission deadline.

## What was run

36 paid AssemblyAI prerecorded transcriptions: 12 unique licensed public clips
through Universal-2, Universal-3.5 Pro, and Universal-3.5 Pro with fixed oral-history
context plus a seven-term Malaysian vocabulary. All 36 completed. Unique input
duration: 116.42 seconds. Dashboard speech-to-text charge: **USD 0.02289**.
No human-family audio, microphone, custom model-weight training, payment-method
change or cash top-up was involved. The existing managed voice-session quota
was not reset or used by these prerecorded evaluations.

The public walk-through now plays generated narration in three languages and
supports timed excerpt seeking, playback speed selection and reviewed Markdown
export. Its prepared transcript remains distinct from measured ASR output.

## Dataset and licensing

Source: [Google FLEURS](https://huggingface.co/datasets/google/fleurs),
CC-BY-4.0, Conneau et al. (2022), *FLEURS: Few-shot Learning Evaluation of
Universal Representations of Speech*. Audio is unmodified for these evaluations;
reference text is normalized only for scoring. Each downloaded file has a
SHA-256 hash, source row ID and dataset revision in the local manifest.

English `en_us` and Mandarin `cmn_hans_cn` were downloaded through the official
[Hugging Face Dataset Viewer](https://huggingface.co/docs/dataset-viewer/index).
Published validation rows 0–2 per language were frozen as development data and
rows 10–12 as local held-out data **before provider calls**. The official test
viewer returned HTTP 500/501, so the local `test` label refers to disjoint rows
from the published validation split, not the official FLEURS test set. No
failed provider run was replaced and no successful subset was selected.

This is read speech, not Malaysian family conversation. Speaker/domain coverage
is small and provider pretraining overlap is unknown. It is a pipeline pilot,
not an independent benchmark or a general accuracy claim. FLEURS also provides
a Malay config, but this run does not establish live Malay support.

## Measured results

Error rates use summed edit errors divided by summed reference units, after
NFKC normalization, case folding, punctuation removal and whitespace cleanup.
English uses word errors (WER); Mandarin uses character errors (CER). Numbers
and abbreviations are not rewritten. The local held-out rows were inspected
only in the fixed comparison; no later tuning was performed on them.

| Data | Units | Universal-2 | Universal-3.5 Pro | With context + keyterms |
| --- | ---: | ---: | ---: | ---: |
| English development, 3 clips | 69 words | 6/69 = 8.70% | 6/69 = 8.70% | 6/69 = 8.70% |
| Mandarin development, 3 clips | 105 chars | 1/105 = 0.95% | 2/105 = 1.90% | 3/105 = 2.86% |
| English local held-out, 3 clips | 60 words | 0/60 = 0% | 0/60 = 0% | 0/60 = 0% |
| Mandarin local held-out, 3 clips | 57 chars | 1/57 = 1.75% | 0/57 = 0% | 0/57 = 0% |

Decision: **do not promote the context/keyterm configuration**. It worsened
Mandarin development CER and did not improve the held-out rows over the same
model without hints. The pilot is too small to select a broadly superior model.
The existing managed live-voice configuration is unchanged; prerecorded results
do not establish live-agent latency, turn-taking or elder usability.

Machine-readable counts and source hashes are in
`docs/evidence/asr-public-pilot-2026-09-29.json`. Provider IDs and raw hypotheses
stay in the private local run directory, outside Git and the public build.

## Repeatable improvement procedure

1. Define a concrete failure target (proper names, dates, code switching or noise)
   from development errors. Select rights-cleared data before spending credits.
   Keep real-family recordings out until the separate consent/data-control gate.
2. Freeze source revisions, hashes, transcripts and disjoint development/held-out
   splits. Use speaker-disjoint splits where speaker IDs are available. Never
   put expected held-out answers into prompts or vocabulary lists.
3. Validate without credentials or paid calls; inspect the plan's upper cost.
   This runner permits at most 60 clips, 40 s per clip and USD 5 per invocation;
   its default budget cap is USD 1 at a conservative USD 0.50/hour per profile.
4. Make one bounded comparison. Every attempt is recorded. An exclusive plan
   file refuses reuse of a run folder, and any failed transcription stops the
   run without automatic replacement calls. Inspect ambiguous timeouts before
   creating another run, since a provider may have accepted a timed-out request.
5. Score development data, inspect errors, then freeze the candidate. Future
   tuning requires a **new untouched** holdout. Report every attempt and the
   full denominator, not only good examples. Record actual account charges.
6. Promote only with no language regression, explicit improvement on the target
   errors, and a separately tested live path. Small/uncertain results leave the
   existing default in place. Repeat browser review/export and hosted checks
   before deployment; retain the previous deployment for rollback.

Commands (operator-only; use a local folder outside this checkout and OneDrive):

    node scripts/prepare-accuracy-data.mjs <absolute-corpus-folder>
    node scripts/evaluate-asr.mjs <absolute-manifest.json> <fresh-absolute-plan-folder> --validate
    node scripts/evaluate-asr.mjs <absolute-manifest.json> <different-fresh-absolute-run-folder> --run

`--run` reads `ASSEMBLYAI_API_KEY` from the operator's protected process
environment. Never paste credentials into the command, frontend, source or
report. Validation and execution intentionally use different fresh folders.
Current pricing should be checked before a new paid batch. The acquisition
script is a fixed 12-clip pilot; expand its predeclared ranges only as a new
study with an untouched holdout and reviewed spend bound.

The verified provider interfaces offer
[model selection](https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model),
[context/vocabulary prompting](https://www.assemblyai.com/docs/pre-recorded-audio/universal-3-5-pro/prompting)
and [managed-agent transcription hints](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/transcription-prompt).
This work used API configuration and evaluation, not custom weight fine-tuning.
No self-service weight-training endpoint was identified in those interfaces.

## Deadline plan

| Latest target (MYT) | Deliverable / responsible person |
| --- | --- |
| 29 Sep | Icy/Codex: audio, review/export, measured accuracy pilot, regression checks and release candidate |
| 30 Sep 12:00 | Shana/Icy: accessible final video, replay review; update the audio-intake scene to the playable version |
| 30 Sep 15:00 | Icy: confirm roster, publish the sanitized source and final media links, complete portal fields |
| 30 Sep 20:00 | Icy: final submission with receipt; leave three hours before the official deadline |

These are internal targets, not commitments made by teammates. The deadline
cannot be guaranteed while the final video, public-source link, roster and
portal submission remain unresolved. Freeze further feature expansion after
this release; use remaining time for those submission gates and regressions.

