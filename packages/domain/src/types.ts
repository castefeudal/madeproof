export const TASK_STATUSES = [
  'DRAFT',
  'READY',
  'IN_PROGRESS',
  'AWAITING_EVIDENCE',
  'VERIFYING',
  'VERIFIED',
  'REVIEW_REQUIRED',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RUN_STATUSES = [
  'CREATED',
  'QUEUED',
  'RUNNING',
  'AWAITING_EVIDENCE',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const CHECK_STATUSES = [
  'PENDING',
  'RUNNING',
  'PASSED',
  'FAILED',
  'INCONCLUSIVE',
  'ERROR',
  'SKIPPED',
  'CANCELLED',
] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const FINAL_VERDICTS = ['VERIFIED', 'REVIEW_REQUIRED', 'FAILED', 'ERROR'] as const;
export type FinalVerdict = (typeof FINAL_VERDICTS)[number];

export type CriterionSeverity = 'blocking' | 'advisory';
export type CriterionCategory =
  | 'functional'
  | 'regression'
  | 'build'
  | 'test'
  | 'security'
  | 'accessibility'
  | 'performance'
  | 'visual'
  | 'deployment'
  | 'data'
  | 'content'
  | 'semantic'
  | 'policy';

export type VerificationType =
  | 'command'
  | 'build'
  | 'test_suite'
  | 'http'
  | 'file_exists'
  | 'file_changed'
  | 'forbidden_file_change'
  | 'git_diff'
  | 'git_commit'
  | 'github_pr'
  | 'github_actions'
  | 'schema'
  | 'json_path'
  | 'browser_interaction'
  | 'accessibility'
  | 'aria_snapshot'
  | 'visual_regression'
  | 'console_error'
  | 'network_error'
  | 'semantic'
  | 'manual'
  | 'composite'
  | 'evidence_match';

export interface AcceptanceCriterion {
  id: string;
  title: string;
  description: string;
  required: boolean;
  severity: CriterionSeverity;
  category: CriterionCategory;
  verificationType: VerificationType;
  expected: Record<string, unknown>;
  evidenceRequirements: string[];
  timeoutSeconds: number;
  retryPolicy: { maxAttempts: number; backoffMs: number };
  confidenceRequirement: number;
  position: number;
}

export interface OutcomeContract {
  id: string;
  taskId: string;
  version: number;
  goal: string;
  expectedOutcome: string;
  scope: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  constraints: string[];
  forbiddenActions: string[];
  requiredEvidence: string[];
  risk: { level: 'low' | 'medium' | 'high'; rationale: string };
  verificationStrategy: string[];
  createdAt: string;
  lockedAt: string | null;
}

export interface EvidenceItem {
  id: string;
  workspaceId: string;
  runId: string;
  criterionId: string | null;
  type: string;
  source: string;
  sourceActor: string;
  createdAt: string;
  observedAt: string;
  contentHash: string;
  mimeType: string;
  sizeBytes: number;
  storageLocation: string;
  provenance:
    'SELF_REPORTED' | 'IMPORTED' | 'EXTERNAL_SIGNED' | 'OBSERVED' | 'EXECUTED_BY_MADEPROOF';
  trustTier: number;
  sanitizationState: 'PENDING' | 'SAFE' | 'REJECTED';
  value?: unknown;
}

export interface VerificationResult {
  id: string;
  checkId: string;
  criterionId: string;
  status: CheckStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: string;
  details: Record<string, unknown>;
  evidenceIds: string[];
  confidence: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface VerdictDecision {
  verdict: FinalVerdict;
  confidence: number;
  reason: string;
  failedCriterionIds: string[];
  reviewCriterionIds: string[];
  errorCriterionIds: string[];
}
