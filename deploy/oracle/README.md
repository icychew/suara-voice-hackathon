# Oracle Always Free demo host

This package deploys the compiled public experience plus a narrow voice-token
facade. It does not deploy the Suara FastAPI operator workspace, accept uploads,
persist recordings or transcripts, or use real-family evidence. The facade only
exchanges a short-lived, one-use local bearer for an AssemblyAI browser token;
live audio travels between the visitor's browser and AssemblyAI, not through the
Oracle service.

## Target shape

- `suaraproject.tech` and `www.suaraproject.tech`: GitHub Pages, unchanged.
- `demo.suaraproject.tech`: one Oracle Cloud Always Free-eligible Ampere A1 VM.
- Recommended initial shape: Oracle Linux 9, 1 OCPU, 6 GB RAM, in the tenancy's
  home region. Confirm that `VM.Standard.A1.Flex` and the selected platform image
  are marked **Always Free-eligible**, and keep the boot volume inside the free
  storage allowance.
- Capacity fallback: the recorded `VM.Standard.A1.Flex` attempt in AD-1 failed
  with `Out of capacity`. First remove any fault-domain selection, try another
  availability domain if the home region offers one, or retry later. If A1
  remains unavailable, select `VM.Standard.E2.1.Micro` (AMD, 1 GB RAM) in the
  availability domain where Oracle offers it, but only when both the shape and
  image carry the **Always Free-eligible** label and the cost estimate is zero.
  Do not upgrade to a paid shape automatically. The release is built on the
  workstation, so the VM only runs Nginx and the small Node facade; expect less
  headroom on the 1 GB fallback and monitor it during the demo.
- Web server: Nginx serving immutable build assets. Before TLS it proxies only
  `/healthz`; after TLS it exposes the two exact token paths to a loopback-only
  Node.js service.
- DNS: one `A` record for `demo`, added only after the origin works by public IP.

Oracle's Console is the source of truth for eligibility. The published A1 pool
is 2 OCPUs and 12 GB RAM total, with 200 GB combined boot/block storage. Stop if
the selected shape or image is not Always Free-eligible or the estimated cost is
not zero.

Always Free has no SLA, and Oracle may reclaim an A1 instance after its idle
criteria are met during a seven-day period. GitHub Pages therefore remains the
production origin; this VM is a replaceable demo mirror whose release can be
recreated from this repository.

Oracle documents both the capacity recovery order and the E2 micro allowance:

- https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/troubleshooting-out-of-host-capacity.htm
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- https://yum.oracle.com/oracle-linux-nodejs.html

## VM and network preparation

1. Create the VM with an SSH public key. Do not paste or commit the private key.
2. Let OCI choose the recommended paravirtualized networking type. Do not force
   SR-IOV for this Arm platform image.
3. Assign an Oracle-owned reserved public IPv4 if the tenancy limit allows it;
   otherwise use the default ephemeral public IPv4 and expect it to change if
   the instance is terminated.
4. In its subnet security list or network security group, allow TCP 22 from the
   maintainer's IP and TCP 80/443 from the Internet. Do not expose other ports.
5. Keep the generated private key outside this repository.

The bootstrap script also opens HTTP/HTTPS in Oracle Linux's host firewall. Port
`8787` stays bound to `127.0.0.1` and must never be added to OCI or host-firewall
ingress.

## Publish from Windows

From the repository root:

First verify the SSH host fingerprint through a trusted Oracle console channel
and provision the verified entry in your SSH `known_hosts` file. Deployment uses
`StrictHostKeyChecking=yes` and refuses unknown or changed hosts.

```powershell
.\scripts\Deploy-OracleDemo.ps1 `
  -HostName '<ORACLE_PUBLIC_IP>' `
  -SshKeyPath 'C:\secure\path\oracle-suara.key'
```

The script runs tests and the full Oracle build, creates a temporary archive,
uploads it into a unique owner-only staging directory, verifies every transfer,
installs Nginx and the hardened systemd service, and atomically switches the
`current` symlink. It runs a local HTTP health check and restores the prior
release if that check fails. From the second successful release onward, the
previous release stays available for rollback. Only the five newest releases
are retained, plus any older release still referenced by `current` or
`previous`.

The first deploy creates `/etc/suara/voice.env` as a root-owned `0600` file with
an empty key and judge access code and leaves `suara-voice.service` stopped. Keep it stopped until the
checked-in TLS configuration is active. The port-80 server exposes only static
files, the ACME challenge, and `/healthz`; `/api/session` and
`/api/voice/token` return 404 before HTTPS.

The public facade allowlist is intentionally small:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | dependency-free liveness check |
| `GET` | `/api/session` | require `X-Suara-Access-Code`, then issue a 120-second local bearer; only its SHA-256 digest is retained |
| `POST` | `/api/voice/token` | require exact Origin + bearer, then mint a 60-second, single-use provider token capped at a 600-second voice session |

All other `/api/` paths are rejected. The service rejects request bodies,
limits headers and request targets, applies per-IP, server-wide per-minute, and
rolling 24-hour token caps, emits no request/audio/transcript logs, and returns
generic upstream errors. In production it also rejects every API request whose
trusted Nginx `X-Forwarded-Proto` is not exactly `https`. Per-IP and per-minute
limiters are memory-only. The rolling 24-hour attempt cap is durable and survives
service restart. A mandatory judge access gate prevents anonymous token issuance;
missing or incorrect codes return HTTP 401 with `{"error":"access_code_required"}`,
and failed attempts count toward the session rate limit. Use a random, privately
shared code in `SUARA_JUDGE_ACCESS_CODE` (16–128 printable non-space ASCII
characters). The browser holds it only in memory. This controlled demo gate is
not a dollar spending ceiling; the durable attempt cap applies to this one
ledger on one host. It is not a multi-host global quota or provider billing limit.

### Durable issuance ledger

Set `SUARA_QUOTA_FILE=/var/lib/suaravoice/token-issuance.json` in the protected
environment file. The systemd unit uses `StateDirectory=suaravoice` with mode
`0700`; `ProtectSystem=strict` remains enabled and the only new persistent write
exception is this state directory. With `DynamicUser`, systemd may keep the
directory under `/var/lib/private/suaravoice` and expose the normal path by link.

The bounded file contains only `{"version":1,"timestamps":[...]}`: at most
10,000 attempt timestamps and 180,000 bytes, with no IPs, identifiers, credentials,
audio or transcripts. Before contacting the provider, the service reserves a
slot using an exclusive writer lock, a mode-0600 temporary file, file fsync,
atomic rename and Linux directory fsync. Failed or cancelled provider attempts
still consume their reserved slot. Timestamps in the future remain counted
conservatively if the clock moves backwards. Expired stamps are pruned on the
next reservation.

The installer initializes an empty ledger only when both possible state-directory
locations are absent. It never recreates a missing ledger in existing state.
Missing, unreadable, corrupt, oversized, nonregular, linked or unsafe-permission
files prevent startup. Runtime read/write/flush/rename failure returns only
HTTP 503 `quota_unavailable` and blocks further provider calls in that process.
The exhausted day cap returns HTTP 429 `rate_limited` with `Retry-After`.
Preserve the ledger across deploys, rollbacks and machine recovery. Replacing it
with an older/empty file would invalidate the quota guarantee.

The local regression suite checks restart survival, failed-provider accounting,
concurrent distinct requests, clock rollback, unsafe files, injected I/O failures
and a hard-killed child process. It does not prove actual Oracle filesystem,
systemd, power-loss or external-provider behavior.

### Stale-lock recovery after a crash

Graceful shutdown releases `token-issuance.json.lock`. Abrupt death deliberately
leaves the empty lock, so an automatic restart fails closed instead of guessing
whether another writer is active. Recovery is an operator action:

1. Stop `suara-voice.service` and verify `MainPID=0`. Check that no separately
   launched facade process exists and no process holds the lock. For example,
   inspect `systemctl show suara-voice.service -p MainPID` and
   `sudo fuser /var/lib/suaravoice/token-issuance.json.lock`.
2. Resolve the state directory and verify it is exactly `/var/lib/suaravoice`
   or `/var/lib/private/suaravoice`. Inspect the ledger's bounded JSON, ownership
   and permissions without modifying it. If the ledger is missing or corrupt,
   keep the service stopped and investigate; never initialize an empty substitute.
3. Only after confirming there is no writer, remove **only** the regular,
   single-link, non-symlink stale file
   `/var/lib/suaravoice/token-issuance.json.lock`. Do not remove the ledger,
   state directory or any temporary file of uncertain origin.
4. Start the service, verify loopback health, then verify that the preserved day
   limit still applies. Startup revalidates the ledger. Do not repeatedly clear
   a lock while a service process is running.

The installer uses supported Node.js LTS 22 or 24 and configures SELinux to allow
Nginx to reach the loopback facade. Bootstrap applies persistent SELinux labels
to the ACME webroot. These commands still require validation on the actual host.

Confirm the origin before DNS:

```powershell
curl.exe --resolve demo.suaraproject.tech:80:<ORACLE_PUBLIC_IP> http://demo.suaraproject.tech/
```

## DNS and HTTPS

After the origin check passes, add exactly this record to the existing zone:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `demo` | `<ORACLE_PUBLIC_IP>` | 300 |

Do not change the apex or `www` records. Once `demo.suaraproject.tech` resolves
to the VM, use the installed Certbot bootstrap. It uses the webroot challenge
and a checked-in TLS Nginx template, so later releases preserve HTTPS without
letting Certbot rewrite the server configuration. It follows Certbot's Python
virtual-environment installation path, installs its Oracle Linux build
prerequisites, enables certificate-renewal scheduling, and requires a
certificate-contact email:

```bash
sudo /usr/local/sbin/suara-enable-tls demo.suaraproject.tech '<CERTIFICATE_EMAIL>'
```

After HTTPS is active, add a newly rotated AssemblyAI key and a random judge access code using an editor
that does not put it in shell history, review the conservative token caps in the
same file, and start the facade:

```bash
sudoedit /etc/suara/voice.env
sudo systemctl enable --now suara-voice.service
sudo systemctl restart suara-voice.service
curl --fail --silent --show-error \
  -H 'Host: demo.suaraproject.tech' \
  http://127.0.0.1:8787/healthz
sudo systemctl is-active suara-voice.service
```

Never paste the key into this repository, a browser bundle, a deployment
argument, a chat, or a screenshot. Later deployments preserve the existing
environment file and restart the service only when both the key and judge code
are configured. Never share the AssemblyAI key with judges; share only the
separate demo access code.

Require the final HTTPS response to include the CSP, Permissions-Policy,
Referrer-Policy, X-Content-Type-Options and X-Frame-Options headers from the
checked-in Nginx configuration. Voice-token exchange is intentionally
unreachable from the Internet until the TLS-only routes are active.

## Rollback

On the VM, after at least two successful releases:

Publish and rollback share an exclusive release lock. If a failed publication
cannot restore its prior symlink, cleanup preserves the new release for recovery
and reports the failure. Rollback changes the static release only; the facade
service and system configuration are installed separately and are not reverted
by this command.

```bash
sudo /usr/local/sbin/suara-rollback-release demo.suaraproject.tech
```

Removing the single `demo` A record withdraws only the Oracle mirror; the main
site remains unaffected.
