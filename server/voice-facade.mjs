import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import * as quotaFileSystem from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";

const PROVIDER_TOKEN_URL = "https://agents.assemblyai.com/v1/token";
const STREAMING_TOKEN_URL = "https://streaming.assemblyai.com/v3/token";
const PROVIDER_TOKEN_TTL_SECONDS = 60;
const PROVIDER_SESSION_SECONDS = 600;
const SESSION_TTL_SECONDS = 120;
const MAX_REQUEST_TARGET_BYTES = 2_048;
const MAX_UPSTREAM_BODY_BYTES = 8_192;
const REQUEST_TIMEOUT_MS = 10_000;
const UPSTREAM_TIMEOUT_MS = 8_000;
const DAY_MS = 86_400_000;
const MAX_LEDGER_BYTES = 180_000;

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".xml", "application/xml; charset=utf-8"],
]);

const COMMON_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  Expires: "0",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=(), payment=(), usb=()",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

const STATIC_CSP =
  "default-src 'self'; base-uri 'self'; connect-src 'self' wss://agents.assemblyai.com wss://streaming.assemblyai.com; " +
  "font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; " +
  "media-src 'self' blob:; object-src 'none'; script-src 'self'; style-src 'self'; upgrade-insecure-requests";

function digest(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function parseInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseAllowedHosts(value) {
  if (!value) throw new Error("SUARA_ALLOWED_HOSTS is required.");
  const hosts = value
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  if (!hosts.length || hosts.some((host) => !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(host))) {
    throw new Error("SUARA_ALLOWED_HOSTS must contain exact comma-separated host names.");
  }
  return new Set(hosts);
}

export function loadConfig(env = process.env) {
  const publicOrigin = env.SUARA_PUBLIC_ORIGIN?.trim();
  if (!publicOrigin) throw new Error("SUARA_PUBLIC_ORIGIN is required.");

  let origin;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new Error("SUARA_PUBLIC_ORIGIN must be an absolute HTTP(S) origin.");
  }

  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== publicOrigin ||
    origin.username ||
    origin.password
  ) {
    throw new Error("SUARA_PUBLIC_ORIGIN must contain only an exact HTTP(S) origin.");
  }
  if (env.NODE_ENV === "production" && origin.protocol !== "https:") {
    throw new Error("SUARA_PUBLIC_ORIGIN must use HTTPS in production.");
  }

  const allowedHosts = parseAllowedHosts(env.SUARA_ALLOWED_HOSTS);
  if (!allowedHosts.has(origin.host.toLowerCase())) {
    throw new Error("SUARA_ALLOWED_HOSTS must include the host in SUARA_PUBLIC_ORIGIN.");
  }

  const providerKey = env.ASSEMBLYAI_API_KEY;
  if (!providerKey || !providerKey.trim()) {
    throw new Error("ASSEMBLYAI_API_KEY is required.");
  }
  const accessCode = env.SUARA_JUDGE_ACCESS_CODE;
  if (!accessCode || !/^[\x21-\x7e]{16,128}$/.test(accessCode)) {
    throw new Error("SUARA_JUDGE_ACCESS_CODE must contain 16 to 128 printable non-space ASCII characters.");
  }

  const listenHost = env.SUARA_LISTEN_HOST || "127.0.0.1";
  if (!["127.0.0.1", "::1"].includes(listenHost)) {
    throw new Error("SUARA_LISTEN_HOST must be a loopback address.");
  }
  const quotaFile = env.SUARA_QUOTA_FILE;
  if (!quotaFile || !isAbsolute(quotaFile)) {
    throw new Error("SUARA_QUOTA_FILE must name an absolute durable ledger path.");
  }
  const distRoot = resolve(env.SUARA_DIST_ROOT || "dist");
  if (env.NODE_ENV === "production") {
    let marker;
    try { marker = quotaFileSystem.lstatSync(join(distRoot, "suara-operator-only.json")); }
    catch (error) { if (error.code !== "ENOENT") throw new Error("Site configuration unavailable."); }
    if (marker) throw new Error("Operator-only artifacts cannot be served in production.");
  }
  if (resolve(quotaFile) === distRoot || resolve(quotaFile).startsWith(`${distRoot}${sep}`)) {
    throw new Error("SUARA_QUOTA_FILE must be outside the served site.");
  }

  return Object.freeze({
    allowedHosts,
    distRoot,
    quotaFile: resolve(quotaFile),
    listenHost,
    port: parseInteger(env.SUARA_PORT, 8_787, 1, 65_535, "SUARA_PORT"),
    providerKey,
    streamingEnabled: env.SUARA_ENABLE_STREAMING_VOICE === "true",
    accessCodeHash: digest(accessCode),
    publicOrigin,
    requireHttpsProxy: env.NODE_ENV === "production",
    dailyTokenLimit: parseInteger(
      env.SUARA_DAILY_TOKEN_LIMIT,
      60,
      1,
      10_000,
      "SUARA_DAILY_TOKEN_LIMIT",
    ),
    globalTokenRateLimit: parseInteger(
      env.SUARA_GLOBAL_TOKEN_RATE_LIMIT,
      6,
      1,
      1_000,
      "SUARA_GLOBAL_TOKEN_RATE_LIMIT",
    ),
    sessionRateLimit: parseInteger(
      env.SUARA_SESSION_RATE_LIMIT,
      6,
      1,
      100,
      "SUARA_SESSION_RATE_LIMIT",
    ),
    tokenRateLimit: parseInteger(
      env.SUARA_TOKEN_RATE_LIMIT,
      2,
      1,
      50,
      "SUARA_TOKEN_RATE_LIMIT",
    ),
  });
}

function headerOccurrences(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  return count;
}

function exactHeader(request, name) {
  const count = headerOccurrences(request, name);
  if (count !== 1) return null;
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function clientIdentity(request) {
  const socketAddress = request.socket.remoteAddress || "unknown";
  if (!isLoopback(socketAddress)) return digest(socketAddress);

  const forwarded = exactHeader(request, "x-real-ip");
  if (forwarded && forwarded.length <= 64 && isIP(forwarded)) return digest(forwarded);
  return digest(socketAddress);
}

class SlidingWindowLimiter {
  constructor({ limit, now, windowMs = 60_000 }) {
    this.limit = limit;
    this.now = now;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  take(key) {
    const current = this.now();
    const cutoff = current - this.windowMs;
    const retained = (this.buckets.get(key) || []).filter((stamp) => stamp > cutoff);
    if (retained.length >= this.limit) {
      this.buckets.set(key, retained);
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((retained[0] + this.windowMs - current) / 1_000)),
      };
    }
    retained.push(current);
    this.buckets.set(key, retained);
    return { allowed: true, retryAfter: 0 };
  }

  prune() {
    const cutoff = this.now() - this.windowMs;
    for (const [key, stamps] of this.buckets) {
      const retained = stamps.filter((stamp) => stamp > cutoff);
      if (retained.length) this.buckets.set(key, retained);
      else this.buckets.delete(key);
    }
  }
}

// One local service process owns this file for its lifetime. A crash leaves the
// empty lock behind: recovery must inspect the stopped service, never erase usage.
class DurableIssuanceLedger {
  constructor({ file, limit, now, fs, distRoot }) {
    this.fs = fs;
    this.limit = limit;
    this.now = now;
    this.closed = false;
    this.failed = false;
    this.directory = fs.realpathSync(dirname(file));
    let servedRoot;
    try { servedRoot = fs.realpathSync(distRoot); } catch { servedRoot = resolve(distRoot); }
    if (this.directory === servedRoot || this.directory.startsWith(`${servedRoot}${sep}`)) {
      throw new Error("Quota directory must be outside the served site.");
    }
    const parent = fs.lstatSync(this.directory);
    if (!parent.isDirectory() || (process.platform !== "win32" &&
      ((parent.mode & 0o077) !== 0 || parent.uid !== process.getuid()))) {
      throw new Error("Unsafe quota directory.");
    }
    this.file = join(this.directory, basename(file));
    this.lock = `${this.file}.lock`;
    this.lockFd = fs.openSync(this.lock, "wx", 0o600);
    this.lockInfo = fs.fstatSync(this.lockFd);
    try {
      this.validateFile(this.lockInfo);
      this.read();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  validateFile(info) {
    if (!info.isFile() || info.nlink !== 1 || (process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()))) {
      throw new Error("Unsafe quota file.");
    }
  }

  read() {
    const { fs } = this;
    const info = fs.lstatSync(this.file);
    this.validateFile(info);
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      this.validateFile(opened);
      if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_LEDGER_BYTES) {
        throw new Error("Invalid quota file.");
      }
      const buffer = Buffer.alloc(MAX_LEDGER_BYTES + 1);
      let count = 0;
      while (count < buffer.length) {
        const bytes = fs.readSync(fd, buffer, count, buffer.length - count, null);
        if (!bytes) break;
        count += bytes;
      }
      if (count > MAX_LEDGER_BYTES) throw new Error("Quota file too large.");
      const payload = JSON.parse(buffer.subarray(0, count).toString("utf8"));
      if (!payload || Object.keys(payload).sort().join(",") !== "timestamps,version" ||
          payload.version !== 1 || !Array.isArray(payload.timestamps) || payload.timestamps.length > 10_000 ||
          payload.timestamps.some((stamp, i, all) => !Number.isSafeInteger(stamp) || stamp < 0 ||
            (i > 0 && stamp < all[i - 1]))) {
        throw new Error("Invalid quota schema.");
      }
      return payload.timestamps;
    } finally {
      fs.closeSync(fd);
    }
  }

  take() {
    if (this.closed || this.failed) throw new Error("Quota unavailable.");
    const { fs } = this;
    let temporary;
    let fd;
    try {
      const lockInfo = fs.lstatSync(this.lock);
      this.validateFile(lockInfo);
      if (lockInfo.dev !== this.lockInfo.dev || lockInfo.ino !== this.lockInfo.ino) {
        throw new Error("Quota lock changed.");
      }
      const current = this.now();
      if (!Number.isSafeInteger(current) || current < 0) throw new Error("Invalid quota clock.");
      const retained = this.read().filter((stamp) => stamp > current - DAY_MS);
      if (retained.length >= this.limit) {
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((retained[0] + DAY_MS - current) / 1_000)) };
      }
      // Future stamps survive clock rollback; new attempts cannot move time backwards.
      retained.push(Math.max(current, retained.at(-1) || 0));
      temporary = `${this.file}.${randomBytes(12).toString("hex")}.tmp`;
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ version: 1, timestamps: retained }));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.file);
      temporary = undefined;
      // Linux production commits both file contents and the atomic directory entry.
      if (process.platform !== "win32") {
        const directoryFd = fs.openSync(this.directory, fs.constants.O_RDONLY);
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      }
      return { allowed: true, retryAfter: 0 };
    } catch {
      this.failed = true;
      throw new Error("Quota unavailable.");
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (temporary) {
        try { fs.unlinkSync(temporary); } catch { /* Preserve uncertain state; fail closed. */ }
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.fs.closeSync(this.lockFd);
    try {
      const info = this.fs.lstatSync(this.lock);
      if (info.isFile() && info.nlink === 1 && info.dev === this.lockInfo.dev && info.ino === this.lockInfo.ino) {
        this.fs.unlinkSync(this.lock);
      }
    } catch { /* An uncertain lock is left for explicit operator recovery. */ }
  }
}

function write(request, response, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, {
    ...COMMON_HEADERS,
    "Content-Length": Buffer.byteLength(payload),
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers,
  });
  if (request.method === "HEAD") response.end();
  else response.end(payload);
}

function writeError(request, response, status, error, headers) {
  write(request, response, status, { error }, headers);
}

function hasRequestBody(request) {
  if (request.headers["transfer-encoding"] !== undefined) return true;
  const length = request.headers["content-length"];
  if (length === undefined) return false;
  return !/^0+$/.test(length);
}

function safeRequestUrl(request) {
  const target = request.url || "/";
  if (Buffer.byteLength(target) > MAX_REQUEST_TARGET_BYTES) return null;
  if (/\\|%(?:00|2e|2f|5c)/i.test(target)) return null;
  try {
    return new URL(target, "http://local.invalid");
  } catch {
    return null;
  }
}

function staticPathFor(pathname) {
  if (pathname === "/") return "/index.html";
  if (pathname.endsWith("/")) return `${pathname}index.html`;
  return pathname;
}

async function sendStatic(request, response, config, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(staticPathFor(pathname));
  } catch {
    writeError(request, response, 400, "bad_request");
    return;
  }

  if (decoded.split("/").some((segment) => segment.startsWith("."))) {
    writeError(request, response, 404, "not_found");
    return;
  }

  const root = await realpath(config.distRoot).catch(() => null);
  if (!root) {
    writeError(request, response, 503, "site_unavailable");
    return;
  }

  const candidate = resolve(root, `.${decoded}`);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    writeError(request, response, 404, "not_found");
    return;
  }

  const [info, resolvedCandidate] = await Promise.all([
    lstat(candidate).catch(() => null),
    realpath(candidate).catch(() => null),
  ]);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    !resolvedCandidate ||
    (resolvedCandidate !== root && !resolvedCandidate.startsWith(`${root}${sep}`))
  ) {
    writeError(request, response, 404, "not_found");
    return;
  }

  const contentType = MIME_TYPES.get(extname(resolvedCandidate).toLowerCase()) || "application/octet-stream";
  response.writeHead(200, {
    ...COMMON_HEADERS,
    "Content-Length": info.size,
    "Content-Security-Policy": STATIC_CSP,
    "Content-Type": contentType,
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(resolvedCandidate);
  stream.on("error", () => {
    if (!response.headersSent) writeError(request, response, 500, "internal_error");
    else response.destroy();
  });
  stream.pipe(response);
}

async function readUpstreamJson(response) {
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength && Number(declaredLength) > MAX_UPSTREAM_BODY_BYTES) {
    await response.body?.cancel();
    throw new Error("upstream response too large");
  }
  if (!response.body) throw new Error("empty upstream response");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_UPSTREAM_BODY_BYTES) throw new Error("upstream response too large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

export async function mintProviderToken(config, fetchImpl, signal) {
  return mintBoundedToken(config, fetchImpl, signal, false);
}

export async function mintStreamingProviderToken(config, fetchImpl, signal) {
  if (config.streamingEnabled !== true) throw new Error("Streaming voice is not enabled.");
  return mintBoundedToken(config, fetchImpl, signal, true);
}

// The fixed destination and authorization scheme are selected by our route, never
// from a client-supplied URL or body. Streaming uses the raw key; managed Voice
// Agent uses Bearer. Both retain the same bounded exchange and cancellation.
// https://www.assemblyai.com/docs/streaming/api-spec/generate-streaming-token
async function mintBoundedToken(config, fetchImpl, signal, streaming) {
  const url = new URL(streaming ? STREAMING_TOKEN_URL : PROVIDER_TOKEN_URL);
  url.searchParams.set("expires_in_seconds", String(PROVIDER_TOKEN_TTL_SECONDS));
  url.searchParams.set("max_session_duration_seconds", String(PROVIDER_SESSION_SECONDS));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        Authorization: streaming ? config.providerKey : `Bearer ${config.providerKey}`,
      },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.any([controller.signal, signal]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("upstream rejected request");
    }
    const payload = await readUpstreamJson(response);
    if (typeof payload.token !== "string" || payload.token.length < 16 || payload.token.length > 4_096) {
      throw new Error("upstream returned an invalid token");
    }
    return payload.token;
  } finally {
    clearTimeout(timeout);
  }
}

export function createVoiceFacade({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, quotaFs = quotaFileSystem } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  const config = loadConfig(env);
  const sessions = new Map();
  const sessionLimiter = new SlidingWindowLimiter({ limit: config.sessionRateLimit, now });
  const tokenLimiter = new SlidingWindowLimiter({ limit: config.tokenRateLimit, now });
  const globalTokenLimiter = new SlidingWindowLimiter({
    limit: config.globalTokenRateLimit,
    now,
  });
  const dailyLedger = new DurableIssuanceLedger({ file: config.quotaFile, limit: config.dailyTokenLimit, now, fs: quotaFs, distRoot: config.distRoot });

  function pruneSessions() {
    const current = now();
    for (const [key, session] of sessions) {
      if (session.expiresAt <= current) sessions.delete(key);
    }
    sessionLimiter.prune();
    tokenLimiter.prune();
    globalTokenLimiter.prune();
  }

  const cleanupTimer = setInterval(pruneSessions, 60_000);
  cleanupTimer.unref?.();

  async function handle(request, response) {
    const host = exactHeader(request, "host")?.toLowerCase();
    if (!host || !config.allowedHosts.has(host)) {
      writeError(request, response, 421, "misdirected_request");
      return;
    }

    const url = safeRequestUrl(request);
    if (!url) {
      writeError(request, response, 400, "bad_request");
      return;
    }

    const { pathname, search } = url;
    if (hasRequestBody(request)) {
      writeError(request, response, 413, "request_body_not_allowed");
      return;
    }

    if (
      pathname.startsWith("/api/") &&
      config.requireHttpsProxy &&
      (!isLoopback(request.socket.remoteAddress) || exactHeader(request, "x-forwarded-proto") !== "https")
    ) {
      writeError(request, response, 403, "forbidden");
      return;
    }

    if (pathname === "/healthz") {
      if (request.method !== "GET") {
        writeError(request, response, 405, "method_not_allowed", { Allow: "GET" });
        return;
      }
      if (search) {
        writeError(request, response, 400, "bad_request");
        return;
      }
      write(request, response, 200, { status: "ok" });
      return;
    }

    if (pathname === "/api/session") {
      if (request.method !== "GET") {
        writeError(request, response, 405, "method_not_allowed", { Allow: "GET" });
        return;
      }
      if (search) {
        writeError(request, response, 400, "bad_request");
        return;
      }

      const ipIdentity = clientIdentity(request);
      const rate = sessionLimiter.take(ipIdentity);
      if (!rate.allowed) {
        writeError(request, response, 429, "rate_limited", { "Retry-After": rate.retryAfter });
        return;
      }
      const accessCode = exactHeader(request, "x-suara-access-code");
      if (!accessCode || !timingSafeEqual(Buffer.from(digest(accessCode)), Buffer.from(config.accessCodeHash))) {
        writeError(request, response, 401, "access_code_required");
        return;
      }
      pruneSessions();
      if (sessions.size >= 10_000) {
        writeError(request, response, 503, "service_unavailable");
        return;
      }

      const token = randomBytes(32).toString("base64url");
      sessions.set(digest(token), {
        expiresAt: now() + SESSION_TTL_SECONDS * 1_000,
        ipIdentity,
      });
      write(request, response, 200, {
        expires_in_seconds: SESSION_TTL_SECONDS,
        token,
        token_type: "Bearer",
      });
      return;
    }

    if (pathname === "/api/voice/token" || pathname === "/api/streaming/token") {
      const streaming = pathname === "/api/streaming/token";
      // Personalised questions require the Vercel capability state. Never mint
      // an ordinary token while silently discarding the additional consent.
      if (request.headers["x-suara-question-policy"] !== undefined) {
        writeError(request, response, 503, "questions_not_configured");
        return;
      }
      if (request.method !== "POST") {
        writeError(request, response, 405, "method_not_allowed", { Allow: "POST" });
        return;
      }
      if (search) {
        writeError(request, response, 400, "bad_request");
        return;
      }
      if (exactHeader(request, "origin") !== config.publicOrigin) {
        writeError(request, response, 403, "forbidden");
        return;
      }
      if (streaming && !config.streamingEnabled) {
        writeError(request, response, 503, "streaming_not_configured");
        return;
      }

      const authorization = exactHeader(request, "authorization");
      const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
      if (!match) {
        writeError(request, response, 401, "unauthorized", { "WWW-Authenticate": "Bearer" });
        return;
      }

      pruneSessions();
      const sessionKey = digest(match[1]);
      const session = sessions.get(sessionKey);
      const ipIdentity = clientIdentity(request);
      if (!session || session.expiresAt <= now() || session.ipIdentity !== ipIdentity) {
        sessions.delete(sessionKey);
        writeError(request, response, 401, "unauthorized", { "WWW-Authenticate": "Bearer" });
        return;
      }

      for (const [limiter, key] of [
        [tokenLimiter, ipIdentity],
        [globalTokenLimiter, "global"],
      ]) {
        const rate = limiter.take(key);
        if (!rate.allowed) {
          writeError(request, response, 429, "rate_limited", { "Retry-After": rate.retryAfter });
          return;
        }
      }

      // The local bearer is deliberately single-use, even when the provider is unavailable.
      sessions.delete(sessionKey);
      try {
        const rate = dailyLedger.take();
        if (!rate.allowed) {
          writeError(request, response, 429, "rate_limited", { "Retry-After": rate.retryAfter });
          return;
        }
      } catch {
        writeError(request, response, 503, "quota_unavailable");
        return;
      }
      const cancellation = new AbortController();
      const onClose = () => cancellation.abort();
      response.once("close", onClose);
      try {
        const mint = streaming ? mintStreamingProviderToken : mintProviderToken;
        const providerToken = await mint(config, fetchImpl, cancellation.signal);
        if (cancellation.signal.aborted || response.destroyed) return;
        write(request, response, 200, {
          expires_in_seconds: PROVIDER_TOKEN_TTL_SECONDS,
          max_session_duration_seconds: PROVIDER_SESSION_SECONDS,
          token: providerToken,
        });
      } catch {
        if (!response.destroyed) writeError(request, response, 502, "voice_token_unavailable");
      } finally {
        response.off("close", onClose);
      }
      return;
    }

    if (pathname.startsWith("/api/")) {
      writeError(request, response, 404, "not_found");
      return;
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      writeError(request, response, 405, "method_not_allowed", { Allow: "GET, HEAD" });
      return;
    }
    await sendStatic(request, response, config, pathname);
  }

  const server = http.createServer({
    headersTimeout: 5_000,
    keepAliveTimeout: 5_000,
    maxHeaderSize: 8_192,
    requestTimeout: REQUEST_TIMEOUT_MS,
  }, (request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) writeError(request, response, 500, "internal_error");
      else response.destroy();
    });
  });
  server.maxHeadersCount = 48;
  server.on("checkContinue", (request, response) => {
    writeError(request, response, 417, "expectation_failed");
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });

  async function close() {
    clearInterval(cleanupTimer);
    if (!server.listening) { dailyLedger.close(); return; }
    await new Promise((finish) => {
      server.close(finish);
      server.closeIdleConnections?.();
      const force = setTimeout(() => {
        server.closeAllConnections?.();
      }, 5_000);
      force.unref?.();
    });
    dailyLedger.close();
  }

  return { close, config, server };
}

export async function startFromEnvironment(env = process.env) {
  const facade = createVoiceFacade({ env });
  try { await new Promise((resolveListen, rejectListen) => {
    facade.server.once("error", rejectListen);
    facade.server.listen(facade.config.port, facade.config.listenHost, () => {
      facade.server.off("error", rejectListen);
      resolveListen();
    });
  }); } catch (error) { await facade.close(); throw error; }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await facade.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return facade;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startFromEnvironment().catch(() => {
    // Startup failures stay generic so configuration values and credentials are never emitted.
    process.stderr.write("Suara voice facade could not start.\n");
    process.exitCode = 1;
  });
}
