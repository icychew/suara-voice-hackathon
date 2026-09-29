import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

async function contents(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? contents(path) : [{ path, text: await readFile(path, "utf8") }];
  }))).flat();
}

for (const directory of ["dist", "dist-public"]) {
  for (const { path, text } of await contents(directory)) {
    if (/operator-only|OperatorVoiceApp|Canary timing observations|manual_operator_canary|timing-opt-in|english-food-v1|Matched audio replay|public-fixed-three-replay-v1|fir63-hamming-causal-v1/.test(`${path}\n${text}`)) {
      throw new Error(`Operator-only material leaked into ${directory}: ${path}`);
    }
  }
}
const marker = JSON.parse(await readFile("dist-operator/suara-operator-only.json", "utf8"));
if (marker.operatorOnly !== true || marker.deployable !== false) throw new Error("Operator build marker missing");
const operatorFiles = await contents("dist-operator");
if (!operatorFiles.some(({ text }) => text.includes("Canary timing observations"))) throw new Error("Operator UI absent");
if (!operatorFiles.some(({ text }) => text.includes("public-fixed-three-replay-v1"))) throw new Error("Replay runner absent");
console.log("Build isolation passed: timing panel exists only in the marked, non-deployable operator build.");
