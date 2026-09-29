import { HostedAcceptanceError, runHostedAcceptance } from "./hosted-acceptance.mjs";

const args = process.argv.slice(2);
const originArg = args.find((arg) => arg.startsWith("--origin="));
if (!originArg || args.length !== 1) {
  process.stderr.write("Usage: node scripts/qa-hosted-acceptance.mjs --origin=https://exact-public-origin\n");
  process.exitCode = 2;
} else {
  try {
    const report = await runHostedAcceptance({ origin: originArg.slice("--origin=".length) });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const failure = error instanceof HostedAcceptanceError
      ? { schemaVersion: "suara.hosted_acceptance/1", status: "fail", failedCheck: error.check, code: error.code }
      : { schemaVersion: "suara.hosted_acceptance/1", status: "fail", failedCheck: "probe", code: "unexpected_error" };
    process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    process.exitCode = 1;
  }
}
