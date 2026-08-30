import type { AcceptanceCriterion, EvidenceItem, OutcomeContract, VerificationResult } from '../../domain/src/types.js';
import type { SqliteStore } from '../../db/src/sqlite-store.js';
import type { EvidenceService } from '../../evidence/src/evidence-service.js';
import type { SafeCommandRunner } from '../../../apps/runner/src/command-runner.js';

export interface VerificationContext {
  workspaceId: string;
  actorId: string;
  run: any;
  contract: OutcomeContract;
  evidence: EvidenceItem[];
  store: SqliteStore;
  evidenceService: EvidenceService;
  commandRunner: SafeCommandRunner;
  projectRoot: string;
  baseUrl: string;
}

export interface VerificationCheck {
  type: string;
  execute(context: VerificationContext, criterion: AcceptanceCriterion, checkId: string): Promise<VerificationResult>;
}
