import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { mintProviderToken, mintStreamingProviderToken } from "./voice-facade.mjs";
import { createRedisState } from "./vercel-redis-state.mjs";
import { selectQuestion as gatewaySelectQuestion } from "./question-selector.mjs";
import { QuestionRequestError, readQuestionRequest } from "./question-request.mjs";
import { QUESTION_POLICY, MAX_INTERVIEW_QUESTIONS, OPENING_QUESTION_ID, eligibleQuestions } from "../src/voice/questionBank.js";

const HEADERS = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
});
const QUESTION_ROUTE = "/api/interview/question";
const ROUTES = new Map([["/api/session", "GET"], ["/api/capabilities", "GET"], ["/api/voice/token", "POST"], ["/api/streaming/token", "POST"], [QUESTION_ROUTE, "POST"]]);
const hash = (value) => createHash("sha256").update(value).digest("base64url");
const capabilityHash = (value, secret) => createHmac("sha256", secret).update(`question:${value}`).digest("base64url");

function integer(value, fallback, max) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) {
    throw new Error("Invalid voice configuration.");
  }
  return Number(value);
}

export function loadVercelVoiceConfig(env) {
  if (env.VERCEL !== "1" || env.SUARA_ENABLE_VERCEL_VOICE !== "true") {
    throw new Error("Vercel voice is not enabled.");
  }
  const origin = new URL(env.SUARA_PUBLIC_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== env.SUARA_PUBLIC_ORIGIN || origin.username || origin.password) {
    throw new Error("An exact HTTPS origin is required.");
  }
  const providerKey = env.ASSEMBLYAI_API_KEY;
  const accessCode = env.SUARA_JUDGE_ACCESS_CODE;
  if (typeof providerKey !== "string" || !providerKey.trim() || /[\r\n]/.test(providerKey) || providerKey.length > 4096
    || typeof accessCode !== "string" || !/^[!-~]{16,128}$/.test(accessCode)) {
    throw new Error("Voice credentials are not configured.");
  }
  const prefix = env.SUARA_REDIS_PREFIX;
  if (typeof prefix !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(prefix)) throw new Error("A stable Redis namespace is required.");
  // Vercel Marketplace's Upstash integration currently injects KV_REST_API_*.
  // Keep the explicit UPSTASH_* contract for direct deployments, while accepting
  // the managed aliases without copying or revealing the integration secrets.
  const redisUrl = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  return {
    origin: origin.origin, host: origin.host, providerKey, accessCode,
    streamingEnabled: env.SUARA_ENABLE_STREAMING_VOICE === "true",
    questionsEnabled: env.SUARA_ENABLE_AI_QUESTIONS === "true" && env.SUARA_ENABLE_STREAMING_VOICE === "true",
    redisUrl, redisToken, prefix,
    sessionLimit: integer(env.SUARA_SESSION_RATE_LIMIT, 6, 100),
    tokenLimit: integer(env.SUARA_TOKEN_RATE_LIMIT, 2, 50),
    globalLimit: integer(env.SUARA_GLOBAL_TOKEN_RATE_LIMIT, 6, 1000),
    dailyLimit: integer(env.SUARA_DAILY_TOKEN_LIMIT, 60, 10000),
  };
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}
function error(status, code, extra) { return json(status, { error: code }, extra); }

// Vercel-only adapter. Never deploy the loopback socket/header trust model here.
// See https://vercel.com/docs/headers/request-headers.rsc . All forwarded input
// remains untrusted outside Vercel; production enablement is explicit.
export function createVercelVoiceHandler({ route, env = process.env, fetchImpl = globalThis.fetch,
  stateFactory = createRedisState, selectQuestion = gatewaySelectQuestion } = {}) {
  if (!ROUTES.has(route)) throw new Error("Unknown voice route.");
  return async function handle(request) {
    let config;
    let state;
    let questionPolicy;
    try {
      config = loadVercelVoiceConfig(env);
      questionPolicy = request.headers.get("x-suara-question-policy");
      if ((questionPolicy !== null && questionPolicy !== QUESTION_POLICY)
          || (questionPolicy !== null && route !== "/api/streaming/token" && route !== QUESTION_ROUTE)
          || (route === QUESTION_ROUTE && questionPolicy !== QUESTION_POLICY)) return error(400, "bad_request");
      if ((questionPolicy !== null || route === QUESTION_ROUTE) && !config.questionsEnabled) {
        return error(503, "question_not_configured");
      }
      if (route === "/api/streaming/token" && !config.streamingEnabled) {
        return error(503, "streaming_not_configured");
      }
      state = stateFactory({ url: config.redisUrl, token: config.redisToken, prefix: config.prefix, fetchImpl });
    } catch { return error(503, "voice_not_configured"); }

    try {
      const url = new URL(request.url);
      if (request.url.length > 2048 || url.pathname !== route || url.search) return error(400, "bad_request");
      if (url.origin !== config.origin || request.headers.get("host")?.toLowerCase() !== config.host
        || request.headers.get("x-forwarded-proto") !== "https") return error(421, "misdirected_request");
      if (request.method !== ROUTES.get(route)) return error(405, "method_not_allowed", { Allow: ROUTES.get(route) });
      if (route !== QUESTION_ROUTE && (request.body !== null || request.headers.has("transfer-encoding")
        || (request.headers.has("content-length") && request.headers.get("content-length") !== "0"))) {
        return error(413, "request_body_not_allowed");
      }
      const origin = request.headers.get("origin");
      if ((origin && origin !== config.origin) || (!["/api/session", "/api/capabilities"].includes(route) && origin !== config.origin)
        || request.headers.get("sec-fetch-site") === "cross-site") return error(403, "forbidden");
      // Vercel overwrites this single-IP header. Reject chains and missing data;
      // do not trust x-real-ip, arbitrary forwarded hosts, or fallback socket IPs.
      const ip = request.headers.get("x-vercel-forwarded-for");
      if (!ip || ip.length > 64 || !isIP(ip)) return error(403, "forbidden");
      const ipHash = createHmac("sha256", config.accessCode).update(ip).digest("base64url");
      if (request.signal.aborted) return error(499, "request_cancelled");

      if (route === "/api/session" || route === "/api/capabilities") {
        let rate;
        try { rate = await state.admitSession({ ipHash, limit: config.sessionLimit }); }
        catch { return error(503, "quota_unavailable"); }
        if (!rate.allowed) return error(429, "rate_limited", { "Retry-After": String(rate.retryAfter) });
        const code = request.headers.get("x-suara-access-code");
        if (!code || code.length > 128 || !timingSafeEqual(Buffer.from(hash(code)), Buffer.from(hash(config.accessCode)))) {
          return error(401, "access_code_required");
        }
        if (request.signal.aborted) return error(499, "request_cancelled");
        // Authenticated, throttled configuration only: no bearer, provider call,
        // session reservation, transcript, or credential enters this response.
        if (route === "/api/capabilities") return json(200, {
          schemaVersion: "suara.voice_capabilities/1",
          streaming: config.streamingEnabled,
          aiQuestions: config.questionsEnabled,
        });
        const token = randomBytes(32).toString("base64url");
        try { await state.saveSession({ tokenHash: hash(token), ipHash, ttlSeconds: 120 }); }
        catch { return error(503, "quota_unavailable"); }
        if (request.signal.aborted) return error(499, "request_cancelled");
        return json(200, { token, token_type: "Bearer", expires_in_seconds: 120 });
      }

      const authorization = request.headers.get("authorization");
      const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
      if (!match) return error(401, "unauthorized", { "WWW-Authenticate": "Bearer" });
      if (route === QUESTION_ROUTE) {
        let body;
        try { body = await readQuestionRequest(request); }
        catch (cause) {
          return cause instanceof QuestionRequestError
            ? error(cause.status, cause.code) : error(400, "bad_request");
        }
        if (request.signal.aborted) return error(499, "request_cancelled");
        const reservation = {
          capabilityHash: capabilityHash(match[1], config.accessCode), ipHash,
          sequence: body.sequence, operationId: randomBytes(16).toString("hex"),
        };
        let grant;
        let candidates;
        try {
          grant = await state.reserveQuestion(reservation);
          if (grant?.allowed === false) return error(401, "unauthorized");
          if (grant?.allowed !== true || !Array.isArray(grant.selectedIds)
              || grant.selectedIds.length !== body.sequence + 1
              || grant.selectedIds[0] !== OPENING_QUESTION_ID) throw new Error();
          candidates = eligibleQuestions(grant.selectedIds);
          if (!candidates.length) throw new Error();
        } catch { return error(503, "quota_unavailable"); }
        // The server ledger records selected IDs, not spoken/heard questions.
        // Uncertain reserve/selection/commit outcomes are never retried/unlocked.
        if (request.signal.aborted) return error(499, "request_cancelled");
        let selected;
        let selectedId;
        try {
          selected = await selectQuestion({ providerKey: config.providerKey,
            transcript: body.transcript, selectedIds: [...grant.selectedIds], fetchImpl, signal: request.signal });
          selectedId = selected?.questionId;
          if (!selected || typeof selected !== "object" || Array.isArray(selected)
              || Object.keys(selected).length !== 1 || !Object.hasOwn(selected, "questionId")
              || !candidates.some((question) => question.id === selectedId)) throw new Error();
        } catch {
          return request.signal.aborted ? error(499, "request_cancelled") : error(502, "question_unavailable");
        }
        if (request.signal.aborted) return error(499, "request_cancelled");
        let committed;
        try {
          committed = await state.commitQuestion({ ...reservation, questionId: selectedId });
          if (committed?.committed !== true || committed.nextSequence !== body.sequence + 1
              || committed.nextSequence >= MAX_INTERVIEW_QUESTIONS) throw new Error();
        } catch { return error(503, "quota_unavailable"); }
        if (request.signal.aborted) return error(499, "request_cancelled");
        return json(200, { questionId: selectedId, nextSequence: committed.nextSequence });
      }
      const questionCapability = questionPolicy === QUESTION_POLICY ? randomBytes(32).toString("base64url") : null;
      let rate;
      try {
        rate = await state.consumeSession({ tokenHash: hash(match[1]), ipHash,
          tokenLimit: config.tokenLimit, globalLimit: config.globalLimit, dailyLimit: config.dailyLimit,
          ...(questionCapability ? { questionCapabilityHash: capabilityHash(questionCapability, config.accessCode) } : {}) });
      } catch { return error(503, "quota_unavailable"); }
      if (questionCapability && rate?.allowed !== true && rate?.allowed !== false) return error(503, "quota_unavailable");
      if (!rate.allowed) {
        return rate.reason === "unauthorized"
          ? error(401, "unauthorized", { "WWW-Authenticate": "Bearer" })
          : error(429, "rate_limited", { "Retry-After": String(rate.retryAfter) });
      }
      // A definite successful atomic consume/reservation is the only mint path.
      // Cancellation, failures and uncertain Redis writes never refund usage.
      if (request.signal.aborted) return error(499, "request_cancelled");
      try {
        const mint = route === "/api/streaming/token" ? mintStreamingProviderToken : mintProviderToken;
        const token = await mint(config, fetchImpl, request.signal);
        if (request.signal.aborted) return error(499, "request_cancelled");
        return json(200, { token, expires_in_seconds: 60, max_session_duration_seconds: 600,
          ...(questionCapability ? { question_access: { policy: QUESTION_POLICY, capability: questionCapability,
            nextSequence: 0, expires_in_seconds: 600, max_selections: MAX_INTERVIEW_QUESTIONS } } : {}) });
      } catch {
        return request.signal.aborted
          ? error(499, "request_cancelled")
          : error(502, "voice_token_unavailable");
      }
    } catch { return error(500, "internal_error"); }
  };
}
