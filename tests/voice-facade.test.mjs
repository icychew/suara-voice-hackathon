import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, link, symlink } from "node:fs/promises";
import * as quotaFs from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createVoiceFacade, loadConfig } from "../server/voice-facade.mjs";

const ORIGIN = "https://demo.suaraproject.tech";
const HOST = "demo.suaraproject.tech";
const ACCESS_CODE = "test-judge-access-code-only";

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "suara-voice-facade-"));
  await mkdir(join(root, "site"));
  await mkdir(join(root, "site", "assets"));
  await mkdir(join(root, "site", "voice"));
  await mkdir(join(root, "state"), { mode: 0o700 });
  await writeFile(join(root, "state", "quota.json"), JSON.stringify({ version: 1, timestamps: [] }), { mode: 0o600 });
  await writeFile(join(root, "site", "index.html"), "<!doctype html><title>Suara test</title>");
  await writeFile(join(root, "site", "assets", "app.js"), "export const ready = true;\n");
  await writeFile(join(root, "site", "voice", "index.html"), "<!doctype html><title>Suara voice test</title>");
  return root;
}

function environment(root, overrides = {}) {
  return {
    ASSEMBLYAI_API_KEY: "test-provider-key-never-sent-live",
    SUARA_JUDGE_ACCESS_CODE: ACCESS_CODE,
    NODE_ENV: "production",
    SUARA_ALLOWED_HOSTS: HOST,
    SUARA_DIST_ROOT: join(root, "site"),
    SUARA_QUOTA_FILE: resolve(root, "state", "quota.json"),
    SUARA_PUBLIC_ORIGIN: ORIGIN,
    ...overrides,
  };
}

async function startFacade(options = {}) {
  const root = options.root || await makeFixture();
  const facade = createVoiceFacade({
    env: environment(root, options.env),
    fetchImpl: options.fetchImpl || (() => {
      throw new Error("unexpected provider call");
    }),
    now: options.now,
    quotaFs: options.quotaFs,
  });
  await new Promise((resolve, reject) => {
    facade.server.once("error", reject);
    facade.server.listen(0, "127.0.0.1", resolve);
  });
  return { facade, port: facade.server.address().port, root };
}

async function stopFacade(context) {
  await context.facade.close();
  await rm(context.root, { force: true, recursive: true });
}

function request(port, { body, headers = {}, method = "GET", path = "/" } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      headers: { Host: HOST, "X-Forwarded-Proto": "https", ...headers },
      host: "127.0.0.1",
      method,
      path,
      port,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ headers: response.headers, json, status: response.statusCode, text });
      });
    });
    outgoing.on("error", reject);
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
}

async function issueSession(port, headers = {}) {
  const response = await request(port, { headers: { "X-Suara-Access-Code": ACCESS_CODE, ...headers }, path: "/api/session" });
  assert.equal(response.status, 200);
  assert.match(response.json.token, /^[A-Za-z0-9_-]{43}$/);
  return response.json.token;
}

test("configuration fails closed without exact hosts, HTTPS origin, or provider key", () => {
  assert.throws(() => loadConfig({}), /SUARA_PUBLIC_ORIGIN/);
  assert.throws(() => loadConfig({
    ASSEMBLYAI_API_KEY: "x",
    NODE_ENV: "production",
    SUARA_ALLOWED_HOSTS: "demo.suaraproject.tech",
    SUARA_PUBLIC_ORIGIN: "http://demo.suaraproject.tech",
  }), /HTTPS/);
  assert.throws(() => loadConfig({
    ASSEMBLYAI_API_KEY: "x",
    NODE_ENV: "production",
    SUARA_ALLOWED_HOSTS: "example.test",
    SUARA_PUBLIC_ORIGIN: ORIGIN,
  }), /must include/);
  assert.throws(() => loadConfig({
    NODE_ENV: "production",
    SUARA_ALLOWED_HOSTS: HOST,
    SUARA_PUBLIC_ORIGIN: ORIGIN,
  }), /ASSEMBLYAI_API_KEY/);

  const config = loadConfig(environment("dist"));
  assert.equal(config.sessionRateLimit, 6);
  assert.equal(config.tokenRateLimit, 2);
  assert.equal(config.globalTokenRateLimit, 6);
  assert.equal(config.dailyTokenLimit, 60);
  assert.throws(() => loadConfig(environment("dist", { SUARA_JUDGE_ACCESS_CODE: undefined })), /SUARA_JUDGE_ACCESS_CODE/);
  assert.throws(() => loadConfig(environment("dist", { SUARA_JUDGE_ACCESS_CODE: "weak" })), /SUARA_JUDGE_ACCESS_CODE/);
  assert.throws(() => loadConfig(environment("dist", { SUARA_QUOTA_FILE: undefined })), /SUARA_QUOTA_FILE/);
  assert.throws(() => loadConfig(environment("dist", { SUARA_QUOTA_FILE: "relative.json" })), /absolute/);
  assert.throws(() => loadConfig(environment("dist", { SUARA_QUOTA_FILE: resolve("dist/site/quota.json") })), /outside/);
});

async function mint(port, ip = "203.0.113.42") {
  const token = await issueSession(port, { "X-Real-IP": ip });
  return request(port, { method: "POST", path: "/api/voice/token",
    headers: { Origin: ORIGIN, Authorization: `Bearer ${token}`, "X-Real-IP": ip },
  });
}

test("operator-only artifact marker blocks production startup but permits a local development canary", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "site/suara-operator-only.json"), '{"operatorOnly":true}');
  assert.throws(() => createVoiceFacade({ env: environment(root) }), /Operator-only artifacts/);
  const facade = createVoiceFacade({ env: environment(root, { NODE_ENV: "development" }) });
  await facade.close();
});

test("durable rolling-day reservations survive repeated graceful restarts and expire exactly", async (t) => {
  const root = await makeFixture();
  let context;
  t.after(async () => { await context?.facade.close(); await rm(root, { recursive: true, force: true }); });
  let current = 100_000;
  let calls = 0;
  const options = { root, now: () => current, env: { SUARA_DAILY_TOKEN_LIMIT: "1" },
    fetchImpl: async () => { calls += 1; return new Response("provider failure", { status: 500 }); },
  };
  context = await startFacade(options);
  assert.equal((await mint(context.port)).status, 502);
  const ledger = JSON.parse(await readFile(join(root, "state/quota.json"), "utf8"));
  assert.deepEqual(ledger, { version: 1, timestamps: [100_000] });
  for (let restart = 0; restart < 2; restart += 1) {
    await context.facade.close();
    context = await startFacade(options);
    assert.equal((await mint(context.port)).status, 429);
    assert.equal(calls, 1);
  }
  current += 86_400_000;
  assert.equal((await mint(context.port)).status, 502);
  assert.equal(calls, 2);
});

test("concurrent distinct sessions reserve only the available durable slots before provider calls", async (t) => {
  let calls = 0;
  const context = await startFacade({ env: { SUARA_DAILY_TOKEN_LIMIT: "2" }, fetchImpl: async () => {
    const recorded = JSON.parse(quotaFs.readFileSync(join(context.root, "state/quota.json"), "utf8"));
    assert.ok(recorded.timestamps.length > calls, "ledger slot must exist before provider entry");
    calls += 1;
    return new Response(JSON.stringify({ token: "provider-token-for-browser" }));
  } });
  t.after(() => stopFacade(context));
  const responses = await Promise.all([1, 2, 3, 4].map((n) => mint(context.port, `203.0.113.${n}`)));
  assert.deepEqual(responses.map((item) => item.status).sort(), [200, 200, 429, 429]);
  assert.equal(calls, 2);
});

test("future ledger timestamps remain counted after clock rollback", async (t) => {
  const root = await makeFixture();
  await writeFile(join(root, "state/quota.json"), JSON.stringify({ version: 1, timestamps: [200_000] }));
  const context = await startFacade({ root, now: () => 100_000, env: { SUARA_DAILY_TOKEN_LIMIT: "1" } });
  t.after(() => stopFacade(context));
  const response = await mint(context.port);
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers["retry-after"]) > 86_400);
});

test("missing, corrupt, oversized, nonregular and hardlinked ledgers fail startup closed", async () => {
  for (const kind of ["missing", "corrupt", "oversized", "directory", "hardlink", "schema"]) {
    const root = await makeFixture();
    const file = join(root, "state/quota.json");
    try {
      if (kind === "missing" || kind === "directory") await rm(file);
      if (kind === "directory") await mkdir(file);
      if (kind === "corrupt") await writeFile(file, "not-json");
      if (kind === "oversized") await writeFile(file, " ".repeat(180_001));
      if (kind === "hardlink") await link(file, join(root, "state/second.json"));
      if (kind === "schema") await writeFile(file, JSON.stringify({ version: 1, timestamps: [], token: "forbidden" }));
      assert.throws(() => createVoiceFacade({ env: environment(root) }), undefined, kind);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("a second writer is rejected without disturbing the owner's ledger or lock", async (t) => {
  const context = await startFacade();
  t.after(() => stopFacade(context));
  assert.throws(() => createVoiceFacade({ env: environment(context.root) }), /EEXIST/);
  assert.deepEqual(JSON.parse(await readFile(join(context.root, "state/quota.json"), "utf8")), { version: 1, timestamps: [] });
});

test("symlinked ledgers, redirected state inside static files and unsafe lock targets are refused", async () => {
  for (const kind of ["ledger-symlink", "static-parent", "lock-directory", "lock-symlink", "lock-hardlink"]) {
    const root = await makeFixture();
    const file = join(root, "state/quota.json");
    try {
      let configured = file;
      if (kind === "ledger-symlink") {
        await rm(file);
        // Junctions require no Windows symlink privilege, and are still symlinks
        // that the ledger must refuse before attempting to read their target.
        await symlink(join(root, "site"), file, "junction");
      }
      if (kind === "static-parent") {
        const alias = join(root, "alias");
        await symlink(join(root, "site"), alias, "junction");
        configured = join(alias, "quota.json");
      }
      if (kind === "lock-directory") await mkdir(`${file}.lock`);
      if (kind === "lock-symlink") await symlink(join(root, "site"), `${file}.lock`, "junction");
      if (kind === "lock-hardlink") await link(file, `${file}.lock`);
      assert.throws(() => createVoiceFacade({ env: environment(root, { SUARA_QUOTA_FILE: configured }) }), undefined, kind);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("runtime corruption and write failures never call the provider or reveal ledger details", async (t) => {
  for (const kind of ["read", "write", "sync", "rename", "corrupt"]) {
    let armed = false;
    let calls = 0;
    const fail = () => { throw new Error("sensitive ledger path EACCES"); };
    const context = await startFacade({
      quotaFs: { ...quotaFs,
        readSync: (...args) => armed && kind === "read" ? fail() : quotaFs.readSync(...args),
        writeFileSync: (...args) => armed && kind === "write" ? fail() : quotaFs.writeFileSync(...args),
        fsyncSync: (...args) => armed && kind === "sync" ? fail() : quotaFs.fsyncSync(...args),
        renameSync: (...args) => armed && kind === "rename" ? fail() : quotaFs.renameSync(...args),
      },
      fetchImpl: async () => { calls += 1; throw new Error("must not call provider"); },
    });
    t.after(() => stopFacade(context));
    armed = true;
    if (kind === "corrupt") await writeFile(join(context.root, "state/quota.json"), "{");
    const response = await mint(context.port);
    assert.equal(response.status, 503, kind);
    assert.deepEqual(response.json, { error: "quota_unavailable" });
    assert.equal(calls, 0);
  }
});

test("abrupt process death leaves a conservative stale lock and preserves reserved usage", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleUrl = new URL("../server/voice-facade.mjs", import.meta.url).href;
  const script = `import { createVoiceFacade } from ${JSON.stringify(moduleUrl)};
    const facade = createVoiceFacade({ env: JSON.parse(process.env.SUARA_TEST_ENV),
      fetchImpl: async () => new Response(JSON.stringify({token:'provider-test-token'})) });
    facade.server.listen(0, '127.0.0.1', () => process.stdout.write(String(facade.server.address().port)+'\\n'));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, SUARA_TEST_ENV: JSON.stringify(environment(root)) }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const port = await new Promise((resolvePort, reject) => {
    child.stdout.once("data", (chunk) => resolvePort(Number(String(chunk).trim())));
    child.once("error", reject);
    child.once("exit", () => reject(new Error("child exited before ready")));
  });
  assert.equal((await mint(port)).status, 200);
  const exited = new Promise((finish) => child.once("exit", finish));
  child.kill("SIGKILL");
  await exited;
  assert.throws(() => createVoiceFacade({ env: environment(root) }), /EEXIST/);
  assert.equal(JSON.parse(await readFile(join(root, "state/quota.json"), "utf8")).timestamps.length, 1);
});

test("judge access gate fails closed and throttles failed attempts before issuing a bearer", async (t) => {
  const context = await startFacade({ env: { SUARA_SESSION_RATE_LIMIT: "2" } });
  t.after(() => stopFacade(context));
  for (const headers of [{}, { "X-Suara-Access-Code": "incorrect-code" }]) {
    const response = await request(context.port, { path: "/api/session", headers });
    assert.equal(response.status, 401);
    assert.deepEqual(response.json, { error: "access_code_required" });
    assert.doesNotMatch(response.text, /test-judge-access/);
  }
  const limited = await request(context.port, {
    path: "/api/session", headers: { "X-Suara-Access-Code": ACCESS_CODE },
  });
  assert.equal(limited.status, 429);
});

test("chunked upstream responses stop reading and cancel as soon as the byte cap is exceeded", async (t) => {
  let pulls = 0;
  let cancelled = false;
  const context = await startFacade({
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(4_096));
      },
      cancel() { cancelled = true; },
    })),
  });
  t.after(() => stopFacade(context));
  const token = await issueSession(context.port);
  const failed = await request(context.port, {
    headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN },
    method: "POST", path: "/api/voice/token",
  });
  assert.equal(failed.status, 502);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 4, `only the cap plus at most one queued chunk may be read; got ${pulls}`);
});

test("concurrent replay reserves a single-use bearer before awaiting the provider", async (t) => {
  let resolveProvider;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const context = await startFacade({ fetchImpl: () => {
    entered();
    return new Promise((resolve) => { resolveProvider = resolve; });
  } });
  t.after(() => stopFacade(context));
  const token = await issueSession(context.port);
  const options = { headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN }, method: "POST", path: "/api/voice/token" };
  const first = request(context.port, options);
  await started;
  assert.equal((await request(context.port, options)).status, 401);
  resolveProvider(new Response(JSON.stringify({ token: "provider-token-for-browser" })));
  assert.equal((await first).status, 200);
});

test("disconnecting the browser aborts the pending provider request", async (t) => {
  let entered;
  let aborted;
  const started = new Promise((resolve) => { entered = resolve; });
  const cancelled = new Promise((resolve) => { aborted = resolve; });
  const context = await startFacade({ fetchImpl: (_url, { signal }) => {
    entered();
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted(); reject(signal.reason); }, { once: true });
    });
  } });
  t.after(() => stopFacade(context));
  const token = await issueSession(context.port);
  const outgoing = http.request({ host: "127.0.0.1", port: context.port, path: "/api/voice/token", method: "POST",
    headers: { Host: HOST, "X-Forwarded-Proto": "https", Origin: ORIGIN, Authorization: `Bearer ${token}` },
  });
  outgoing.on("error", () => {});
  outgoing.end();
  await started;
  outgoing.destroy();
  await cancelled;
});

test("health and built files are served with no-store and browser security headers", async (t) => {
  const context = await startFacade();
  t.after(() => stopFacade(context));

  const health = await request(context.port, { path: "/healthz" });
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { status: "ok" });
  assert.equal(health.headers["cache-control"], "no-store");
  assert.equal(health.headers["x-content-type-options"], "nosniff");

  const page = await request(context.port);
  assert.equal(page.status, 200);
  assert.match(page.text, /Suara test/);
  assert.match(page.headers["content-security-policy"], /wss:\/\/agents\.assemblyai\.com/);
  assert.equal(page.headers["permissions-policy"].includes("microphone=(self)"), true);

  const voicePage = await request(context.port, { path: "/voice/" });
  assert.equal(voicePage.status, 200);
  assert.match(voicePage.text, /Suara voice test/);

  const head = await request(context.port, { method: "HEAD", path: "/assets/app.js" });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
  assert.equal(head.headers["content-type"], "text/javascript; charset=utf-8");
});

test("host, path, method, query, and body allowlists fail closed", async (t) => {
  const context = await startFacade();
  t.after(() => stopFacade(context));

  assert.equal((await request(context.port, { headers: { Host: "attacker.test" } })).status, 421);
  assert.equal((await request(context.port, { method: "DELETE" })).status, 405);
  assert.equal((await request(context.port, { path: "/api/unknown" })).status, 404);
  assert.equal((await request(context.port, {
    headers: { "X-Forwarded-Proto": "http" },
    path: "/api/session",
  })).status, 403);
  assert.equal((await request(context.port, { path: "/api/session?unused=1" })).status, 400);
  assert.equal((await request(context.port, {
    body: "not accepted",
    headers: { "Content-Type": "text/plain" },
    method: "POST",
    path: "/api/voice/token",
  })).status, 413);
  assert.equal((await request(context.port, { path: "/%2e%2e/secret" })).status, 400);
});

test("voice-token exchange requires exact origin and a one-use local bearer", async (t) => {
  const calls = [];
  const context = await startFacade({
    fetchImpl: async (url, options) => {
      calls.push({ options, url: url.toString() });
      return new Response(JSON.stringify({ token: "provider-token-for-browser" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    },
  });
  t.after(() => stopFacade(context));

  const token = await issueSession(context.port);
  const rejected = await request(context.port, {
    headers: { Authorization: `Bearer ${token}`, Origin: "https://attacker.test" },
    method: "POST",
    path: "/api/voice/token",
  });
  assert.equal(rejected.status, 403);
  assert.equal(calls.length, 0);

  const minted = await request(context.port, {
    headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN },
    method: "POST",
    path: "/api/voice/token",
  });
  assert.equal(minted.status, 200);
  assert.deepEqual(minted.json, {
    expires_in_seconds: 60,
    max_session_duration_seconds: 600,
    token: "provider-token-for-browser",
  });
  assert.equal(minted.headers["access-control-allow-origin"], undefined);
  assert.equal(calls.length, 1);

  const providerUrl = new URL(calls[0].url);
  assert.equal(`${providerUrl.origin}${providerUrl.pathname}`, "https://agents.assemblyai.com/v1/token");
  assert.equal(providerUrl.searchParams.get("expires_in_seconds"), "60");
  assert.equal(providerUrl.searchParams.get("max_session_duration_seconds"), "600");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-provider-key-never-sent-live");

  const replay = await request(context.port, {
    headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN },
    method: "POST",
    path: "/api/voice/token",
  });
  assert.equal(replay.status, 401);
  assert.equal(calls.length, 1);
});

test("expired sessions and per-IP issuance limits do not call the provider", async (t) => {
  let current = 1_000;
  let providerCalls = 0;
  const context = await startFacade({
    env: { SUARA_SESSION_RATE_LIMIT: "3", SUARA_TOKEN_RATE_LIMIT: "1" },
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ token: "provider-token-for-browser" }));
    },
    now: () => current,
  });
  t.after(() => stopFacade(context));

  const expiredToken = await issueSession(context.port, { "X-Real-IP": "203.0.113.10" });
  current += 121_000;
  const expired = await request(context.port, {
    headers: {
      Authorization: `Bearer ${expiredToken}`,
      Origin: ORIGIN,
      "X-Real-IP": "203.0.113.10",
    },
    method: "POST",
    path: "/api/voice/token",
  });
  assert.equal(expired.status, 401);

  const first = await issueSession(context.port, { "X-Real-IP": "203.0.113.10" });
  const second = await issueSession(context.port, { "X-Real-IP": "203.0.113.10" });
  assert.equal((await request(context.port, {
    headers: { Authorization: `Bearer ${first}`, Origin: ORIGIN, "X-Real-IP": "203.0.113.10" },
    method: "POST",
    path: "/api/voice/token",
  })).status, 200);
  const limited = await request(context.port, {
    headers: { Authorization: `Bearer ${second}`, Origin: ORIGIN, "X-Real-IP": "203.0.113.10" },
    method: "POST",
    path: "/api/voice/token",
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "60");
  assert.equal(providerCalls, 1);
});

test("server-wide minute and rolling-day caps bound provider-token issuance across IPs", async (t) => {
  let current = 10_000;
  let providerCalls = 0;
  const context = await startFacade({
    env: {
      SUARA_DAILY_TOKEN_LIMIT: "2",
      SUARA_GLOBAL_TOKEN_RATE_LIMIT: "1",
      SUARA_SESSION_RATE_LIMIT: "10",
      SUARA_TOKEN_RATE_LIMIT: "5",
    },
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ token: `provider-token-${providerCalls}` }));
    },
    now: () => current,
  });
  t.after(() => stopFacade(context));

  const mintFrom = async (ip) => {
    const token = await issueSession(context.port, { "X-Real-IP": ip });
    return request(context.port, {
      headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN, "X-Real-IP": ip },
      method: "POST",
      path: "/api/voice/token",
    });
  };

  assert.equal((await mintFrom("203.0.113.11")).status, 200);
  const minuteLimited = await mintFrom("203.0.113.12");
  assert.equal(minuteLimited.status, 429);
  assert.equal(minuteLimited.headers["retry-after"], "60");

  current += 61_000;
  assert.equal((await mintFrom("203.0.113.12")).status, 200);
  current += 61_000;
  const dayLimited = await mintFrom("203.0.113.13");
  assert.equal(dayLimited.status, 429);
  assert.equal(Number(dayLimited.headers["retry-after"]) > 86_000, true);
  assert.equal(providerCalls, 2);
});

test("upstream failures are generic and never echo provider details or keys", async (t) => {
  const context = await startFacade({
    fetchImpl: async () => new Response("credential rejected: sensitive-provider-detail", { status: 401 }),
  });
  t.after(() => stopFacade(context));

  const token = await issueSession(context.port);
  const failed = await request(context.port, {
    headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN },
    method: "POST",
    path: "/api/voice/token",
  });
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.json, { error: "voice_token_unavailable" });
  assert.doesNotMatch(failed.text, /credential|sensitive|provider-key/i);
});

test("Streaming facade is disabled by default without consuming a bearer or reserving usage", async t => {
  let calls = 0;
  const context = await startFacade({ fetchImpl: async () => {
    calls++;
    return Response.json({ token: "synthetic-provider-token" });
  } });
  t.after(() => stopFacade(context));
  assert.equal(loadConfig(environment(context.root)).streamingEnabled, false);
  for (const value of ["false", "TRUE", "1", true]) {
    assert.equal(loadConfig(environment(context.root, { SUARA_ENABLE_STREAMING_VOICE: value })).streamingEnabled, false);
  }
  const token = await issueSession(context.port);
  const headers = { Origin: ORIGIN, Authorization: `Bearer ${token}` };
  const disabled = await request(context.port, { method: "POST", path: "/api/streaming/token", headers });
  assert.equal(disabled.status, 503);
  assert.deepEqual(disabled.json, { error: "streaming_not_configured" });
  assert.equal(calls, 0);
  const enabledManaged = await request(context.port, { method: "POST", path: "/api/voice/token", headers });
  assert.equal(enabledManaged.status, 200);
  assert.equal(calls, 1);
});

test("Streaming facade uses the raw-key GET mint and shares one-use bearers with managed voice", async t => {
  const calls = [];
  const context = await startFacade({ env: { SUARA_ENABLE_STREAMING_VOICE: "true" }, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ token: "synthetic-streaming-token" });
  } });
  t.after(() => stopFacade(context));
  const token = await issueSession(context.port);
  const headers = { Origin: ORIGIN, Authorization: `Bearer ${token}` };
  const result = await request(context.port, { method: "POST", path: "/api/streaming/token", headers });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { token: "synthetic-streaming-token", expires_in_seconds: 60, max_session_duration_seconds: 600 });
  assert.equal(calls[0].url.origin + calls[0].url.pathname, "https://streaming.assemblyai.com/v3/token");
  assert.equal(calls[0].options.headers.Authorization, "test-provider-key-never-sent-live");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual([...calls[0].url.searchParams], [["expires_in_seconds", "60"], ["max_session_duration_seconds", "600"]]);
  const replay = await request(context.port, { method: "POST", path: "/api/voice/token", headers });
  assert.equal(replay.status, 401);
  assert.equal(calls.length, 1);
  const page = await request(context.port);
  assert.equal(page.headers["content-security-policy"].split(";").map(item => item.trim())
    .find(item => item.startsWith("connect-src ")),
  "connect-src 'self' wss://agents.assemblyai.com wss://streaming.assemblyai.com");
});

test("local facade refuses AI-question grants without consuming ordinary Streaming access", async t => {
  let calls = 0;
  const context = await startFacade({ env: { SUARA_ENABLE_STREAMING_VOICE: "true", SUARA_ENABLE_AI_QUESTIONS: "true" },
    fetchImpl: async () => { calls++; return Response.json({ token: "synthetic-provider-token" }); },
  });
  t.after(() => stopFacade(context));
  const token = await issueSession(context.port);
  const headers = { Origin: ORIGIN, Authorization: `Bearer ${token}` };
  for (const path of ["/api/streaming/token", "/api/voice/token"]) {
    const result = await request(context.port, { method: "POST", path,
      headers: { ...headers, "X-Suara-Question-Policy": "bank-v1" } });
    assert.equal(result.status, 503);
    assert.deepEqual(result.json, { error: "questions_not_configured" });
  }
  assert.equal(calls, 0);
  const ordinary = await request(context.port, { method: "POST", path: "/api/streaming/token", headers });
  assert.equal(ordinary.status, 200);
  assert.equal(calls, 1);
});

test("Streaming facade rejects bodies, queries, wrong origins and wrong methods before mint", async t => {
  const context = await startFacade({ env: { SUARA_ENABLE_STREAMING_VOICE: "true" } });
  t.after(() => stopFacade(context));
  const token = await issueSession(context.port);
  const headers = { Origin: ORIGIN, Authorization: `Bearer ${token}` };
  for (const [options, status] of [
    [{ method: "GET" }, 405],
    [{ path: "/api/streaming/token?model=expensive" }, 400],
    [{ headers: { ...headers, Origin: "https://evil.example" } }, 403],
    [{ headers: { Authorization: `Bearer ${token}` } }, 403],
    [{ body: "private transcript" }, 413],
  ]) {
    const result = await request(context.port, { method: "POST", path: "/api/streaming/token", headers, ...options });
    assert.equal(result.status, status);
  }
});

test("Streaming and managed facade routes consume one shared daily ledger", async t => {
  let calls = 0;
  const context = await startFacade({ env: { SUARA_ENABLE_STREAMING_VOICE: "true", SUARA_DAILY_TOKEN_LIMIT: "1" },
    fetchImpl: async () => { calls++; return Response.json({ token: "synthetic-provider-token" }); },
  });
  t.after(() => stopFacade(context));
  const one = await issueSession(context.port);
  const first = await request(context.port, { method: "POST", path: "/api/streaming/token",
    headers: { Origin: ORIGIN, Authorization: `Bearer ${one}` },
  });
  assert.equal(first.status, 200);
  const two = await issueSession(context.port);
  const second = await request(context.port, { method: "POST", path: "/api/voice/token",
    headers: { Origin: ORIGIN, Authorization: `Bearer ${two}` },
  });
  assert.equal(second.status, 429);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(join(context.root, "state", "quota.json"), "utf8")).timestamps.length, 1);
});
