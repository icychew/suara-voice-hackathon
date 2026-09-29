import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readInterfaceLocale, withInterfaceLocale } from "../src/locale.js";

const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const page = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("public source contains all three Malaysian interface lanes", () => {
  assert.match(app, /Bahasa Malaysia/);
  assert.match(app, /Every life deserves/);
  assert.match(app, /每段人生/);
  assert.match(app, /zh-Hans-MY/);
});

test("public source preserves synthetic-only and non-publication boundaries", () => {
  assert.match(app, /Synthetic demonstration only/);
  assert.match(app, /Real-family intake is not open/);
  assert.match(app, /publication and release stay blocked/);
  assert.match(app, /Public-audio datasets approved for benchmarking/);
});

test("landing page exposes the private voice pilot while retaining the synthetic route", () => {
  assert.match(app, /prototypeHref = withInterfaceLocale\("\/prototype\/", locale\)/);
  assert.match(app, /voiceEntryRoute = __SUARA_VOICE_ENTRY_ROUTE__/);
  assert.match(app, /voiceHref = voiceEntryEnabled \? withInterfaceLocale\(voiceEntryRoute, locale\) : prototypeHref/);
  assert.match(app, /href=\{prototypeHref\}/);
  assert.match(app, /voiceEntryEnabled \? voiceHref : prototypeHref/);
});

test("only an allowlisted interface locale carries from landing to prototype", () => {
  assert.equal(readInterfaceLocale("?lang=ms"), "ms");
  assert.equal(readInterfaceLocale("?lang=zh"), "zh");
  assert.equal(readInterfaceLocale("?lang=not-a-locale"), "en");
  assert.equal(withInterfaceLocale("/prototype/", "ms"), "/prototype/?lang=ms");
  assert.equal(withInterfaceLocale("/prototype/", "not-a-locale"), "/prototype/?lang=en");
  assert.equal(withInterfaceLocale("/voice/", "zh"), "/voice/?lang=zh");
  assert.match(app, /readInterfaceLocale\(window\.location\.search\)/);
});

test("public source has no writable or network client surface", () => {
  for (const forbidden of [/<form\b/i, /<input\b/i, /\bfetch\s*\(/i, /XMLHttpRequest/i, /WebSocket/i, /\/api\//i]) {
    assert.doesNotMatch(app, forbidden);
  }
});

test("page metadata declares a closed network boundary", () => {
  assert.match(page, /connect-src 'none'/);
  assert.match(page, /form-action 'none'/);
  assert.match(page, /https:\/\/suaraproject\.tech\//);
});
