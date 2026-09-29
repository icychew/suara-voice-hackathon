import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Vercel upload excludes generated build state and private release worktrees", async () => {
  const entries = (await readFile(new URL("../.vercelignore", import.meta.url), "utf8"))
    .split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
  assert.ok(entries.includes(".vercel"));
  assert.ok(entries.includes(".release-build"));
  assert.ok(entries.includes(".env*"));
  assert.ok(entries.includes("dist-operator"));
});
