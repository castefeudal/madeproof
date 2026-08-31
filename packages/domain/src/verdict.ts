import type { AcceptanceCriterion, VerificationResult, VerdictDecision } from './types.js';

export function calculateVerdict(
  criteria: AcceptanceCriterion[],
  results: VerificationResult[],
  options: { unresolvedPolicyViolation?: boolean; infrastructureError?: boolean } = {}
): VerdictDecision {
  const byCriterion = new Map(results.map((result) => [result.criterionId, result]));
  const blocking = criteria.filter((criterion) => criterion.required && criterion.severity === 'blocking');
  const failed: string[] = [];
  const review: string[] = [];
  const errors: string[] = [];
  const confidences: number[] = [];

  for (const criterion of blocking) {
    const result = byCriterion.get(criterion.id);
    if (!result) {
      review.push(criterion.id);
      continue;
    }
    confidences.push(result.confidence);
    if (result.status === 'FAILED') failed.push(criterion.id);
    else if (result.status === 'ERROR') errors.push(criterion.id);
    else if (result.status !== 'PASSED' || result.confidence < criterion.confidenceRequirement) review.push(criterion.id);
  }

  const confidence = confidences.length ? Math.min(...confidences) : 0;
  if (options.infrastructureError || errors.length) {
    return {
      verdict: 'ERROR',
      confidence,
      reason: 'Verification infrastructure failed for at least one blocking criterion.',
      failedCriterionIds: failed,
      reviewCriterionIds: review,
      errorCriterionIds: errors
    };
  }
  if (failed.length) {
    return {
      verdict: 'FAILED',
      confidence,
      reason: `${failed.length} blocking criterion${failed.length === 1 ? '' : 'a'} failed.`,
      failedCriterionIds: failed,
      reviewCriterionIds: review,
      errorCriterionIds: errors
    };
  }
  if (options.unresolvedPolicyViolation || review.length) {
    return {
      verdict: 'REVIEW_REQUIRED',
      confidence,
      reason: options.unresolvedPolicyViolation
        ? 'A policy gate remains unresolved.'
        : `${review.length} blocking criterion${review.length === 1 ? '' : 'a'} require review or stronger evidence.`,
      failedCriterionIds: failed,
      reviewCriterionIds: review,
      errorCriterionIds: errors
    };
  }
  return {
    verdict: 'VERIFIED',
    confidence,
    reason: 'Every required blocking criterion passed with sufficient evidence and confidence.',
    failedCriterionIds: [],
    reviewCriterionIds: [],
    errorCriterionIds: []
  };
}
