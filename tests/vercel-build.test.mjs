import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const validator = fileURLToPath(new URL("../scripts/validate-vercel-build.mjs", import.meta.url));
const checkedInConfig = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const ownedFixtures = new Set();
const comparablePath = (value) => process.platform === "win32" ? value.toLowerCase() : value;

async function removeFixture(directory) {
  const target = resolve(directory);
  assert.ok(ownedFixtures.has(target), "cleanup must only remove a fixture created by this test");
  assert.equal(comparablePath(dirname(target)), comparablePath(resolve(tmpdir())));
  assert.match(basename(target), /^suara-vercel-build-test-[A-Za-z0-9]+$/u);
  const entry = await lstat(target);
  assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
  assert.equal(comparablePath(dirname(await realpath(target))), comparablePath(await realpath(tmpdir())));
  await rm(target, { recursive: true, force: true });
  ownedFixtures.delete(target);
}

async function validateFixture(t, mutate = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "suara-vercel-build-test-"));
  ownedFixtures.add(resolve(directory));
  t.after(() => removeFixture(directory));
  await chmod(directory, 0o700);
  const config = structuredClone(checkedInConfig);
  mutate(config);
  await writeFile(join(directory, "vercel.json"), JSON.stringify(config), { mode: 0o600 });
  for (const route of ["", "prototype", "voice"]) {
    const folder = join(directory, "dist", route);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(join(folder, "index.html"), "<!doctype html><title>Synthetic build fixture</title>", { mode: 0o600 });
  }
  // Run the real validator without inheriting credentials or Node preload options.
  const environment = process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {};
  const child = spawnSync(process.execPath, ["--", validator], {
    cwd: directory, env: environment, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
  });
  assert.equal(child.error, undefined, "validator process must launch and finish within its bound");
  assert.equal(child.signal, null, "validator must exit normally");
  return child;
}

test("checked-in Vercel configuration passes the real validator with all three static routes", async (t) => {
  const child = await validateFixture(t);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  assert.match(child.stdout, /Vercel normal artifact verified/);
});

test("Vercel build validator refuses missing, wrong, or multiple project regions", async (t) => {
  const cases = [
    ["missing region", (config) => { delete config.regions; }],
    ["wrong region", (config) => { config.regions = ["iad1"]; }],
    ["multiple regions", (config) => { config.regions = ["sin1", "iad1"]; }],
  ];
  for (const [label, mutate] of cases) {
    const child = await validateFixture(t, mutate);
    assert.equal(child.status, 1, label);
    assert.match(child.stderr, /AssertionError/, label);
    assert.doesNotMatch(child.stdout, /Vercel normal artifact verified/, label);
  }
});

test("Vercel build validator rejects function overrides and duration or cancellation drift", async (t) => {
  const cases = [["extra wildcard", (config) => {
    config.functions["api/**/*.js"] = { maxDuration: 20, supportsCancellation: true };
  }]];
  for (const route of Object.keys(checkedInConfig.functions)) {
    const expectedDuration = checkedInConfig.functions[route].maxDuration;
    cases.push(
      [`${route} region override`, (config) => { config.functions[route].regions = ["iad1"]; }],
      [`${route} duration drift`, (config) => { config.functions[route].maxDuration = expectedDuration + 10; }],
      [`${route} cancellation drift`, (config) => { config.functions[route].supportsCancellation = false; }],
    );
  }
  for (const [label, mutate] of cases) {
    const child = await validateFixture(t, mutate);
    assert.equal(child.status, 1, label);
    assert.match(child.stderr, /AssertionError/, label);
    assert.doesNotMatch(child.stdout, /Vercel normal artifact verified/, label);
  }
});

test("Vercel build validator refuses missing required functions or broader socket destinations", async t => {
  const cases = [
    config => { delete config.functions["api/health.js"]; },
    config => { delete config.functions["api/capabilities.js"]; },
    config => { delete config.functions["api/streaming/token.js"]; },
    config => { delete config.functions["api/interview/question.js"]; },
    config => { config.headers[0].headers.find(item => item.key === "Content-Security-Policy").value =
      "default-src 'self'; connect-src 'self' wss:;"; },
    config => { config.headers[0].headers.find(item => item.key === "Content-Security-Policy").value =
      "default-src 'self'; connect-src 'self' wss://agents.assemblyai.com;"; },
  ];
  if (Object.hasOwn(checkedInConfig.functions, "api/slack/events.js")) {
    cases.push(config => { delete config.functions["api/slack/events.js"]; });
  }
  for (const mutate of cases) {
    const child = await validateFixture(t, mutate);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /AssertionError/);
  }
});
