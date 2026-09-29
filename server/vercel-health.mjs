const HEALTH_ROUTE = "/api/health";
const HEALTH_PAYLOAD = Object.freeze({
  schemaVersion: "suara.health/1",
  status: "ok",
  evidenceScope: "vercel_function_liveness_only",
});

function response(status, body = null, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

export function createVercelHealthHandler() {
  return async function health(request) {
    if (!(request instanceof Request)) return response(400, JSON.stringify({ error: "invalid_request" }));

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return response(400, JSON.stringify({ error: "invalid_request" }));
    }

    if (url.pathname !== HEALTH_ROUTE) return response(404, JSON.stringify({ error: "not_found" }));
    if (url.search) return response(400, JSON.stringify({ error: "invalid_request" }));
    if (!["GET", "HEAD"].includes(request.method)) {
      return response(405, JSON.stringify({ error: "method_not_allowed" }), { Allow: "GET, HEAD" });
    }

    return response(200, request.method === "HEAD" ? null : JSON.stringify(HEALTH_PAYLOAD));
  };
}
