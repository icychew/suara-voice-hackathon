export const REVIEW_STATUSES = Object.freeze(["unreviewed", "reviewed", "excluded"]);
export const MAX_CORRECTION_CHARS = 2_000;
export const MAX_MEMORY_TITLE_CHARS = 120;

function cleanSourceText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function reconcileReviewMap(reviewByKey, key, sourceText) {
  if (!isRecord(reviewByKey) || typeof key !== "string" || !key) {
    throw new TypeError("Invalid review state.");
  }
  const source = cleanSourceText(sourceText);
  const current = reviewByKey[key];
  if (!source) {
    if (!Object.hasOwn(reviewByKey, key)) return reviewByKey;
    const next = { ...reviewByKey };
    delete next[key];
    return next;
  }
  if (isRecord(current) && current.sourceText === source
      && REVIEW_STATUSES.includes(current.status)
      && typeof current.correction === "string") return reviewByKey;
  return {
    ...reviewByKey,
    [key]: { sourceText: source, status: "unreviewed", correction: "" },
  };
}

export function setReviewStatus(record, status, sourceText) {
  const source = cleanSourceText(sourceText);
  if (!source || !REVIEW_STATUSES.includes(status)) throw new TypeError("Invalid review decision.");
  const correction = isRecord(record) && record.sourceText === source
    && typeof record.correction === "string" ? record.correction : "";
  return { sourceText: source, status, correction };
}

export function setReviewCorrection(record, correction, sourceText) {
  const source = cleanSourceText(sourceText);
  if (!source || typeof correction !== "string" || correction.length > MAX_CORRECTION_CHARS) {
    throw new TypeError("Invalid corrected wording.");
  }
  const nextCorrection = correction.replace(/\r\n?/g, "\n");
  const priorStatus = isRecord(record) && record.sourceText === source
    && REVIEW_STATUSES.includes(record.status) ? record.status : "unreviewed";
  const priorCorrection = isRecord(record) && record.sourceText === source
    && typeof record.correction === "string" ? record.correction : "";
  return {
    sourceText: source,
    status: priorCorrection === nextCorrection ? priorStatus : "unreviewed",
    correction: nextCorrection,
  };
}

export function selectReviewedTurns(turns, reviewByKey) {
  if (!Array.isArray(turns) || !isRecord(reviewByKey)) throw new TypeError("Invalid review selection.");
  return turns.flatMap((turn) => {
    if (!isRecord(turn) || typeof turn.key !== "string" || typeof turn.sourceId !== "string") return [];
    const sourceText = cleanSourceText(turn.text);
    const review = reviewByKey[turn.key];
    if (!sourceText || !isRecord(review) || review.status !== "reviewed" || review.sourceText !== sourceText) return [];
    const correction = typeof review.correction === "string" ? review.correction.trim() : "";
    return [{
      key: turn.key,
      sourceId: turn.sourceId,
      sourceText,
      text: correction || sourceText,
      corrected: Boolean(correction && correction !== sourceText),
    }];
  });
}

export function normalizeMemoryTitle(value, fallback) {
  const candidate = typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim() : "";
  const safeFallback = typeof fallback === "string" ? fallback.replace(/[\r\n\t]+/g, " ").trim() : "";
  return (candidate || safeFallback || "Suara memory").slice(0, MAX_MEMORY_TITLE_CHARS);
}

function quoteMarkdown(value) {
  return String(value).replace(/\r\n?/g, "\n").split("\n")
    .map((line) => {
      const literal = escapeMarkdownLiteral(line).replace(/^[ \t]+/, (indent) =>
        [...indent].map((character) => `&#${character.codePointAt(0)};`).join(""));
      return `> ${literal}`;
    }).join("\n");
}

function escapeMarkdownLiteral(value) {
  return [...String(value)].map((character) => {
    const code = character.codePointAt(0);
    const punctuation = (code >= 33 && code <= 47) || (code >= 58 && code <= 64)
      || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
    return punctuation ? `&#${code};` : character;
  }).join("");
}

export function buildReviewedMemoryMarkdown({ title, fallbackTitle, boundary, sourceLabel,
  correctedLabel, originalLabel, selections } = {}) {
  if (!Array.isArray(selections) || !selections.length
      || typeof boundary !== "string" || !boundary.trim()
      || typeof sourceLabel !== "string" || !sourceLabel.trim()
      || typeof correctedLabel !== "string" || !correctedLabel.trim()
      || typeof originalLabel !== "string" || !originalLabel.trim()) {
    throw new TypeError("Invalid memory document.");
  }
  const sections = selections.map((selection) => {
    if (!isRecord(selection) || typeof selection.sourceId !== "string"
        || !/^U\d{2,}$/.test(selection.sourceId)
        || !cleanSourceText(selection.text) || !cleanSourceText(selection.sourceText)) {
      throw new TypeError("Invalid reviewed source.");
    }
    const lines = [`## ${selection.sourceId}`, "", quoteMarkdown(selection.text), "",
      `_${escapeMarkdownLiteral(sourceLabel)}: ${selection.sourceId}_`];
    if (selection.corrected === true && cleanSourceText(selection.text) !== cleanSourceText(selection.sourceText)) {
      lines.push("", `_${escapeMarkdownLiteral(correctedLabel)}_`, "",
        `${escapeMarkdownLiteral(originalLabel)}:`, "", quoteMarkdown(selection.sourceText));
    }
    return lines.join("\n");
  });
  return `# ${escapeMarkdownLiteral(normalizeMemoryTitle(title, fallbackTitle))}\n\n_${escapeMarkdownLiteral(boundary.trim())}_\n\n${sections.join("\n\n")}\n`;
}
