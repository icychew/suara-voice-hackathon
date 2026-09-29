import assert from "node:assert/strict";
import test from "node:test";

import { buildReviewedMemoryMarkdown, MAX_CORRECTION_CHARS, normalizeMemoryTitle,
  reconcileReviewMap, selectReviewedTurns, setReviewCorrection, setReviewStatus } from "../src/voice/review.js";

test("a final transcript starts unreviewed and an identical final preserves its decision", () => {
  const first = reconcileReviewMap({}, "user-1", "  Original memory.  ");
  assert.deepEqual(first, {
    "user-1": { sourceText: "Original memory.", status: "unreviewed", correction: "" },
  });
  const reviewed = { ...first, "user-1": setReviewStatus(first["user-1"], "reviewed", "Original memory.") };
  assert.equal(reconcileReviewMap(reviewed, "user-1", "Original memory."), reviewed);
});

test("a changed or removed provider final invalidates the prior human review", () => {
  const reviewed = {
    "user-1": { sourceText: "First version", status: "reviewed", correction: "Human correction" },
  };
  assert.deepEqual(reconcileReviewMap(reviewed, "user-1", "Provider correction"), {
    "user-1": { sourceText: "Provider correction", status: "unreviewed", correction: "" },
  });
  assert.deepEqual(reconcileReviewMap(reviewed, "user-1", ""), {});
});

test("editing corrected wording resets approval until the new wording is reviewed", () => {
  const reviewed = { sourceText: "Kampung asal", status: "reviewed", correction: "" };
  const edited = setReviewCorrection(reviewed, "Kampung asal saya", "Kampung asal");
  assert.deepEqual(edited, {
    sourceText: "Kampung asal", status: "unreviewed", correction: "Kampung asal saya",
  });
  assert.equal(setReviewCorrection(edited, "Kampung asal saya", "Kampung asal").status, "unreviewed");
  assert.throws(() => setReviewCorrection(edited, "x".repeat(MAX_CORRECTION_CHARS + 1), "Kampung asal"));
});

test("only current reviewed sources enter the keepsake selection", () => {
  const turns = [
    { key: "a", sourceId: "U01", text: "Original one" },
    { key: "b", sourceId: "U02", text: "Original two" },
    { key: "c", sourceId: "U03", text: "New provider text" },
  ];
  const selected = selectReviewedTurns(turns, {
    a: { sourceText: "Original one", status: "reviewed", correction: "Corrected one" },
    b: { sourceText: "Original two", status: "excluded", correction: "" },
    c: { sourceText: "Old provider text", status: "reviewed", correction: "" },
  });
  assert.deepEqual(selected, [{
    key: "a", sourceId: "U01", sourceText: "Original one", text: "Corrected one", corrected: true,
  }]);
});

test("the downloaded document preserves source identity and the original behind a correction", () => {
  const markdown = buildReviewedMemoryMarkdown({
    title: "  Nenek's\nStory  ",
    fallbackTitle: "A family memory",
    boundary: "Human-reviewed; not AI-authored.",
    sourceLabel: "Source",
    correctedLabel: "Human-corrected wording",
    originalLabel: "Original provider transcript",
    selections: [{
      sourceId: "U01", text: "Line one\nLine two", sourceText: "Provider words", corrected: true,
    }],
  });
  assert.match(markdown, /^# Nenek&#39;s Story/m);
  assert.match(markdown, /> Line one\n> Line two/);
  assert.match(markdown, /Source: U01/);
  assert.match(markdown, /Original provider transcript:\n\n> Provider words/);
  assert.match(markdown, /not AI&#45;authored/);
});

test("untrusted title and transcript punctuation stays literal in Markdown renderers", () => {
  const markdown = buildReviewedMemoryMarkdown({
    title: "# Family <script>alert(1)</script>",
    fallbackTitle: "Memory",
    boundary: "Human-reviewed; not AI-authored.",
    sourceLabel: "Source",
    correctedLabel: "Corrected",
    originalLabel: "Original",
    selections: [{
      sourceId: "U01",
      text: "![family](https://example.invalid/private.png) <img src=x>",
      sourceText: "[provider](mailto:private@example.invalid)",
      corrected: true,
    }],
  });
  assert.doesNotMatch(markdown, /!\[|<script|<img|https?:\/\/|mailto:/);
  assert.match(markdown, /&#33;&#91;family&#93;&#40;https&#58;&#47;&#47;example&#46;invalid/);
  assert.match(markdown, /&#60;script&#62;/);
  assert.match(markdown, /&#64;/);
});

test("indented multiline speech cannot become a Markdown code block", () => {
  const markdown = buildReviewedMemoryMarkdown({
    title: "Recipe",
    fallbackTitle: "Memory",
    boundary: "Human reviewed",
    sourceLabel: "Source",
    correctedLabel: "Corrected",
    originalLabel: "Original",
    selections: [{
      sourceId: "U01",
      text: "Family recipe:\n\n    [one] & two.\n\tthree",
      sourceText: "Family recipe",
      corrected: true,
    }],
  });
  assert.doesNotMatch(markdown, /^> {5}/m);
  assert.doesNotMatch(markdown, /^> \t/m);
  assert.match(markdown, /> &#32;&#32;&#32;&#32;&#91;one&#93; &#38; two&#46;/);
  assert.match(markdown, /> &#9;three/);
});

test("document generation refuses an empty or malformed evidence selection", () => {
  const base = {
    fallbackTitle: "Memory", boundary: "Reviewed only", sourceLabel: "Source",
    correctedLabel: "Corrected", originalLabel: "Original",
  };
  assert.throws(() => buildReviewedMemoryMarkdown({ ...base, selections: [] }));
  assert.throws(() => buildReviewedMemoryMarkdown({
    ...base, selections: [{ sourceId: "secret", text: "Text", sourceText: "Text" }],
  }));
});

test("memory titles are one bounded line with a safe fallback", () => {
  assert.equal(normalizeMemoryTitle("  One\nfamily\tstory ", "Fallback"), "One family story");
  assert.equal(normalizeMemoryTitle("", " Family memory "), "Family memory");
  assert.equal(normalizeMemoryTitle("x".repeat(200), "Fallback").length, 120);
});
