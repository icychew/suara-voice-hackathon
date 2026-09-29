import assert from "node:assert/strict";
import test from "node:test";

import healthRoute from "../api/health.js";
import { createVercelHealthHandler } from "../server/vercel-health.mjs";

const origin = "https://suara-health-test.vercel.app";

test("health GET proves only function liveness with a fixed non-secret payload", async () => {
  assert.equal(typeof healthRoute.fetch, "function");
  const response = await healthRoute.fetch(new Request(`${origin}/api/health`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), {
    schemaVersion: "suara.health/1",
    status: "ok",
    evidenceScope: "vercel_function_liveness_only",
  });
});

test("health HEAD is bodyless and exposes the same liveness status", async () => {
  const response = await createVercelHealthHandler()(new Request(`${origin}/api/health`, { method: "HEAD" }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("health rejects methods, query strings, wrong paths and malformed calls", async () => {
  const handler = createVercelHealthHandler();
  const method = await handler(new Request(`${origin}/api/health`, { method: "POST" }));
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET, HEAD");
  assert.deepEqual(await method.json(), { error: "method_not_allowed" });

  for (const request of [
    new Request(`${origin}/api/health?detail=1`),
    new Request(`${origin}/api/other`),
  ]) {
    const response = await handler(request);
    assert.equal(response.status, request.url.includes("?") ? 400 : 404);
  }
  assert.equal((await handler(null)).status, 400);
});
