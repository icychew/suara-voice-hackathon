import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runSubmissionPreflight } from "./submission-preflight.mjs";

const args = new Set(process.argv.slice(2));
const allowed = new Set(["--allow-incomplete", "--write-report"]);
for (const arg of args) if (!allowed.has(arg)) throw new TypeError(`unsupported argument: ${arg}`);

const report = await runSubmissionPreflight();
const output = `${JSON.stringify(report, null, 2)}\n`;
if (args.has("--write-report")) {
  const target = resolve("output/hackathon/Suara-Submission-Preflight-Latest.json");
  await writeFile(target, output, { encoding: "utf8", flag: "w" });
  process.stderr.write(`Wrote local preflight report: ${target}\n`);
}
process.stdout.write(output);
if (!report.readyForSubmission && !args.has("--allow-incomplete")) process.exitCode = 2;
