const failure = (kind = "capabilities") => Object.assign(new Error(kind), { kind });
const MAX_BYTES = 1024;

export function validateVoiceCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "aiQuestions,schemaVersion,streaming"
      || value.schemaVersion !== "suara.voice_capabilities/1"
      || typeof value.streaming !== "boolean" || typeof value.aiQuestions !== "boolean"
      || (value.aiQuestions && !value.streaming)) throw failure();
  return Object.freeze({ streaming: value.streaming, aiQuestions: value.aiQuestions });
}

// This check is an explicit authenticated configuration read. It never requests
// a local bearer/provider token, opens audio, or establishes provider readiness.
export async function fetchVoiceCapabilities({ accessCode, signal, fetchImpl = fetch } = {}) {
  if (typeof accessCode !== "string" || !/^[!-~]{16,128}$/.test(accessCode)) throw failure("access");
  if (signal?.aborted) throw failure("cancelled");
  const controller = new AbortController();
  let reader, response, timer, rejectAbort, closed = false;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const cancel = () => { controller.abort(); rejectAbort(failure(signal?.aborted ? "cancelled" : "capabilities")); };
  const active = () => { if (closed || controller.signal.aborted) throw failure("cancelled"); };
  const cancelBody = (body) => { try { Promise.resolve(body?.cancel?.()).catch(() => {}); } catch { /* Best effort. */ } };
  try {
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(cancel, 5000);
    if (signal?.aborted) cancel();
    return await Promise.race([aborted, (async () => {
      active();
      response = await fetchImpl("/api/capabilities", {
        method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { Accept: "application/json", "X-Suara-Access-Code": accessCode }, signal: controller.signal,
      });
      if (closed || controller.signal.aborted) { cancelBody(response?.body); throw failure("cancelled"); }
      if (response?.status === 401) throw failure("access");
      if (response?.status === 429) throw failure("capacity");
      if (response?.status !== 200 || response.ok !== true || response.redirected === true
          || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers?.get?.("content-type") || "")
          || typeof response.body?.getReader !== "function") throw failure();
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_BYTES)) throw failure();
      reader = response.body.getReader();
      const bytes = new Uint8Array(MAX_BYTES);
      let length = 0;
      while (true) {
        const next = await reader.read();
        active();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || length + next.value.length > MAX_BYTES) throw failure();
        bytes.set(next.value, length); length += next.value.length;
      }
      if (!length || (declared !== null && Number(declared) !== length)) throw failure();
      const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
      return validateVoiceCapabilities(payload);
    })()]);
  } catch (error) {
    throw failure(["access", "capacity", "cancelled"].includes(error?.kind) ? error.kind : "capabilities");
  } finally {
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.abort();
    cancelBody(reader || response?.body);
    try { reader?.releaseLock(); } catch { /* Pending reads are cancelled without blocking. */ }
  }
}
