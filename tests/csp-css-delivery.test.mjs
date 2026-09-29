import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = relativePath => readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

const [landingPage, prototypePage, voicePage, landingEntry, prototypeEntry, voiceEntry] = await Promise.all([
  read("index.html"),
  read("prototype/index.html"),
  read("voice/index.html"),
  read("src/main.jsx"),
  read("src/prototype-main.jsx"),
  read("src/voice-main.jsx"),
]);

test("strict-CSP pages load their application styles through same-origin stylesheet links", () => {
  assert.match(landingPage, /<link rel="stylesheet" href="\/src\/styles\.css" \/>/);
  assert.match(prototypePage, /<link rel="stylesheet" href="\/src\/styles\.css" \/>/);
  assert.match(prototypePage, /<link rel="stylesheet" href="\/src\/showcase\.css" \/>/);
  assert.match(voicePage, /<link rel="stylesheet" href="\/src\/voice\/voice\.css" \/>/);

  for (const page of [landingPage, prototypePage, voicePage]) {
    assert.match(page, /style-src 'self'/);
    assert.doesNotMatch(page, /style-src[^;]*'unsafe-inline'/);
  }
});

test("browser entry modules do not depend on CSP-blocked development style injection", () => {
  for (const entry of [landingEntry, prototypeEntry, voiceEntry]) {
    assert.doesNotMatch(entry, /^import\s+["'][^"']+\.css["'];?$/m);
  }
});
