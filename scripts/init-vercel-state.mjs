import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRedisState } from "../server/vercel-redis-state.mjs";

const MAX_BYTES = 65_536;
const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "SUARA_REDIS_PREFIX"];
class InitializationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new InitializationError(code); };
const regular = (stat) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

async function inspectPath(file) {
  const inside = relative(REPOSITORY, file);
  if (!isAbsolute(file) || !inside || (!inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(inside)) ||
      /(?:^|[\\/])OneDrive(?: - [^\\/]+)?(?:[\\/]|$)/iu.test(file) ||
      (process.platform === "win32" && (parse(file).root.startsWith("\\\\") || file.slice(parse(file).root.length).includes(":")))) {
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

async function checkProtectedPermissions(file, stat) {
  if (process.platform !== "win32") {
    const parent = await fs.lstat(dirname(file));
    if ((stat.mode & 0o077) || stat.uid !== process.getuid() ||
        (parent.mode & 0o022) || parent.uid !== process.getuid()) fail("unsafe_permissions");
    return;
  }
  // Read-only ACL inspection. Paths are environment values, never interpolated code.
  // Permit only the current operator, Local System and Builtin Administrators.
  const script = "$ErrorActionPreference='Stop'; $operatorSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $allowed=@($operatorSid,'S-1-5-18','S-1-5-32-544'); foreach($target in @($env:SUARA_INIT_ACL_FILE,(Split-Path -LiteralPath $env:SUARA_INIT_ACL_FILE))){ $acl=Get-Acl -LiteralPath $target; $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; if($owner -notin $allowed){throw 'unsafe'}; foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed){throw 'unsafe'}} }; [Console]::Write('protected')";
  try {
    const childEnv = { ...process.env, SUARA_INIT_ACL_FILE: file };
    for (const key of Object.keys(childEnv)) if (key.toLowerCase() === "psmodulepath") delete childEnv[key];
    const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const output = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: childEnv, windowsHide: true, timeout: 5_000, stdio: "pipe", maxBuffer: 1_024,
    });
    if (output.toString("utf8") !== "protected") fail("unsafe_permissions");
  } catch { fail("unsafe_permissions"); }
}

function parseConfiguration(bytes) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("invalid_config"); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text) || /\r(?!\n)/u.test(text)) fail("invalid_config");
  const seen = new Set();
  const values = Object.create(null);
  for (const line of text.split(/\r?\n/u)) {
    if (/^[ \t]*(?:#.*)?$/u.test(line)) continue;
    const match = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/u.exec(line);
    if (!match || seen.has(match[1])) fail("invalid_config");
    seen.add(match[1]);
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      if (end < 0 || !/^[ \t]*(?:#.*)?$/u.test(value.slice(end + 1))) fail("invalid_config");
      value = value.slice(1, end);
      // Intentionally no dotenv expansion, escapes, shell/export or multiline syntax.
      if (value.includes("\\")) fail("invalid_config");
    } else {
      value = value.split(/(?:^|[ \t]+)#/u)[0].trimEnd();
      if (/["']/u.test(value)) fail("invalid_config");
    }
    if (REQUIRED.includes(match[1])) values[match[1]] = value;
  }
  if (REQUIRED.some((key) => !values[key])) fail("missing_config");
  let url;
  try { url = new URL(values.UPSTASH_REDIS_REST_URL); } catch { fail("invalid_config"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" ||
      !/^[a-z0-9-]+\.upstash\.io$/u.test(url.hostname) ||
      !/^[\x21-\x7e]{1,8192}$/u.test(values.UPSTASH_REDIS_REST_TOKEN) ||
      !/^[A-Za-z0-9-]{1,64}$/u.test(values.SUARA_REDIS_PREFIX)) fail("invalid_config");
  return { url: values.UPSTASH_REDIS_REST_URL, token: values.UPSTASH_REDIS_REST_TOKEN, prefix: values.SUARA_REDIS_PREFIX };
}

/** Explicit, one-call provisioning. The two injected dependencies are test seams. */
export async function initializeVercelState(file, {
  initialize = false, createState = createRedisState, checkPermissions = checkProtectedPermissions,
} = {}) {
  let handle;
  try {
    if (initialize !== true) fail("confirmation_required");
    if (typeof file !== "string" || !isAbsolute(file)) fail("invalid_path");
    file = resolve(file);
    const before = await inspectPath(file);
    await checkPermissions(file, before);
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!regular(opened) || !sameFile(before, opened) || before.ctimeMs !== opened.ctimeMs) fail("concurrent_change");
    // Read at most the bound plus one byte, even if the file grows after lstat.
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    const current = await inspectPath(file);
    if (length > MAX_BYTES || length !== opened.size || !sameFile(opened, current) || !regular(after) ||
        after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        current.ctimeMs !== opened.ctimeMs) fail("concurrent_change");
    await checkPermissions(file, current);
    const config = parseConfiguration(bytes.subarray(0, length));
    await handle.close(); handle = null;
    let result;
    try { result = await createState(config).initialize(); }
    catch { fail("initialization_failed"); }
    if (!result || typeof result !== "object" || Object.keys(result).length !== 1 || typeof result.initialized !== "boolean") {
      fail("initialization_failed");
    }
    return { status: result.initialized ? "initialized" : "already_initialized" };
  } catch (error) {
    return { status: "refused", reason: error instanceof InitializationError ? error.code : "file_operation_failed" };
  } finally { await handle?.close().catch(() => {}); }
}

export async function runCli(args, write = (line) => process.stdout.write(line), initializeState = initializeVercelState) {
  // Launch with node -- scripts/init-vercel-state.mjs --initialize --private-config ...
  // Never alias Node's --env-file: its preload precedes our file safety checks.
  let result;
  try {
    result = args.length === 3 && args[0] === "--initialize" && args[1] === "--private-config" && args[2]
      ? await initializeState(args[2], { initialize: true })
      : { status: "refused", reason: "usage" };
  } catch { result = { status: "refused", reason: "initialization_failed" }; }
  // Never pass arbitrary injected/provider fields into CLI output.
  if (!["initialized", "already_initialized", "refused"].includes(result?.status)) result = { status: "refused", reason: "initialization_failed" };
  const reasons = ["usage", "confirmation_required", "invalid_path", "unsafe_path", "unsafe_file", "invalid_config", "missing_config", "unsafe_permissions", "concurrent_change", "initialization_failed", "file_operation_failed"];
  const safe = result.status === "refused"
    ? { status: "refused", reason: reasons.includes(result.reason) ? result.reason : "initialization_failed" }
    : { status: result.status };
  write(`${JSON.stringify(safe)}\n`);
  return safe.status === "refused" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
