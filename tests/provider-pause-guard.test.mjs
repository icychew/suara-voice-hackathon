import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const runner = resolve(root, "scripts/qa-provider-pause.mjs");

test("pause runner import is inert with provider transports disabled", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    globalThis.fetch = () => { throw new Error('Unexpected transport'); };
    globalThis.WebSocket = class { constructor() { throw new Error('Unexpected socket'); } };
    await import('./scripts/qa-provider-pause.mjs');
  `], { cwd: root, encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});

test("pause runner refuses missing execution intent, paths or altered allowance", () => {
  for (const [args, expectedError] of [
    [[], "usage"],
    [["--run"], "usage"],
    [["--run", "--private-config", "relative.env", "--fixtures", "relative.json", "--expected-reservations", "4"], "invalid_path"],
    [["--run", "--private-config", "relative.env", "--fixtures", "relative.json", "--expected-reservations", "0"], "usage"],
    [["--private-config", "relative.env", "--fixtures", "relative.json", "--expected-reservations", "4"], "usage"],
    [["--run", "--env-file", "relative.env", "--fixtures", "relative.json", "--expected-reservations", "4"], "usage"],
  ]) {
    const child = spawnSync(process.execPath, ["--", runner, ...args], { cwd: root, encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, "");
    const receipt = JSON.parse(child.stdout);
    assert.equal(receipt.status, "refused_or_inconclusive");
    assert.equal(receipt.error, expectedError);
    assert.ok(!child.stdout.includes("relative.env"));
  }
});
