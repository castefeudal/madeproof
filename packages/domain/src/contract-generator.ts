import { newId, nowIso } from '../../shared/src/ids.js';
import type { AcceptanceCriterion, OutcomeContract } from './types.js';

function criterion(
  position: number,
  title: string,
  category: AcceptanceCriterion['category'],
  verificationType: AcceptanceCriterion['verificationType'],
  expected: Record<string, unknown>,
  evidenceRequirements: string[],
  confidenceRequirement = 1
): AcceptanceCriterion {
  return {
    id: newId('crit'),
    title,
    description: title,
    required: true,
    severity: 'blocking',
    category,
    verificationType,
    expected,
    evidenceRequirements,
    timeoutSeconds: verificationType === 'browser_interaction' ? 90 : 120,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    confidenceRequirement,
    position
  };
}

export function generateOutcomeContract(input: {
  taskId: string;
  version: number;
  intent: string;
  template?: string;
}): OutcomeContract {
  const isDemo = input.template === 'frontend-bug-fix-demo';
  const criteria = isDemo
    ? [
        criterion(1, 'Scenario B activates on pointer click', 'functional', 'browser_interaction', { mode: 'pointer', active: 'B' }, ['SCREENSHOT', 'TRACE']),
        criterion(2, 'Scenario B activates using keyboard', 'accessibility', 'browser_interaction', { mode: 'keyboard', active: 'B' }, ['SCREENSHOT', 'TRACE']),
        criterion(3, 'aria-pressed reflects the active scenario', 'accessibility', 'aria_snapshot', { target: 'scenario-b', value: 'true' }, ['ARIA_SNAPSHOT']),
        criterion(4, 'Existing test suite passes', 'test', 'test_suite', { command: 'node', args: ['--test', 'examples/demo-target/test.mjs'], network: 'disabled' }, ['TEST_REPORT']),
        criterion(5, 'Production build succeeds', 'build', 'build', { command: 'node', args: ['examples/demo-target/build.mjs'], network: 'disabled' }, ['COMMAND_OUTPUT']),
        criterion(6, 'No horizontal overflow at representative mobile widths', 'functional', 'browser_interaction', { mode: 'responsive', widths: [320, 375, 390, 430] }, ['SCREENSHOT']),
        criterion(7, 'No new critical accessibility defects are detected', 'accessibility', 'accessibility', { seriousOrCritical: 0 }, ['JSON'])
      ]
    : [
        criterion(1, 'Requested outcome is observable in the submitted artifact', 'functional', 'evidence_match', { type: 'JSON', field: 'outcomeSatisfied', equals: true }, ['JSON']),
        criterion(2, 'Relevant automated tests pass', 'test', 'evidence_match', { type: 'TEST_REPORT', status: 'passed' }, ['TEST_REPORT']),
        criterion(3, 'Production build succeeds', 'build', 'evidence_match', { type: 'COMMAND_OUTPUT', exitCode: 0 }, ['COMMAND_OUTPUT']),
        criterion(4, 'No forbidden action was reported or observed', 'policy', 'evidence_match', { type: 'JSON', field: 'forbiddenAction', equals: false }, ['JSON'])
      ];

  return {
    id: newId('contract'),
    taskId: input.taskId,
    version: input.version,
    goal: input.intent,
    expectedOutcome: isDemo
      ? 'Scenario B is fully operable with pointer and keyboard, with accurate accessibility state and no regression.'
      : `Independent evidence demonstrates that: ${input.intent}`,
    scope: ['Submitted artifact or commit', 'Declared acceptance criteria', 'Regression-sensitive behavior'],
    acceptanceCriteria: criteria,
    constraints: ['Preserve existing behavior outside the requested change', 'Do not weaken checks to obtain a pass'],
    forbiddenActions: ['Falsifying evidence', 'Changing a locked contract retroactively', 'Using agent self-report as final proof'],
    requiredEvidence: [...new Set(criteria.flatMap((item) => item.evidenceRequirements))],
    risk: { level: isDemo ? 'medium' : 'low', rationale: isDemo ? 'User interaction and accessibility can regress independently.' : 'Default deterministic template.' },
    verificationStrategy: criteria.map((item) => `${item.verificationType}:${item.id}`),
    createdAt: nowIso(),
    lockedAt: null
  };
}
