# Security and privacy boundary

The apex Suara site is a static informational surface. It should never collect names, recordings, transcripts, family histories, contact details, credentials or other personal information.

`demo.suaraproject.tech` may expose only the reviewed voice-token facade. It
mints short-lived AssemblyAI browser credentials but does not receive audio or
transcript payloads. The browser-to-provider voice stream still constitutes a
third-party data transfer and requires clear user disclosure and affirmative
microphone permission before any real-person validation. Do not add uploads,
analytics, third-party embeds, transcript persistence, or other writable
endpoints without a separate privacy and security review. Never connect this
repository directly to the current loopback-only FastAPI demonstration.

The implemented facade requires `SUARA_JUDGE_ACCESS_CODE`, a random 16–128
character printable non-space ASCII code shared privately with judges. The
browser submits it in `X-Suara-Access-Code` on `GET /api/session` and holds it
only in page memory. Missing or incorrect codes return HTTP 401
`access_code_required`; failed attempts consume the per-IP session allowance.
Use a separate code, never the provider key, and never place either secret in
the build or logs. External deployment of this gate remains unverified.

Per-IP and server-wide minute counters are memory-only and reset on restart.
The rolling-day token-attempt cap is durable: `SUARA_QUOTA_FILE` must point to
a pre-existing private absolute path outside the served tree. Its bounded JSON
contains only `version` and numeric `timestamps`, never IPs, identifiers,
credentials, audio or transcripts. Every provider call is preceded by an atomic,
flushed reservation; failed/cancelled attempts count. Future timestamps remain
counted if the clock moves backwards. This numeric ceiling covers one ledger on
one host, not provider dollars, other API use or multiple hosts.

Missing, unreadable, corrupt, oversized, linked or unsafe state fails startup
closed. A runtime read/write/flush/rename error blocks provider issuance and
returns generic HTTP 503 `quota_unavailable`. Exhausted quota returns HTTP 429.
The exclusive single-writer lock survives an abrupt crash and requires a stopped-
service/no-other-writer check before an operator removes only the stale lock.
Never reset the ledger during recovery. See the [recovery procedure](deploy/oracle/README.md).
Systemd grants a mode-0700 `StateDirectory=suaravoice` while retaining
`ProtectSystem=strict` and all other existing sandbox controls.

Provider response bodies are capped while streaming and pending exchanges abort
on browser disconnect. Local single-use bearer reservations precede asynchronous
provider calls. Production requests require the exact Host/Origin and the
trusted loopback HTTPS proxy. Deployment uses Node.js LTS 22 or 24, verified SSH
host keys and SELinux proxy/content labels. Failed release restoration preserves
the potentially live release for recovery instead of deleting it.

The browser stops capture and playback immediately on Finish, then briefly
accepts only final transcript events while awaiting session closure. Reset and
navigation dispose the client and invalidate late callbacks. Finalized narrator
turns can still be reviewed after a failure; resetting existing conversation text
requires confirmation. None of this deletes a provider-side recording.

AssemblyAI documents that every Voice Agent connection is recorded as a
provider-side session containing audio and a full conversation timeline. A
Suara page reset removes only the browser-memory copy. Do not describe the live
pilot as zero-retention or local-only, and do not invite sensitive stories until
the account's data controls and a provider-session deletion policy are verified.

The build guard rejects common private-runtime references and writable browser surfaces. A passing guard is one control, not permission to publish family data.

The optional `build:operator` output is separate from both deployable builds.
It permits explicit opt-in to local, content-free timing traces and manual
timing JSON export; it does not add speech persistence. Production facade
startup and Oracle deployment reject its `suara-operator-only.json` marker.
Do not remove that marker or deploy the operator artifact. Local setup uses a
rotated key and private environment/ledger outside the repository and OneDrive;
see [OPERATOR_CANARY.md](docs/OPERATOR_CANARY.md).

Local software checks cover the site, private pipeline and synthetic memoir
cases; the latest counts are maintained in `PROJECT_STATUS.md`. The separate browser harness
`scripts/qa-voice-browser.js` also passed on the local production build in a
fresh Playwright CLI session, across three locales at 390 x 844 and 1440 x 1000.
Consent, invalid-code cleanup, transcript/evidence review, late-event rejection,
reset focus, network-error review and pagehide clearing were exercised with
stubbed microphone/audio/WebSocket and token routes. No runtime JavaScript or
CSP errors occurred; mocked invalid-code HTTP 401 errors were expected.
This does not establish provider-account retention settings, external access-gate
behavior, actual Oracle/TLS operation or real-person validation.

If a future contact channel is introduced, it must be monitored and must explicitly prohibit story or recording submissions until the real-family intake gates are approved.

## Private Slack coordination boundary

`/api/slack/events` is a server-only project-coordination endpoint, not a public
intake surface. It verifies Slack's signature against the unmodified request
body, rejects timestamps outside five minutes, and fails closed to one configured
workspace and an explicit channel-ID allowlist. Bot messages, unsupported
message subtypes, unapproved channels and Slack retry deliveries do no provider
work. Vercel background execution allows the endpoint to acknowledge Slack
before running the agent.

The Slack bot token, signing secret and OpenAI key are server-only credentials.
They must stay in encrypted Vercel environment settings and ignored local env
files. Slack thread text and bounded file metadata pass to OpenAI; file contents
are not downloaded. Participant recordings, transcripts, family stories,
credentials, private strategy and access codes are prohibited on this surface.
The warm-instance duplicate cache is not a durable queue; do not expand beyond
the small private project channel without durable idempotency and delivery work.
