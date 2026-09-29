const RESOLVED_REVIEW_STATES = new Set(["approved", "excluded"]);

export function getReviewSummary(reviewStates, segmentIds) {
  const approvedIds = segmentIds.filter((id) => reviewStates[id] === "approved");
  const resolvedIds = segmentIds.filter((id) => RESOLVED_REVIEW_STATES.has(reviewStates[id]));

  return {
    approvedCount: approvedIds.length,
    approvedIds,
    allResolved: resolvedIds.length === segmentIds.length,
    resolvedCount: resolvedIds.length,
    segmentCount: segmentIds.length,
  };
}

export function getIntegrityMetrics({ contract, reviewStates, segmentIds, selectedEvidence }) {
  const review = getReviewSummary(reviewStates, segmentIds);
  const selectedIds = [...new Set(selectedEvidence)];
  const validSelectedIds = selectedIds.filter((id) => segmentIds.includes(id) && review.approvedIds.includes(id));
  const selectedCount = selectedIds.length;
  const validSelectedCount = validSelectedIds.length;
  const precision = selectedCount === 0 ? 0 : validSelectedCount / selectedCount;
  const recall = review.approvedCount === 0 ? 0 : validSelectedCount / review.approvedCount;
  const checks = [
    contract.syntheticOnly === true,
    contract.realDataUsed === false,
    contract.realModelUsed === false,
    contract.networkRequired === false,
    contract.persistence === "memory_only",
    contract.publishable === false && contract.releaseState === "blocked_phase0",
    review.allResolved,
    review.approvedCount > 0,
    selectedCount > 0 && validSelectedCount === selectedCount,
  ];

  return {
    ...review,
    checkCount: checks.length,
    passedCheckCount: checks.filter(Boolean).length,
    precision,
    recall,
    selectedCount,
    validSelectedCount,
  };
}
