// Final provider text is authoritative. Repeated finals update in place so
// evidence IDs do not move merely because a correction arrives late.
export function upsertTurn(turns, turn) {
  const text = typeof turn.text === "string" ? turn.text.trim() : "";
  const index = turns.findIndex((item) => item.key === turn.key);
  if (!text) return index < 0 ? turns : turns.filter((item) => item.key !== turn.key);
  const next = { ...turn, text };
  return index < 0 ? [...turns, next] : turns.map((item, i) => i === index ? next : item);
}

// Evidence labels are allocated once per provider turn key and are never
// recycled inside a session. A provider withdrawal therefore cannot silently
// rename the later sources that a reviewer may already have seen.
export function createEvidenceIdLedger(prefix = "U") {
  if (typeof prefix !== "string" || !/^[A-Z]$/.test(prefix)) {
    throw new TypeError("Invalid evidence prefix.");
  }
  const byKey = new Map();
  let nextIndex = 1;
  return {
    ensure(key) {
      if (typeof key !== "string" || !key) throw new TypeError("Invalid evidence key.");
      if (!byKey.has(key)) {
        byKey.set(key, `${prefix}${String(nextIndex).padStart(2, "0")}`);
        nextIndex += 1;
      }
      return byKey.get(key);
    },
    clear() {
      byKey.clear();
      nextIndex = 1;
    },
  };
}

// The provider may stream words or tokens. This is provisional display only;
// never use these fragments as evidence or put them into the memory preview.
export function appendSpokenToken(current, token) {
  if (!token) return current;
  if (!current || /\s$/.test(current) || /^[\s,.;:!?…'’。，；：！？、）】》]/u.test(token)
    || /[（【《]$/u.test(current)
    || /[\p{Script=Han}]$/u.test(current) || /^[\p{Script=Han}]/u.test(token)) {
    return `${current}${token}`;
  }
  return `${current} ${token}`;
}
