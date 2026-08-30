import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVerdict } from '../../packages/domain/src/verdict.js';
import type { AcceptanceCriterion, CheckStatus, VerificationResult } from '../../packages/domain/src/types.js';

function criterion(id: string, confidenceRequirement = 1): AcceptanceCriterion {
  return { id, title: id, description: id, required: true, severity: 'blocking', category: 'functional', verificationType: 'evidence_match', expected: {}, evidenceRequirements: [], timeoutSeconds: 10, retryPolicy: { maxAttempts: 1, backoffMs: 0 }, confidenceRequirement, position: 1 };
}
function result(id: string, status: CheckStatus, confidence = status === 'PASSED' ? 1 : 0): VerificationResult {
  return { id: `res-${id}`, checkId: `check-${id}`, criterionId: id, status, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:00.001Z', durationMs: 1, summary: status, details: {}, evidenceIds: [], confidence };
}

test('VERIFIED requires every blocking criterion to pass at required confidence', () => {
  const decision = calculateVerdict([criterion('a'), criterion('b', 0.9)], [result('a', 'PASSED'), result('b', 'PASSED', 0.95)]);
  assert.equal(decision.verdict, 'VERIFIED');
  assert.equal(decision.confidence, 0.95);
});

test('one objective failure produces FAILED even when other checks pass', () => {
  const decision = calculateVerdict([criterion('a'), criterion('b')], [result('a', 'PASSED'), result('b', 'FAILED')]);
  assert.equal(decision.verdict, 'FAILED');
  assert.deepEqual(decision.failedCriterionIds, ['b']);
});

test('infrastructure error has priority and prevents false VERIFIED', () => {
  const decision = calculateVerdict([criterion('a'), criterion('b')], [result('a', 'FAILED'), result('b', 'ERROR')]);
  assert.equal(decision.verdict, 'ERROR');
  assert.deepEqual(decision.errorCriterionIds, ['b']);
});

test('missing, skipped, inconclusive, or low-confidence blocking evidence requires review', () => {
  for (const candidate of [undefined, result('a', 'SKIPPED'), result('a', 'INCONCLUSIVE'), result('a', 'PASSED', 0.4)]) {
    const decision = calculateVerdict([criterion('a', 0.8)], candidate ? [candidate] : []);
    assert.equal(decision.verdict, 'REVIEW_REQUIRED');
  }
});

test('unresolved policy gate blocks VERIFIED', () => {
  const decision = calculateVerdict([criterion('a')], [result('a', 'PASSED')], { unresolvedPolicyViolation: true });
  assert.equal(decision.verdict, 'REVIEW_REQUIRED');
});
