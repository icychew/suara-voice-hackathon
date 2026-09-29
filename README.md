# Suara

Suara is a consent-gated voice interviewer for preserving reviewed family
memories. The interface is localized in Bahasa Malaysia, English and Simplified
Chinese. Its current managed speech configuration supports English and Chinese
input with English spoken replies. Mixed-language accuracy and Malay live speech
are not claimed.

The synthetic walkthrough includes playable English, Bahasa Malaysia and
Mandarin narration, timed transcript seeking, playback speed controls and a
download containing only selected, approved fictional excerpts. These prepared
scripts are not live ASR. Audio provenance is documented in licenses.

The review draft also has a selectable text preview in all three interface
languages when a browser download does not start.

Offline benchmark scheduling and the complete attempt-ledger workflow are
documented in docs/BENCHMARK_PREPARATION.md. This preparation leaves all human
attempts NOT_RUN and does not authorize recording or provider use.

The offline accuracy workflow compares three AssemblyAI configurations against
a fixed, licensed public-speech corpus. See docs/ACCURACY_WORKFLOW_2026-09-29.md
for the measured pilot, budget controls and the separate development/holdout
procedure. No custom model weights were trained and no general accuracy gain
is claimed from this small pilot.

Human recording is on hold until the team resolves provider data controls,
participant information and consent, restricted storage, and independent-review
readiness. Use the synthetic no-microphone walkthrough in the meantime.

The application compares AssemblyAI's managed adaptive defaults with an
experimental patient configuration. A separate Streaming diagnostic is a
whole-system path, not a clean causal ablation. Human-reviewed narrator excerpts
can be corrected, excluded and downloaded as source-linked Markdown. This is
reviewed quotation arrangement, not an AI-authored memoir.

## Run locally

    corepack enable
    pnpm install --frozen-lockfile
    pnpm test
    pnpm build
    node scripts/validate-vercel-build.mjs

Vite preview serves static files only; it does not emulate Vercel Functions.
Use a correctly configured Vercel project for the protected voice route.

## Required server configuration

Copy the variable names from .env.example into the deployment environment.
Never put real values in this repository or in browser code.

- ASSEMBLYAI_API_KEY: server-only provider credential.
- SUARA_JUDGE_ACCESS_CODE: separate high-entropy private access code.
- SUARA_PUBLIC_ORIGIN: exact deployed HTTPS origin.
- UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN: shared quota state.
- SUARA_ENABLE_VERCEL_VOICE: must be exactly true for the protected voice route.
- SUARA_ENABLE_STREAMING_VOICE and SUARA_ENABLE_AI_QUESTIONS: optional,
  default-off release decisions.

## Evidence boundary

Local tests and synthetic browser runs prove software behavior only. They do
not prove a public deployment, a human-heard provider reply, older-adult
benefit, Malay speech support, a valid matched three-arm result or participant
demand. Keep those claims pending until dated acceptance evidence exists.

The public-only build excludes the microphone, token routes and writable
surfaces:

    pnpm build:public
    pnpm validate:public

The operator build is local research tooling and is marked non-deployable:

    pnpm build:operator
    pnpm validate:isolation

After collecting exactly one fixed-three baseline, patient and Streaming replay
from the operator, validate the content-free export without choosing successful
runs from a larger set:

    node scripts/benchmark-validate.mjs --input <private-operator-export.json>

A matched-transport receipt remains inconclusive for acoustic outcomes and does
not establish patient benefit or independent blind scoring.

## License

This public release candidate is prepared under the MIT License. The copied
question bank retains its included MIT notice.