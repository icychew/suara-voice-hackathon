import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat, lstat, realpath, unlink, link, symlink, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { initializeVercelState, runCli } from "../scripts/init-vercel-state.mjs";

const CONFIG = "# Synthetic credentials: never sent to a real service\nUPSTASH_REDIS_REST_URL=https://synthetic-only.upstash.io\nUPSTASH_REDIS_REST_TOKEN=synthetic-test-token\nSUARA_REDIS_PREFIX=suara-stable-pilot\nASSEMBLYAI_API_KEY=unrelated-never-forwarded\n";
const safePermissions = async () => {};
const comparablePath = (value) => process.platform === "win32" ? value.toLowerCase() : value;
async function removeFixture(directory) {
  const target = resolve(directory);
  const temporary = resolve(tmpdir());
  assert.equal(comparablePath(dirname(target)), comparablePath(temporary), "cleanup must target a direct child of the exact temp directory");
  assert.match(basename(target), /^suara-init-(?:state|link)-test-[A-Za-z0-9]+$/u);
  const entry = await lstat(target);
  assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), "never recursively remove a linked fixture root");
  assert.equal(comparablePath(dirname(await realpath(target))), comparablePath(await realpath(temporary)), "resolved cleanup must remain inside the exact temp directory");
  await rm(target, { recursive: true, force: true });
}
async function fixture(t, content = CONFIG) {
  const directory = await mkdtemp(join(tmpdir(), "suara-init-state-test-"));
  const file = join(directory, "private.env");
  await writeFile(file, content, { mode: 0o600 });
  t.after(() => removeFixture(directory));
  return { directory, file };
}
function fakeFactory(result = { initialized: true }) {
  const observations = { factories: [], calls: 0 };
  observations.createState = (config) => {
    observations.factories.push(config);
    return {
      initialize: async () => { observations.calls++; return result; },
      saveSession: () => assert.fail("must not issue a session"),
      consumeSession: () => assert.fail("must not consume a session"),
      admitSession: () => assert.fail("must not admit a request"),
    };
  };
  return observations;
}
const deps = (factory, more = {}) => ({ initialize: true, createState: factory.createState, checkPermissions: safePermissions, ...more });

test("initializer import is inert and CLI refuses absent or malformed explicit authorization", async () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", "globalThis.fetch=()=>{throw new Error('unexpected fetch')}; await import('./scripts/init-vercel-state.mjs');"], {
    cwd: resolve(import.meta.dirname, ".."), encoding: "utf8",
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
  for (const args of [[], ["--private-config", "/synthetic.env"], ["--initialize"], ["--initialize", "/synthetic.env"],
    ["--initialize", "--private-config", "/synthetic.env", "--reset"], ["--initialize", "--private-config", ""],
    ["--initialize", "--env-file", "/synthetic.env"]]) {
    let output = ""; let calls = 0;
    assert.equal(await runCli(args, (value) => { output += value; }, async () => { calls++; }), 1);
    assert.deepEqual(JSON.parse(output), { status: "refused", reason: "usage" });
    assert.equal(calls, 0);
  }
  assert.deepEqual(await initializeVercelState("relative.env"), { status: "refused", reason: "confirmation_required" });
});

test("explicit initializer reads only named file, forwards only three Redis values, calls once, and leaves file untouched", async (t) => {
  const { file, directory } = await fixture(t);
  const before = await stat(file);
  const factory = fakeFactory();
  let permissions = 0;
  const result = await initializeVercelState(file, deps(factory, { checkPermissions: async (path) => { assert.equal(path, file); permissions++; } }));
  assert.deepEqual(result, { status: "initialized" });
  assert.equal(factory.calls, 1);
  assert.deepEqual(factory.factories, [{
    url: "https://synthetic-only.upstash.io", token: "synthetic-test-token", prefix: "suara-stable-pilot",
  }]);
  assert.equal(permissions, 2);
  assert.equal(await readFile(file, "utf8"), CONFIG);
  const after = await stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ctimeMs, before.ctimeMs);
  assert.deepEqual(await readdir(directory), ["private.env"]);
});

test("existing initialization is reported without reset, repair, retry or other state calls", async (t) => {
  const { file } = await fixture(t);
  const factory = fakeFactory({ initialized: false });
  assert.deepEqual(await initializeVercelState(file, deps(factory)), { status: "already_initialized" });
  assert.equal(factory.calls, 1);
});

test("dotenv accepts UTF-8 BOM, CRLF, comments and literal quoted assignments without expansion", async (t) => {
  const config = '\uFEFF# fixture\r\n UPSTASH_REDIS_REST_URL = "https://synthetic-only.upstash.io" # URL\r\nUPSTASH_REDIS_REST_TOKEN=\'literal-$TOKEN-value\'\r\nSUARA_REDIS_PREFIX = stable-pilot # keep across deploys\r\n';
  const { file } = await fixture(t, config);
  const factory = fakeFactory();
  assert.equal((await initializeVercelState(file, deps(factory))).status, "initialized");
  assert.equal(factory.factories[0].token, "literal-$TOKEN-value");
  assert.equal(factory.factories[0].prefix, "stable-pilot");
});

test("missing, duplicated, malformed, oversized or unsafe dotenv cannot create shared state", async (t) => {
  for (const content of [
    CONFIG.replace("synthetic-test-token", ""), CONFIG.replace(/^SUARA_REDIS_PREFIX=.*\n/m, ""),
    `${CONFIG}SUARA_REDIS_PREFIX=another\n`, `${CONFIG}ASSEMBLYAI_API_KEY=duplicate\n`,
    CONFIG.replace("UPSTASH_REDIS_REST_TOKEN=", "export UPSTASH_REDIS_REST_TOKEN="),
    CONFIG.replace("synthetic-test-token", '"unterminated'),
    CONFIG.replace("synthetic-test-token", '"escape\\nvalue"'),
    CONFIG.replace("https://synthetic-only.upstash.io", "https://synthetic-only.upstash.io?token=bad"),
    CONFIG.replace("https://synthetic-only.upstash.io", "https://attacker.example"),
    CONFIG.replace("suara-stable-pilot", "deploy/name"),
    `${CONFIG}\0`, CONFIG.replace("\n", "\r"), Buffer.from([0xff, 0xfe]), "x".repeat(65_537),
  ]) {
    const { file } = await fixture(t, content); const factory = fakeFactory();
    const result = await initializeVercelState(file, deps(factory));
    assert.equal(result.status, "refused");
    assert.ok(["invalid_config", "missing_config"].includes(result.reason));
    assert.equal(factory.calls, 0);
    assert.equal(factory.factories.length, 0);
  }
});

test("absolute path outside repository/cloud-sync storage is mandatory; no ambient env fallback", async (t) => {
  const { file } = await fixture(t); const factory = fakeFactory();
  for (const path of ["relative.env", "", null, join(resolve(import.meta.dirname, ".."), "synthetic-do-not-read.env"),
    join(tmpdir(), "OneDrive", "synthetic-do-not-read.env"), join(tmpdir(), "OneDrive - Example", "private.env")]) {
    assert.deepEqual(await initializeVercelState(path, deps(factory)), { status: "refused", reason: "invalid_path" });
  }
  const missing = `${file}.missing`;
  assert.deepEqual(await initializeVercelState(missing, deps(factory)), { status: "refused", reason: "file_operation_failed" });
  assert.equal(factory.factories.length, 0);
});

test("hard-linked files and directories are refused before reading config or initializing", async (t) => {
  const { file, directory } = await fixture(t); const factory = fakeFactory();
  await link(file, join(directory, "hardlink.env"));
  assert.deepEqual(await initializeVercelState(file, deps(factory)), { status: "refused", reason: "unsafe_file" });
  assert.deepEqual(await initializeVercelState(directory, deps(factory)), { status: "refused", reason: "unsafe_file" });
  assert.equal(factory.factories.length, 0);
});

test("directory symlinks/junctions cannot bypass the named protected path boundary", async (t) => {
  const { file, directory } = await fixture(t); const factory = fakeFactory();
  const linkParent = await mkdtemp(join(tmpdir(), "suara-init-link-test-"));
  const linked = join(linkParent, "linked");
  t.after(async () => {
    // Remove only the junction/symlink itself before recursive parent cleanup.
    try { await unlink(linked); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await removeFixture(linkParent);
  });
  await symlink(directory, linked, process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(await initializeVercelState(join(linked, "private.env"), deps(factory)), { status: "refused", reason: "unsafe_path" });
  assert.equal(factory.factories.length, 0);
  assert.equal(await readFile(file, "utf8"), CONFIG);
});

test("permission denial and concurrent replacement fail before shared-state creation", async (t) => {
  const { file } = await fixture(t); const factory = fakeFactory();
  const denied = await initializeVercelState(file, deps(factory, { checkPermissions: async () => { throw new Error("private path/token"); } }));
  assert.deepEqual(denied, { status: "refused", reason: "file_operation_failed" });
  const changed = await initializeVercelState(file, deps(factory, { checkPermissions: async () => { await writeFile(file, `${CONFIG}# changed\n`); } }));
  assert.deepEqual(changed, { status: "refused", reason: "concurrent_change" });
  assert.equal(factory.factories.length, 0);
});

test("real POSIX permissions are enforced; Windows ACL path is read-only and SID restricted", async (t) => {
  if (process.platform !== "win32") {
    const { file } = await fixture(t); const factory = fakeFactory();
    await chmod(file, 0o644);
    assert.deepEqual(await initializeVercelState(file, { initialize: true, createState: factory.createState }), { status: "refused", reason: "unsafe_permissions" });
    assert.equal(factory.factories.length, 0);
  }
  const source = await readFile(new URL("../scripts/init-vercel-state.mjs", import.meta.url), "utf8");
  assert.match(source, /GetAccessRules/);
  assert.match(source, /S-1-5-18/);
  assert.match(source, /S-1-5-32-544/);
  assert.match(source, /windowsHide: true/);
  assert.doesNotMatch(source, /Set-Acl|fs\.write|fs\.rename|fs\.unlink|process\.env\.UPSTASH/);
});

test("native Windows ACL accepts protected operator/System fixture and rejects broader Users read access", async (t) => {
  if (process.platform !== "win32") return;
  const { file, directory } = await fixture(t);
  const factory = fakeFactory();
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const childEnv = { ...process.env, SUARA_TEST_ACL_DIR: directory, SUARA_TEST_ACL_FILE: file };
  for (const key of Object.keys(childEnv)) if (key.toLowerCase() === "psmodulepath") delete childEnv[key];
  function acl(script) {
    const output = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: childEnv, windowsHide: true, timeout: 10_000, stdio: "pipe", maxBuffer: 4_096,
    });
    assert.equal(output.toString("utf8"), "");
  }
  // These ACL writes target only test-created files and their validated temp root.
  assert.equal(comparablePath(dirname(resolve(directory))), comparablePath(resolve(tmpdir())));
  assert.equal(dirname(file), directory);
  acl("$ErrorActionPreference='Stop'; $operatorSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $systemSid=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'); $folderAcl=[System.Security.AccessControl.DirectorySecurity]::new(); $folderAcl.SetOwner($operatorSid); $folderAcl.SetAccessRuleProtection($true,$false); foreach($sid in @($operatorSid,$systemSid)){ $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $folderAcl.AddAccessRule($rule) }; Set-Acl -LiteralPath $env:SUARA_TEST_ACL_DIR -AclObject $folderAcl; $fileAcl=[System.Security.AccessControl.FileSecurity]::new(); $fileAcl.SetOwner($operatorSid); $fileAcl.SetAccessRuleProtection($true,$false); foreach($sid in @($operatorSid,$systemSid)){ $fileAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')) }; Set-Acl -LiteralPath $env:SUARA_TEST_ACL_FILE -AclObject $fileAcl");
  const before = await stat(file);
  assert.deepEqual(await initializeVercelState(file, { initialize: true, createState: factory.createState }), { status: "initialized" });
  assert.equal(factory.calls, 1);
  assert.equal(await readFile(file, "utf8"), CONFIG);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);

  acl("$ErrorActionPreference='Stop'; $fileAcl=[System.IO.File]::GetAccessControl($env:SUARA_TEST_ACL_FILE,[System.Security.AccessControl.AccessControlSections]::Access); $usersSid=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'); $fileAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($usersSid,'Read','Allow')); [System.IO.File]::SetAccessControl($env:SUARA_TEST_ACL_FILE,$fileAcl)");
  assert.deepEqual(await initializeVercelState(file, { initialize: true, createState: factory.createState }), { status: "refused", reason: "unsafe_permissions" });
  assert.equal(factory.calls, 1, "broader ACL must be refused before any further state call");
});

test("initialization failures/results are sanitized and never retried", async (t) => {
  const { file } = await fixture(t);
  for (const result of [null, {}, { initialized: "true" }, { initialized: true, token: "secret" }]) {
    const factory = fakeFactory(result);
    assert.deepEqual(await initializeVercelState(file, deps(factory)), { status: "refused", reason: "initialization_failed" });
    assert.equal(factory.calls, 1);
  }
  let calls = 0;
  const result = await initializeVercelState(file, { initialize: true, checkPermissions: safePermissions,
    createState: () => ({ initialize: async () => { calls++; throw new Error("secret-provider-error"); } }),
  });
  assert.deepEqual(result, { status: "refused", reason: "initialization_failed" });
  assert.equal(calls, 1);
});

test("CLI requires explicit initialize, forwards exact named path and emits fixed status/reason fields only", async () => {
  const path = join(tmpdir(), "synthetic-unused.env");
  for (const status of ["initialized", "already_initialized"]) {
    let output = "";
    assert.equal(await runCli(["--initialize", "--private-config", path], (line) => { output += line; }, async (file, options) => {
      assert.equal(file, path); assert.deepEqual(options, { initialize: true });
      return { status, secret: "never-output" };
    }), 0);
    assert.deepEqual(JSON.parse(output), { status });
  }
  for (const result of [{ status: "refused", reason: "secret-error", config: "secret" }, null, { status: "secret" }]) {
    let output = "";
    assert.equal(await runCli(["--initialize", "--private-config", path], (line) => { output += line; }, async () => result), 1);
    assert.deepEqual(JSON.parse(output), { status: "refused", reason: "initialization_failed" });
  }
});

test("spawned initializer boundary rejects relative private configuration and legacy env flags before file access", () => {
  const missing = "suara-nonexistent-private-config-regression.env";
  for (const [args, reason] of [
    [["--initialize", "--private-config", missing], "invalid_path"],
    [["--initialize", "--env-file", missing], "usage"],
    [["--initialize", `--env-file=${missing}`], "usage"],
    [["--initialize", "--private-config", missing, "--env-file", missing], "usage"],
  ]) {
    const child = spawnSync(process.execPath, ["--", "scripts/init-vercel-state.mjs", ...args], {
      cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", windowsHide: true, timeout: 10000,
    });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, "");
    assert.equal(child.stdout, JSON.stringify({ status: "refused", reason }) + "\n");
    assert.equal(child.stdout.includes(missing), false);
  }
});
