import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const config = JSON.parse(await readFile("vercel.json", "utf8"));
const slackEndpointIncluded = await access(new URL("../api/slack/events.js", import.meta.url))
  .then(() => true, () => false);
assert.equal(config.outputDirectory, "dist");
assert.equal(config.framework, "vite");
// Keep the access endpoints beside the proposed Singapore quota database.
// https://vercel.com/docs/project-configuration/vercel-json#regions
assert.deepEqual(config.regions, ["sin1"], "Voice Functions must target Singapore (sin1).");
const expectedFunctions = {
  "api/health.js": { maxDuration: 5, supportsCancellation: true },
  "api/capabilities.js": { maxDuration: 20, supportsCancellation: true },
  "api/session.js": { maxDuration: 20, supportsCancellation: true },
  "api/voice/token.js": { maxDuration: 20, supportsCancellation: true },
  "api/streaming/token.js": { maxDuration: 20, supportsCancellation: true },
  "api/interview/question.js": { maxDuration: 20, supportsCancellation: true },
};
if (slackEndpointIncluded) {
  expectedFunctions["api/slack/events.js"] = { maxDuration: 90, supportsCancellation: true };
}
assert.deepEqual(config.functions, expectedFunctions,
  "Keep every included health, voice/interview and private coordination endpoint on the shared region with bounded duration and cancellation; no per-function region overrides.");
const csp = config.headers?.find((entry) => entry.source === "/(.*)")?.headers
  ?.find((entry) => entry.key === "Content-Security-Policy")?.value;
assert.equal(csp?.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("connect-src ")),
  "connect-src 'self' wss://agents.assemblyai.com wss://streaming.assemblyai.com",
  "Only the two exact AssemblyAI WebSocket origins may join same-origin connections.");
assert.equal(config.rewrites, undefined, "Do not rewrite every route to the landing page.");
for (const file of ["index.html", "prototype/index.html", "voice/index.html"]) await access(join("dist", file));
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), "No linked files in the deployment artifact.");
    assert.ok(!/^\.env|\.(pem|key)$|suara-operator-only|quota|token-issuance/i.test(entry.name), "Private/operator artifact detected.");
    if (entry.isDirectory()) await inspect(path);
    else if (/\.(html|js|json)$/.test(entry.name)) {
      const text = await readFile(path, "utf8");
      assert.ok(!text.includes("suara.operator_timing/1") && !text.includes("UPSTASH_REDIS_REST_TOKEN")
        && !text.includes("ASSEMBLYAI_API_KEY"), "Operator or server configuration entered static output.");
    }
  }
}
await inspect("dist");
console.log("Vercel normal artifact verified; live deployment and provider remain separate gates.");
