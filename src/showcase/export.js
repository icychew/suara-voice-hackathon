import { getReviewSummary } from './integrity.js';
export function createSyntheticReviewExport({ lane, reviewStates, selectedEvidence, title }) {
  const summary = getReviewSummary(reviewStates, lane.segments.map(s => s.id));
  const selected = [...new Set(selectedEvidence)];
  if (!summary.allResolved || !selected.length || selected.some(id => !summary.approvedIds.includes(id))) throw new Error('Unreviewed evidence cannot be exported');
  const excerpts = lane.segments.filter(s => selected.includes(s.id));
  return [`# ${title}`, '', '> SYNTHETIC DEMO — REVIEW ONLY. Not a real family record or publication approval.', '',
    `Speech route: ${lane.route}`, 'Source: generated fictional narration; transcript supplied in advance, not live ASR.', '',
    ...excerpts.flatMap(s => [`## ${s.id} · ${s.time}`, '', `> ${s.text}`, '']),
    'Only selected, approved fixture excerpts are included. No translation or new facts have been added.', ''].join('\n');
}
