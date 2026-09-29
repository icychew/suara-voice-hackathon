import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 65_536;
const CODE_KEY = "SUARA_JUDGE_ACCESS_CODE";

class PreparationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new PreparationError(code); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const regular = (stat) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;

async function inspectPath(file) {
  if (!isAbsolute(file) || (process.platform === "win32" && file.slice(parse(file).root.length).includes(":"))) {
    fail("invalid_path");
  }
  let directory = dirname(file);
  while (true) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe_path");
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const stat = await fs.lstat(file);
  if (!regular(stat)) fail("unsafe_file");
  if (stat.size > MAX_BYTES) fail("invalid_config");
  return stat;
}

async function readChecked(file) {
  const before = await inspectPath(file);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!regular(opened) || !sameFile(before, opened)) fail("concurrent_change");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length > MAX_BYTES || bytes.length !== opened.size || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || !regular(after)) {
      fail("concurrent_change");
    }
    return { bytes, stat: after };
  } finally { await handle.close(); }
}

function replacementRange(bytes) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail("invalid_config"); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text) || /\r(?!\n)/u.test(text)) fail("invalid_config");
  const seen = new Set();
  let found = null;
  let offset = 0;
  for (const lineWithEnding of text.match(/[^\r\n]*(?:\r\n|\n|$)/gu) || []) {
    const line = lineWithEnding.replace(/\r?\n$/u, "");
    const bom = offset === 0 && line.startsWith("\uFEFF") ? 1 : 0;
    const content = line.slice(bom);
    if (!/^[ \t]*(?:#.*)?$/u.test(content)) {
      const match = /^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(.*)$/u.exec(content);
      if (!match || seen.has(match[2])) fail("invalid_config");
      const key = match[2];
      seen.add(key);
      const rawValue = match[4];
      let value;
      if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
        const quote = rawValue[0];
        let end = 1;
        for (; end < rawValue.length; end += 1) {
          if (rawValue[end] === "\\" && quote === '"') { end += 1; continue; }
          if (rawValue[end] === quote) break;
        }
        if (end >= rawValue.length || !/^[ \t]*(?:#.*)?$/u.test(rawValue.slice(end + 1))) fail("invalid_config");
        value = rawValue.slice(1, end);
      } else {
        // Plain dotenv values and trailing comments; shell/export syntax is not accepted.
        value = rawValue.split(/(?:^|[ \t]+)#/u)[0].trimEnd();
        if (/["']/u.test(value)) fail("invalid_config");
      }
      if (key === CODE_KEY) {
        const start = offset + bom + match[1].length + key.length + match[3].length;
        if (value.length) found = { configured: true };
        else {
          // Insert into an empty value, preserving quotes, comments and all whitespace.
          const quoted = rawValue[0] === '"' || rawValue[0] === "'";
          const prefixWhitespace = /[ \t]*$/u.exec(match[3])[0].length;
          if (rawValue.startsWith("#") && prefixWhitespace === 0) fail("invalid_config");
          const index = rawValue.startsWith("#") ? start - prefixWhitespace : start + (quoted ? 1 : 0);
          found = { configured: false, byteOffset: Buffer.byteLength(text.slice(0, index), "utf8") };
        }
      }
    }
    offset += lineWithEnding.length;
  }
  if (!found) fail("missing_assignment");
  return found;
}

async function preservePermissions(source, target, stat) {
  if (process.platform === "win32") {
    // Paths travel as environment values, never shell-interpolated source or config contents.
    const script = "$ErrorActionPreference = 'Stop'; $canaryAcl = Get-Acl -LiteralPath $env:SUARA_CANARY_ACL_SOURCE; Set-Acl -LiteralPath $env:SUARA_CANARY_ACL_TARGET -AclObject $canaryAcl";
    try {
      const childEnv = { ...process.env, SUARA_CANARY_ACL_SOURCE: source, SUARA_CANARY_ACL_TARGET: target };
      // A parent PowerShell 7 module path can break Windows PowerShell ACL cmdlets.
      for (const key of Object.keys(childEnv)) if (key.toLowerCase() === "psmodulepath") delete childEnv[key];
      const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        env: childEnv,
        windowsHide: true, timeout: 10_000, stdio: "pipe",
      });
    } catch { fail("permissions_unavailable"); }
  } else {
    if (stat.mode & 0o077) fail("unsafe_permissions");
    await fs.chmod(target, stat.mode & 0o777);
    const targetStat = await fs.lstat(target);
    if (targetStat.uid !== stat.uid || targetStat.gid !== stat.gid) fail("permissions_unavailable");
  }
}

// beforeCommit is an injectable test seam for deterministic concurrent-edit checks.
// It is not exposed by the CLI. This operation never returns config values.
export async function prepareCanaryAccess(file, { beforeCommit } = {}) {
  let lock;
  let tempHandle;
  let temporary;
  let lockPath;
  try {
    if (typeof file !== "string" || !isAbsolute(file)) fail("invalid_path");
    await inspectPath(file);
    lockPath = join(dirname(file), `.${basename(file)}.suara-access.lock`);
    try { lock = await fs.open(lockPath, "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST") fail("busy"); throw error; }
    const original = await readChecked(file);
    const range = replacementRange(original.bytes);
    if (range.configured) return { status: "already_configured" };
    if (process.platform !== "win32" && original.stat.mode & 0o077) fail("unsafe_permissions");
    const code = randomBytes(32).toString("base64url");
    const updated = Buffer.concat([
      original.bytes.subarray(0, range.byteOffset), Buffer.from(code, "ascii"),
      original.bytes.subarray(range.byteOffset),
    ]);
    if (updated.length > MAX_BYTES) fail("invalid_config");
    temporary = join(dirname(file), `.${basename(file)}.suara-access-${randomBytes(12).toString("hex")}.tmp`);
    tempHandle = await fs.open(temporary, "wx", 0o600);
    const tempIdentity = await tempHandle.stat();
    await preservePermissions(file, temporary, original.stat);
    await tempHandle.writeFile(updated);
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = null;
    await beforeCommit?.();
    const staged = await readChecked(temporary);
    if (!sameFile(tempIdentity, staged.stat) || !updated.equals(staged.bytes)) fail("concurrent_change");
    const current = await readChecked(file);
    if (!sameFile(original.stat, current.stat) || !original.bytes.equals(current.bytes) ||
        original.stat.mode !== current.stat.mode || original.stat.ctimeMs !== current.stat.ctimeMs ||
        original.stat.mtimeMs !== current.stat.mtimeMs) fail("concurrent_change");
    await fs.rename(temporary, file);
    temporary = null;
    return { status: "configured" };
  } catch (error) {
    return { status: "refused", reason: error instanceof PreparationError ? error.code : "file_operation_failed" };
  } finally {
    await tempHandle?.close().catch(() => {});
    if (temporary) await fs.unlink(temporary).catch(() => {});
    if (lock) {
      await lock.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
    }
  }
}

export async function runCli(args, write = (line) => process.stdout.write(line)) {
  // Launch with node -- scripts/prepare-canary-access.mjs --private-config ...
  // Never alias Node's --env-file: its preload precedes our file safety checks.
  const result = args.length === 2 && args[0] === "--private-config" && args[1]
    ? await prepareCanaryAccess(args[1])
    : { status: "refused", reason: "usage" };
  write(`${JSON.stringify(result)}\n`);
  return result.status === "refused" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
