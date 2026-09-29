import { MAX_INTERVIEW_QUESTIONS, QUESTION_POLICY } from "../src/voice/questionBank.js";

const MAX_BYTES = 16_384;
const READ_DEADLINE_MS = 1000;
const JSON_STRING = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
const JSON_NUMBER = String.raw`-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const PAIR = `${JSON_STRING}\\s*:\\s*(?:${JSON_STRING}|${JSON_NUMBER})`;
// Exactly three scalar pairs. Combined with the parsed exact-key check, this
// rejects duplicate/escaped duplicate property names instead of overwriting them.
const BODY_SHAPE = new RegExp(`^\\s*\\{\\s*${PAIR}\\s*,\\s*${PAIR}\\s*,\\s*${PAIR}\\s*\\}\\s*$`, "u");

export class QuestionRequestError extends Error {
  constructor(status, code) {
    super("Question request unavailable.");
    this.status = status;
    this.code = code;
  }
}

function reject(status = 400, code = "bad_request") { throw new QuestionRequestError(status, code); }
function cancelQuietly(body) {
  try { Promise.resolve(body?.cancel?.()).catch(() => {}); } catch { /* Never wait for cleanup. */ }
}

/** Read actual streamed bytes under one deadline. Never logs or echoes content. */
export async function readQuestionRequest(request) {
  const deadlineAt = performance.now() + READ_DEADLINE_MS;
  let reader = null;
  let done = false;
  let closed = false;
  let timer;
  let rejectCancelled;
  const cancelled = new Promise((_resolve, rejectPromise) => { rejectCancelled = rejectPromise; });
  const cancel = () => rejectCancelled(new QuestionRequestError(499, "request_cancelled"));
  const active = () => {
    if (request.signal.aborted) reject(499, "request_cancelled");
    if (performance.now() >= deadlineAt) reject(408, "request_timeout");
    if (closed) reject();
  };
  try {
    active();
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") || "")) {
      reject(415, "unsupported_media_type");
    }
    const declared = request.headers.get("content-length");
    if (declared !== null && !/^(0|[1-9]\d*)$/.test(declared)) reject();
    if (declared !== null && Number(declared) > MAX_BYTES) reject(413, "request_too_large");
    if (!request.body || typeof request.body.getReader !== "function") reject();
    reader = request.body.getReader();
    request.signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => rejectCancelled(new QuestionRequestError(408, "request_timeout")), READ_DEADLINE_MS);
    if (request.signal.aborted) cancel();
    const read = (async () => {
      const chunks = [];
      let total = 0;
      while (true) {
        active();
        const next = await reader.read();
        active();
        if (next.done) { done = true; break; }
        if (!(next.value instanceof Uint8Array) || !next.value.byteLength) reject();
        total += next.value.byteLength;
        if (total > MAX_BYTES) reject(413, "request_too_large");
        chunks.push(new Uint8Array(next.value));
      }
      if (declared !== null && Number(declared) !== total) reject();
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!BODY_SHAPE.test(text)) reject();
      const body = JSON.parse(text);
      if (!body || Object.keys(body).sort().join(",") !== "sequence,transcript,version"
          || body.version !== QUESTION_POLICY || !Number.isSafeInteger(body.sequence)
          || body.sequence < 0 || body.sequence >= MAX_INTERVIEW_QUESTIONS
          || typeof body.transcript !== "string" || !body.transcript.trim()
          || body.transcript.length > 4000 || !body.transcript.isWellFormed()
          || Buffer.byteLength(body.transcript, "utf8") > 12000) reject();
      active();
      return Object.freeze(body);
    })();
    return await Promise.race([read, cancelled]);
  } catch (cause) {
    if (cause instanceof QuestionRequestError) throw cause;
    reject();
  } finally {
    closed = true;
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    if (reader) {
      if (!done) cancelQuietly(reader);
      try { reader.releaseLock(); } catch { /* An ignored pending read may still own it. */ }
    } else cancelQuietly(request.body);
  }
}
