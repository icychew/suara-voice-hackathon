const PAGE_CHECKS = Object.freeze([
  { path: "/", marker: "Suara — memories, with evidence" },
  { path: "/voice/", marker: "Suara — guided voice memory pilot" },
  { path: "/prototype/", marker: "Suara — interactive synthetic prototype" },
]);
const MAX_HTML_BYTES = 256 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const REQUIRED_HEADERS = Object.freeze({
  "cache-control": /(?:^|,)\s*(?:private,\s*)?no-store(?:\s*,|$)/iu,
  "content-security-policy": /frame-ancestors\s+'none'/iu,
  "cross-origin-opener-policy": /^same-origin$/iu,
  "cross-origin-resource-policy": /^same-origin$/iu,
  "permissions-policy": /microphone=\(self\)/iu,
  "referrer-policy": /^no-referrer$/iu,
  "x-content-type-options": /^nosniff$/iu,
  "x-frame-options": /^DENY$/iu,
});
const FORBIDDEN_BODY_TEXT = Object.freeze([
  "ASSEMBLYAI_API_KEY",
  "UPSTASH_REDIS_REST_TOKEN",
  "SUARA_JUDGE_ACCESS_CODE=",
  "suara.operator_timing/1",
]);

export class HostedAcceptanceError extends Error {
  constructor(check, code) {
    super(`${check}: ${code}`);
    this.name = "HostedAcceptanceError";
    this.check = check;
    this.code = code;
  }
}

export function validateHostedOrigin(value) {
  if (typeof value !== "string" || value.trim() !== value || value === "") throw new HostedAcceptanceError("origin", "invalid");
  let url;
  try { url = new URL(value); } catch { throw new HostedAcceptanceError("origin", "invalid"); }
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.port
      || url.hostname === "localhost" || !url.hostname.includes(".")) {
    throw new HostedAcceptanceError("origin", "exact_public_https_origin_required");
  }
  return url.origin;
}

async function readBounded(response, limit, check) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    throw new HostedAcceptanceError(check, "body_too_large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HostedAcceptanceError(check, "body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

async function request(fetchImpl, url, { method = "GET", accept = "*/*", limit = MAX_HTML_BYTES, check }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: { Accept: accept, "User-Agent": "Suara-Hosted-Acceptance/1" },
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!(response instanceof Response)) throw new HostedAcceptanceError(check, "invalid_response");
    if (response.status >= 300 && response.status < 400) throw new HostedAcceptanceError(check, "redirect_not_allowed");
    const body = method === "HEAD" ? new Uint8Array() : await readBounded(response, limit, check);
    return { response, body };
  } catch (error) {
    if (error instanceof HostedAcceptanceError) throw error;
    throw new HostedAcceptanceError(check, error?.name === "AbortError" ? "timeout" : "network_error");
  } finally {
    clearTimeout(timeout);
  }
}

function assertHeaders(response, check) {
  for (const [name, pattern] of Object.entries(REQUIRED_HEADERS)) {
    const value = response.headers.get(name);
    if (value === null || !pattern.test(value)) throw new HostedAcceptanceError(check, `header_${name}_invalid`);
  }
}

function assertNoPrivateMarkers(text, check) {
  for (const marker of FORBIDDEN_BODY_TEXT) if (text.includes(marker)) throw new HostedAcceptanceError(check, "private_marker_exposed");
}

function referencedAssets(html) {
  const assets = new Set();
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"[^>]*>/giu)) {
    if (match[1].startsWith("/assets/")) assets.add(match[1]);
  }
  if (assets.size === 0 || assets.size > 32) throw new HostedAcceptanceError("static_assets", "unexpected_asset_count");
  return [...assets].sort();
}

function exactJson(body, expected, check) {
  let value;
  try { value = JSON.parse(new TextDecoder().decode(body)); }
  catch { throw new HostedAcceptanceError(check, "invalid_json"); }
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new HostedAcceptanceError(check, "unexpected_json");
}

export async function runHostedAcceptance({ origin, fetchImpl = globalThis.fetch } = {}) {
  const base = validateHostedOrigin(origin);
  if (typeof fetchImpl !== "function") throw new HostedAcceptanceError("fetch", "unavailable");
  const checks = [];
  const assets = new Set();

  for (const page of PAGE_CHECKS) {
    const check = `page:${page.path}`;
    const { response, body } = await request(fetchImpl, `${base}${page.path}`, { accept: "text/html", check });
    if (response.status !== 200) throw new HostedAcceptanceError(check, `status_${response.status}`);
    assertHeaders(response, check);
    if (!/^text\/html(?:\s*;|\s*$)/iu.test(response.headers.get("content-type") || "")) throw new HostedAcceptanceError(check, "content_type_invalid");
    const html = new TextDecoder().decode(body);
    if (!html.includes(page.marker) || !html.includes('<div id="root"></div>')) throw new HostedAcceptanceError(check, "identity_invalid");
    assertNoPrivateMarkers(html, check);
    for (const asset of referencedAssets(html)) assets.add(asset);
    checks.push({ check, status: "pass", bytes: body.byteLength });
  }

  for (const path of [...assets].sort()) {
    const check = `asset:${path}`;
    const { response, body } = await request(fetchImpl, `${base}${path}`, { limit: MAX_ASSET_BYTES, check });
    if (response.status !== 200) throw new HostedAcceptanceError(check, `status_${response.status}`);
    assertHeaders(response, check);
    assertNoPrivateMarkers(new TextDecoder().decode(body), check);
    checks.push({ check, status: "pass", bytes: body.byteLength });
  }

  const health = await request(fetchImpl, `${base}/api/health`, { accept: "application/json", check: "health:get" });
  if (health.response.status !== 200) throw new HostedAcceptanceError("health:get", `status_${health.response.status}`);
  assertHeaders(health.response, "health:get");
  if (!/^application\/json(?:\s*;|\s*$)/iu.test(health.response.headers.get("content-type") || "")) throw new HostedAcceptanceError("health:get", "content_type_invalid");
  exactJson(health.body, { schemaVersion: "suara.health/1", status: "ok", evidenceScope: "vercel_function_liveness_only" }, "health:get");
  checks.push({ check: "health:get", status: "pass", bytes: health.body.byteLength });

  const head = await request(fetchImpl, `${base}/api/health`, { method: "HEAD", accept: "application/json", check: "health:head" });
  if (head.response.status !== 200) throw new HostedAcceptanceError("health:head", `status_${head.response.status}`);
  assertHeaders(head.response, "health:head");
  checks.push({ check: "health:head", status: "pass", bytes: 0 });

  const query = await request(fetchImpl, `${base}/api/health?probe=1`, { accept: "application/json", check: "health:query-denial" });
  if (query.response.status !== 400) throw new HostedAcceptanceError("health:query-denial", `status_${query.response.status}`);
  assertHeaders(query.response, "health:query-denial");
  exactJson(query.body, { error: "invalid_request" }, "health:query-denial");
  checks.push({ check: "health:query-denial", status: "pass", bytes: query.body.byteLength });

  const method = await request(fetchImpl, `${base}/api/health`, { method: "POST", accept: "application/json", check: "health:method-denial" });
  if (method.response.status !== 405 || method.response.headers.get("allow") !== "GET, HEAD") {
    throw new HostedAcceptanceError("health:method-denial", "contract_invalid");
  }
  assertHeaders(method.response, "health:method-denial");
  exactJson(method.body, { error: "method_not_allowed" }, "health:method-denial");
  checks.push({ check: "health:method-denial", status: "pass", bytes: method.body.byteLength });

  return {
    schemaVersion: "suara.hosted_acceptance/1",
    status: "pass",
    origin: base,
    scope: "public_static_and_function_liveness_only",
    checks,
    assetCount: assets.size,
    providerTokenRequested: false,
    protectedCapabilityRouteCalled: false,
    microphoneAccessed: false,
    evidenceBoundary: "This probe proves exact-origin static delivery, response-header policy and /api/health behavior only. It does not inspect secrets, Redis, AssemblyAI, protected capabilities, microphone, audio playback or end-to-end voice readiness.",
  };
}
