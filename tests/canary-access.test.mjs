import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { prepareCanaryAccess, runCli } from "../scripts/prepare-canary-access.mjs";

const SENTINEL = "synthetic-provider-key-never-print-this";
async function fixture(t, content) {
  const directory = await fs.mkdtemp(join(tmpdir(), "suara-access-test-"));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = join(directory, "voice.env");
  await fs.writeFile(file, content, { mode: 0o600 });
  return { directory, file };
}

test("empty assignment receives a 32-byte base64url code while every other byte is preserved", async (t) => {
  const before = Buffer.from(`\uFEFF# 合成 fixture\r\nASSEMBLYAI_API_KEY=${SENTINEL}\r\nSUARA_JUDGE_ACCESS_CODE=\r\nOTHER="leave this unchanged"\r\n`, "utf8");
  const { file, directory } = await fixture(t, before);
  assert.deepEqual(await prepareCanaryAccess(file), { status: "configured" });
  const after = await fs.readFile(file);
  const code = /SUARA_JUDGE_ACCESS_CODE=([^\r\n]+)/u.exec(after.toString("utf8"))[1];
  assert.match(code, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(Buffer.from(code, "base64url").length, 32);
  assert.deepEqual(Buffer.from(after.toString("utf8").replace(code, ""), "utf8"), before);
  assert.deepEqual(await fs.readdir(directory), ["voice.env"]);
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("quoted empty assignment and whitespace/comment bytes are preserved", async (t) => {
  for (const value of ['"" # keep this', "''", "   # preserve spacing"]) {
    const original = `ASSEMBLYAI_API_KEY=${SENTINEL}\n  SUARA_JUDGE_ACCESS_CODE = ${value}\n`;
    const { file } = await fixture(t, original);
    assert.equal((await prepareCanaryAccess(file)).status, "configured");
    const updated = await fs.readFile(file, "utf8");
    const code = /[A-Za-z0-9_-]{43}/u.exec(updated)[0];
    assert.equal(updated.replace(code, ""), original);
  }
});

test("nonempty existing code remains unchanged and reports only already_configured", async (t) => {
  const original = `ASSEMBLYAI_API_KEY=${SENTINEL}\nSUARA_JUDGE_ACCESS_CODE="synthetic-existing-code"\n`;
  const { file } = await fixture(t, original);
  assert.deepEqual(await prepareCanaryAccess(file), { status: "already_configured" });
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("missing, duplicate, malformed and invalid UTF-8 config is refused without changes", async (t) => {
  const invalid = [
    `ASSEMBLYAI_API_KEY=${SENTINEL}\n`,
    "SUARA_JUDGE_ACCESS_CODE=\nSUARA_JUDGE_ACCESS_CODE=\n",
    "SUARA_JUDGE_ACCESS_CODE=existing\nSUARA_JUDGE_ACCESS_CODE=\n",
    "SUARA_JUDGE_ACCESS_CODE=\nOTHER=one\nOTHER=two\n",
    "SUARA_JUDGE_ACCESS_CODE=\nnot an assignment\n",
    'SUARA_JUDGE_ACCESS_CODE="unterminated\n',
    'SUARA_JUDGE_ACCESS_CODE="" unexpected\n',
    "export SUARA_JUDGE_ACCESS_CODE=\n",
    "SUARA_JUDGE_ACCESS_CODE=\u0000\n",
    Buffer.from([0xff, 0xfe, 0x80]),
  ];
  for (const content of invalid) {
    const { file } = await fixture(t, content);
    const before = await fs.readFile(file);
    assert.equal((await prepareCanaryAccess(file)).status, "refused");
    assert.deepEqual(await fs.readFile(file), before);
  }
});

test("concurrent content or identity replacement is preserved instead of overwritten", async (t) => {
  for (const replace of [false, true]) {
    const { file, directory } = await fixture(t, "SUARA_JUDGE_ACCESS_CODE=\n");
    const userEdit = `SUARA_JUDGE_ACCESS_CODE=\nUSER_EDIT=${SENTINEL}\n`;
    const result = await prepareCanaryAccess(file, { beforeCommit: async () => {
      if (replace) {
        const other = join(directory, "edited.env");
        await fs.writeFile(other, userEdit, { mode: 0o600 });
        await fs.rename(other, file);
      } else await fs.writeFile(file, userEdit);
    } });
    assert.deepEqual(result, { status: "refused", reason: "concurrent_change" });
    assert.equal(await fs.readFile(file, "utf8"), userEdit);
    assert.deepEqual(await fs.readdir(directory), ["voice.env"]);
  }
});

test("hardlinks and symbolic parent paths are refused", async (t) => {
  const { file, directory } = await fixture(t, "SUARA_JUDGE_ACCESS_CODE=\n");
  const hardlink = join(directory, "linked.env");
  await fs.link(file, hardlink);
  assert.deepEqual(await prepareCanaryAccess(file), { status: "refused", reason: "unsafe_file" });
  await fs.unlink(hardlink);
  const alias = join(directory, "alias");
  const target = join(directory, "actual");
  await fs.mkdir(target);
  await fs.writeFile(join(target, "voice.env"), "SUARA_JUDGE_ACCESS_CODE=\n", { mode: 0o600 });
  await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(await prepareCanaryAccess(join(alias, "voice.env")), { status: "refused", reason: "unsafe_path" });
});

test("a changed staging file cannot replace the original config", async (t) => {
  const original = `ASSEMBLYAI_API_KEY=${SENTINEL}\nSUARA_JUDGE_ACCESS_CODE=\n`;
  const { file, directory } = await fixture(t, original);
  const result = await prepareCanaryAccess(file, { beforeCommit: async () => {
    const temporary = (await fs.readdir(directory)).find((name) => name.endsWith(".tmp"));
    await fs.writeFile(join(directory, temporary), "SUARA_JUDGE_ACCESS_CODE=tampered\n");
  } });
  assert.deepEqual(result, { status: "refused", reason: "concurrent_change" });
  assert.equal(await fs.readFile(file, "utf8"), original);
  assert.deepEqual(await fs.readdir(directory), ["voice.env"]);
});

test("replacement preserves the original Windows access-control descriptor", { skip: process.platform !== "win32" }, async (t) => {
  const { file } = await fixture(t, "SUARA_JUDGE_ACCESS_CODE=\n");
  const env = { ...process.env, SUARA_CANARY_ACL_TEST_FILE: file };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
  const readAcl = () => {
    const child = spawnSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", "(Get-Acl -LiteralPath $env:SUARA_CANARY_ACL_TEST_FILE).Sddl"],
      { env, encoding: "utf8", windowsHide: true });
    assert.equal(child.status, 0);
    return child.stdout.trim();
  };
  const before = readAcl();
  assert.ok(before);
  assert.equal((await prepareCanaryAccess(file)).status, "configured");
  assert.equal(readAcl(), before);
});

test("file symlinks are refused when the host permits creating them", async (t) => {
  const { file, directory } = await fixture(t, "SUARA_JUDGE_ACCESS_CODE=\n");
  const alias = join(directory, "alias.env");
  try { await fs.symlink(file, alias, "file"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("Host does not permit unprivileged file symlink creation"); return; } throw error; }
  assert.deepEqual(await prepareCanaryAccess(alias), { status: "refused", reason: "unsafe_file" });
});

test("utility lock refuses another writer and never removes a pre-existing lock", async (t) => {
  const { file, directory } = await fixture(t, "SUARA_JUDGE_ACCESS_CODE=\n");
  const lock = join(directory, ".voice.env.suara-access.lock");
  await fs.writeFile(lock, "synthetic prior lock");
  assert.deepEqual(await prepareCanaryAccess(file), { status: "refused", reason: "busy" });
  assert.equal(await fs.readFile(lock, "utf8"), "synthetic prior lock");
});

test("CLI prints only sanitized status and requires an explicit absolute private-config path", async (t) => {
  const { file } = await fixture(t, `ASSEMBLYAI_API_KEY=${SENTINEL}\nSUARA_JUDGE_ACCESS_CODE=\n`);
  const child = spawnSync(process.execPath, ["--", "scripts/prepare-canary-access.mjs", "--private-config", file], { cwd: new URL("..", import.meta.url), encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, '{"status":"configured"}\n');
  assert.equal(child.stderr, "");
  assert.ok(!child.stdout.includes(SENTINEL));
  let printed = "";
  assert.equal(await runCli(["--private-config", "voice.env"], (line) => { printed += line; }), 1);
  assert.equal(printed, '{"status":"refused","reason":"invalid_path"}\n');
  printed = "";
  assert.equal(await runCli([], (line) => { printed += line; }), 1);
  assert.equal(printed, '{"status":"refused","reason":"usage"}\n');
});

test("spawned CLI boundary rejects relative private configuration and legacy Node env flags without preloading", () => {
  const missing = "suara-nonexistent-private-config-regression.env";
  for (const [args, reason] of [
    [["--private-config", missing], "invalid_path"],
    [["--env-file", missing], "usage"],
    [[`--env-file=${missing}`], "usage"],
    [["--private-config", missing, "--env-file", missing], "usage"],
  ]) {
    const child = spawnSync(process.execPath, ["--", "scripts/prepare-canary-access.mjs", ...args], {
      cwd: new URL("..", import.meta.url), encoding: "utf8", windowsHide: true, timeout: 10000,
    });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, "");
    assert.equal(child.stdout, JSON.stringify({ status: "refused", reason }) + "\n");
    assert.equal(child.stdout.includes(missing), false);
  }
});

test("independent preparations generate distinct random access codes", async (t) => {
  const a = await fixture(t, "SUARA_JUDGE_ACCESS_CODE=\n");
  const b = await fixture(t, "SUARA_JUDGE_ACCESS_CODE=\n");
  assert.equal((await prepareCanaryAccess(a.file)).status, "configured");
  assert.equal((await prepareCanaryAccess(b.file)).status, "configured");
  assert.notEqual(await fs.readFile(a.file, "utf8"), await fs.readFile(b.file, "utf8"));
});
