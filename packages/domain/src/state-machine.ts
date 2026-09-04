import { MadeProofError } from '../../shared/src/errors.js';
import type { RunStatus, TaskStatus } from './types.js';

const taskTransitions: Record<TaskStatus, TaskStatus[]> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['AWAITING_EVIDENCE', 'VERIFYING', 'CANCELLED'],
  AWAITING_EVIDENCE: ['VERIFYING', 'CANCELLED'],
  VERIFYING: ['VERIFIED', 'REVIEW_REQUIRED', 'FAILED', 'CANCELLED'],
  VERIFIED: ['IN_PROGRESS'],
  REVIEW_REQUIRED: ['IN_PROGRESS', 'CANCELLED'],
  FAILED: ['IN_PROGRESS', 'CANCELLED'],
  CANCELLED: [],
};

const runTransitions: Record<RunStatus, RunStatus[]> = {
  CREATED: ['QUEUED', 'RUNNING', 'AWAITING_EVIDENCE', 'CANCELLED'],
  QUEUED: ['RUNNING', 'CANCELLED', 'TIMED_OUT'],
  RUNNING: ['AWAITING_EVIDENCE', 'VERIFYING', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  AWAITING_EVIDENCE: ['VERIFYING', 'CANCELLED', 'TIMED_OUT'],
  VERIFYING: ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
};

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!taskTransitions[from].includes(to)) {
    throw new MadeProofError(
      'INVALID_TASK_TRANSITION',
      `Task cannot transition from ${from} to ${to}`,
      409,
      { from, to },
    );
  }
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!runTransitions[from].includes(to)) {
    throw new MadeProofError(
      'INVALID_RUN_TRANSITION',
      `Run cannot transition from ${from} to ${to}`,
      409,
      { from, to },
    );
  }
}
