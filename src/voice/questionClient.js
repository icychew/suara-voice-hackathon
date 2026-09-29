import { QUESTION_POLICY, MAX_INTERVIEW_QUESTIONS, eligibleQuestions } from "./questionBank.js";

const failure = () => new Error("question_unavailable");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_REQUEST_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 1024;
const MAX_DEADLINE_MS = 5000;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const JSON_STRING = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
const JSON_NUMBER = String.raw`-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const PAIR = `${JSON_STRING}\\s*:\\s*(?:${JSON_STRING}|${JSON_NUMBER})`;
const RESPONSE_SHAPE = new RegExp(`^\\s*\\{\\s*${PAIR}\\s*,\\s*${PAIR}\\s*\\}\\s*$`, "u");

function cancelQuietly(target) {
  try { Promise.resolve(target?.cancel?.()).catch(() => {}); } catch { /* Best-effort cleanup only. */ }
}

// Keep this session-only capability out of URLs, events, logs and browser storage.
export function validateQuestionGrant(value) {
  try {
    if (!object(value) || Object.keys(value).sort().join(",") !== "capability,expires_in_seconds,max_selections,nextSequence,policy"
        || value.policy !== QUESTION_POLICY || typeof value.capability !== "string" || !TOKEN.test(value.capability)
        || value.nextSequence !== 0 || value.expires_in_seconds !== 600
        || value.max_selections !== MAX_INTERVIEW_QUESTIONS) throw failure();
    return { capability: value.capability, sequence: 0 };
  } catch { throw failure(); }
}

// At most two final answers and 4000 UTF-16 code units; never split a surrogate
// pair. Partial speech, the full transcript and interviewer text are excluded.
export function selectionExcerpt(finalAnswers) {
  try {
    if (!Array.isArray(finalAnswers) || !finalAnswers.length) throw failure();
    const selected = [];
    for (let index = Math.max(0, finalAnswers.length - 2); index < finalAnswers.length; index += 1) {
      if (!Object.hasOwn(finalAnswers, index) || typeof finalAnswers[index] !== "string"
          || finalAnswers[index].length > 32000 || !finalAnswers[index].isWellFormed()) throw failure();
      selected.push(finalAnswers[index]);
    }
    const text = selected.join("\n").slice(-4000).replace(/^[\uDC00-\uDFFF]/, "");
    if (!text.trim() || !text.isWellFormed()) throw failure();
    return text;
  } catch { throw failure(); }
}

export async function requestBankQuestion(options = {}) {
  let capability, sequence, transcript, askedIds, signal, fetchImpl, timeoutMs, eligible, body;
  try {
    if (!object(options)) throw failure();
    ({ capability, sequence, transcript, askedIds, signal, fetchImpl = fetch, timeoutMs = MAX_DEADLINE_MS } = options);
    if (typeof capability !== "string" || !TOKEN.test(capability) || !Number.isSafeInteger(sequence)
        || sequence < 0 || sequence >= MAX_INTERVIEW_QUESTIONS || typeof transcript !== "string"
        || !transcript.trim() || transcript.length > 4000 || !transcript.isWellFormed()
        || new TextEncoder().encode(transcript).length > 12000 || typeof fetchImpl !== "function"
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_DEADLINE_MS
        || (signal !== undefined && (!(signal instanceof AbortSignal) || signal.aborted))) throw failure();
    eligible = eligibleQuestions(askedIds);
    if (!eligible.length) throw failure();
    body = JSON.stringify({ version: QUESTION_POLICY, sequence, transcript });
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) throw failure();
  } catch { throw failure(); }
  const controller = new AbortController();
  let timer, reader, response, rejectAbort;
  let closed = false;
  let readerDone = false;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const cancel = () => { if (!closed) { controller.abort(); rejectAbort(failure()); } };
  const active = () => { if (closed || controller.signal.aborted) throw failure(); };
  try {
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(cancel, timeoutMs);
    if (signal?.aborted) cancel();
    return await Promise.race([aborted, (async () => {
      active();
      response = await fetchImpl("/api/interview/question", {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/json",
          Authorization: `Bearer ${capability}`, "X-Suara-Question-Policy": QUESTION_POLICY },
        body, signal: controller.signal,
      });
      if (closed || controller.signal.aborted) { cancelQuietly(response?.body); throw failure(); }
      if (response?.ok !== true || response.status !== 200 || response.redirected === true
          || typeof response.body?.getReader !== "function") throw failure();
      if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers?.get?.("content-type") || "")) throw failure();
      const declared = response.headers?.get?.("content-length");
      if (declared !== null && declared !== undefined
          && (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw failure();
      reader = response.body.getReader();
      let length = 0;
      const chunks = [];
      while (true) {
        active();
        const next = await reader.read();
        active();
        if (next.done === true) { readerDone = true; break; }
        if (!(next.value instanceof Uint8Array) || !next.value.byteLength) throw failure();
        length += next.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) throw failure();
        chunks.push(new Uint8Array(next.value));
      }
      if (!length || (declared !== null && declared !== undefined && Number(declared) !== length)) throw failure();
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!RESPONSE_SHAPE.test(text)) throw failure();
      const payload = JSON.parse(text);
      if (!object(payload) || Object.keys(payload).sort().join(",") !== "nextSequence,questionId" ||
          payload.nextSequence !== sequence + 1 || !eligible.some((q) => q.id === payload.questionId)) throw failure();
      active();
      return Object.freeze({ questionId: payload.questionId, nextSequence: payload.nextSequence });
    })()]);
  } catch { throw failure(); }
  finally {
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.abort();
    // Cleanup is best effort; never await a possibly stalled provider/browser.
    if (reader) {
      if (!readerDone) cancelQuietly(reader);
      try { reader.releaseLock(); } catch { /* A cancelled read may still own it. */ }
    } else if (response) cancelQuietly(response.body);
  }
}
