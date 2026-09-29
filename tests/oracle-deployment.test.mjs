import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const deploy = await read("../scripts/Deploy-OracleDemo.ps1");
const bootstrap = await read("../deploy/oracle/bootstrap-oracle-linux.sh");
const publish = await read("../deploy/oracle/publish-release.sh");
const rollback = await read("../deploy/oracle/rollback-release.sh");
const tls = await read("../deploy/oracle/enable-tls.sh");
const httpNginx = await read("../deploy/oracle/nginx-suara-demo.conf");
const tlsNginx = await read("../deploy/oracle/nginx-suara-demo-tls.conf");
const voiceInstaller = await read("../deploy/oracle/install-voice-facade.sh");
const voiceService = await read("../deploy/oracle/suara-voice.service");
const voiceEnvironment = await read("../deploy/oracle/suara-voice.env.example");
const pagesWorkflow = await read("../.github/workflows/pages.yml");

test("Oracle deploy uploads through a unique private staging directory", () => {
  assert.match(deploy, /pnpm build/);
  assert.doesNotMatch(deploy, /pnpm validate:public/);
  assert.match(deploy, /mktemp -d \/tmp\/suara-deploy\.XXXXXXXX/);
  assert.match(deploy, /\^\/tmp\/suara-deploy\\\./);
  assert.match(deploy, /IdentitiesOnly=yes/);
  assert.match(deploy, /StrictHostKeyChecking=yes/);
  assert.match(deploy, /suara-operator-only\.json/);
  assert.ok(deploy.indexOf("Operator-only artifacts cannot be deployed") < deploy.indexOf("tar -czf"));
  assert.doesNotMatch(deploy, /StrictHostKeyChecking=accept-new/);
  assert.doesNotMatch(deploy, /:\/tmp\/suara-dist\.tgz/);
  assert.match(deploy, /Could not upload the release archive/);
  assert.match(deploy, /Could not upload the TLS Nginx configuration/);
  assert.match(deploy, /Could not upload the voice-facade service/);
  assert.match(deploy, /suara-install-voice-facade\.sh/);
  assert.match(deploy, /rm -rf -- '\$remoteStage'/);
});

test("publish and rollback validate targets and health-check every switch", () => {
  for (const script of [publish, rollback]) {
    assert.match(script, /validate_release_target/);
    assert.match(script, /dirname/);
    assert.match(script, /prototype\/index\.html/);
    assert.match(script, /curl --fail --silent --show-error --max-time 15/);
    assert.match(script, /health_scheme="https"/);
    assert.match(script, /health_port="443"/);
  }

  assert.match(publish, /tar --no-same-owner --no-same-permissions/);
  assert.match(publish, /suara-operator-only/);
  assert.ok(publish.indexOf("Operator-only artifacts cannot be published") < publish.indexOf("activated=1"));
  assert.match(publish, /contains an unsafe path/);
  assert.match(publish, /contains a link/);
  assert.match(publish, /voice\/index\.html/);
  assert.match(publish, /\$\{domain\}\/voice\//);
  assert.match(publish, /restoring the prior state/);
  assert.match(publish, /activated=1/);
  assert.match(publish, /cleanup_failed_release[\s\S]*restore_prior_state/);
  assert.match(publish, /if ! nginx -t \|\| ! systemctl reload nginx/);
  assert.match(rollback, /restoring the newer release/);
  assert.match(rollback, /voice\/index\.html/);
  assert.match(rollback, /\$\{domain\}\/voice\//);
  assert.match(rollback, /cleanup_failed_rollback[\s\S]*restore_newer_release/);
});

test("TLS is deterministic and survives later releases", () => {
  assert.match(bootstrap, /tls_config_source/);
  assert.match(bootstrap, /\/etc\/letsencrypt\/live\/\$\{domain\}\/fullchain\.pem/);
  assert.match(tls, /certbot certonly/);
  assert.match(tls, /--webroot/);
  assert.doesNotMatch(tls, /certbot --nginx/);
  assert.match(tls, /renew --quiet --deploy-hook/);
  assert.match(tls, /local HTTPS health check/);
});

test("Oracle Nginx configurations preserve privacy and security headers", () => {
  for (const config of [httpNginx, tlsNginx]) {
    assert.match(config, /access_log off/);
    assert.match(config, /Content-Security-Policy/);
    assert.match(config, /frame-ancestors 'none'/);
    assert.match(config, /X-Frame-Options "DENY"/);
    assert.match(config, /Permissions-Policy/);
    assert.match(config, /wss:\/\/agents\.assemblyai\.com/);
    assert.match(config, /microphone=\(self\)/);
    assert.match(config, /client_max_body_size 1k/);
    assert.match(config, /location = \/voice\//);
    assert.match(config, /try_files \/voice\/index\.html =404/);
    assert.match(config, /location = \/prototype\//);
    assert.match(config, /try_files \/prototype\/index\.html =404/);
  }

  assert.match(httpNginx, /\.well-known\/acme-challenge/);
  assert.match(httpNginx, /location = \/healthz/);
  assert.doesNotMatch(httpNginx, /api\/session|api\/voice\/token/);
  assert.match(tlsNginx, /proxy_pass http:\/\/127\.0\.0\.1:8787/);
  assert.match(tlsNginx, /proxy_set_header X-Real-IP \$remote_addr/);
  assert.match(tlsNginx, /api\/session/);
  assert.match(tlsNginx, /api\/voice\/token/);
  assert.match(tlsNginx, /ssl_protocols TLSv1\.2 TLSv1\.3/);
  assert.match(tlsNginx, /Strict-Transport-Security/);
  assert.match(tlsNginx, /return 308 https:\/\/__DOMAIN__\$request_uri/);
});

test("voice facade is loopback-only, root-configured, and systemd-hardened", () => {
  assert.match(voiceEnvironment, /^ASSEMBLYAI_API_KEY=$/m);
  assert.match(voiceEnvironment, /^SUARA_JUDGE_ACCESS_CODE=$/m);
  assert.match(voiceEnvironment, /^SUARA_LISTEN_HOST=127\.0\.0\.1$/m);
  assert.match(voiceEnvironment, /^SUARA_PUBLIC_ORIGIN=https:\/\/__DOMAIN__$/m);
  assert.doesNotMatch(voiceEnvironment, /^ASSEMBLYAI_API_KEY=.+$/m);
  assert.match(voiceEnvironment, /^SUARA_SESSION_RATE_LIMIT=6$/m);
  assert.match(voiceEnvironment, /^SUARA_TOKEN_RATE_LIMIT=2$/m);
  assert.match(voiceEnvironment, /^SUARA_GLOBAL_TOKEN_RATE_LIMIT=6$/m);
  assert.match(voiceEnvironment, /^SUARA_DAILY_TOKEN_LIMIT=60$/m);
  assert.match(voiceEnvironment, /^SUARA_QUOTA_FILE=\/var\/lib\/suaravoice\/token-issuance\.json$/m);

  assert.match(voiceInstaller, /chmod 0600 .*voice\.env/);
  assert.match(voiceInstaller, /dnf module install -y nodejs:22/);
  assert.match(voiceInstaller, /node_major.*!= 22.*node_major.*!= 24/);
  assert.match(voiceInstaller, /setsebool -P httpd_can_network_connect on/);
  assert.match(voiceInstaller, /--retry-connrefused/);
  assert.match(voiceInstaller, /sudoedit \/etc\/suara\/voice\.env/);
  assert.match(voiceInstaller, /http:\/\/127\.0\.0\.1:8787\/healthz/);
  assert.match(voiceInstaller, /systemctl stop suara-voice\.service/);
  assert.match(voiceService, /DynamicUser=yes/);
  assert.match(voiceService, /^StateDirectory=suaravoice$/m);
  assert.match(voiceService, /^StateDirectoryMode=0700$/m);
  assert.match(voiceService, /EnvironmentFile=\/etc\/suara\/voice\.env/);
  assert.match(voiceService, /NoNewPrivileges=yes/);
  assert.match(voiceService, /ProtectSystem=strict/);
  assert.match(voiceService, /RestrictAddressFamilies=AF_INET AF_INET6/);
});

const bashPath = process.platform === "win32"
  ? join(process.env.ProgramFiles || "C:/Program Files", "Git/bin/bash.exe")
  : "/bin/bash";

test("release cleanup preserves a live release if either restoration command fails", {
  skip: !existsSync(bashPath) && "Bash is not installed",
}, () => {
  const restoreFunction = publish.slice(publish.indexOf("restore_prior_state() {"), publish.indexOf("cleanup_failed_release() {"));
  const cleanupFunction = publish.slice(publish.indexOf("cleanup_failed_release() {"), publish.indexOf("trap cleanup_failed_release EXIT"));
  for (const failingCommand of ["ln", "mv"]) {
    const script = [
      "set -euo pipefail",
      'fixture="$(mktemp -d)"',
      'trap \'command rm -rf -- "${fixture}"\' EXIT',
      'web_root="${fixture}/web"; releases_root="${web_root}/releases"',
      'release_dir="${releases_root}/new"; current_target="${releases_root}/old"; work_dir="${web_root}/work"',
      'mkdir -p "${release_dir}" "${current_target}" "${work_dir}"',
      'published=0; activated=1; removed=""',
      'rm() { removed="${removed} $*"; }',
      `ln() { ${failingCommand === "ln" ? "return 1" : "return 0"}; }`,
      'mv() { return 1; }',
      restoreFunction,
      cleanupFunction,
      "cleanup_failed_release",
      '[[ "${activated}" -eq 1 ]] || { echo "failed restoration was reported successful"; exit 1; }',
      '[[ "${removed}" != *"${release_dir}"* ]] || { echo "live release was removed"; exit 1; }',
    ].join("\n").replaceAll("\r", "");
    const result = spawnSync(bashPath, ["-s"], { input: script, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, `${failingCommand} failure: ${result.stderr}${result.stdout}`);
    assert.match(result.stderr, /preserving the new release/);
  }
});

test("rollback restoration does not clear its active flag when a move fails", {
  skip: !existsSync(bashPath) && "Bash is not installed",
}, () => {
  const restoreFunction = rollback.slice(rollback.indexOf("restore_newer_release() {"), rollback.indexOf("cleanup_failed_rollback() {"));
  const script = [
    "set -euo pipefail",
    'current_target="/fixture/old"; web_root="/fixture"; work_dir="/fixture/work"; rollback_active=1',
    'ln() { return 0; }; mv() { return 1; }',
    restoreFunction,
    'if restore_newer_release; then echo "failed move reported success"; exit 1; fi',
    '[[ "${rollback_active}" -eq 1 ]]',
  ].join("\n").replaceAll("\r", "");
  const result = spawnSync(bashPath, ["-s"], { input: script, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("all Oracle shell scripts parse with Bash", {
  skip: !existsSync(bashPath) && "Bash is not installed",
}, () => {
  for (const script of [bootstrap, publish, rollback, tls, voiceInstaller]) {
    const result = spawnSync(bashPath, ["-n"], { input: script.replaceAll("\r", ""), encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("Pages deployment timeout exceeds the action polling timeout", () => {
  assert.match(pagesWorkflow, /deploy:\s+[\s\S]*timeout-minutes: 20/);
  assert.match(pagesWorkflow, /actions\/deploy-pages@/);
  assert.match(pagesWorkflow, /timeout: 900000/);
});
