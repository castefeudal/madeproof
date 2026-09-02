import crypto from 'node:crypto';
import { calculateVerdict } from '../../domain/src/verdict.js';
import { assertRunTransition, assertTaskTransition } from '../../domain/src/state-machine.js';
import { canonicalJson, sha256 } from '../../shared/src/canonical.js';
import { MadeProofError } from '../../shared/src/errors.js';
import type { AcceptanceCriterion, VerificationResult } from '../../domain/src/types.js';
import type { VerificationCheck, VerificationContext } from './types.js';
import {
  AccessibilityCheck,
  AriaSnapshotCheck,
  BrowserInteractionCheck,
  CommandCheck,
  EvidenceMatchCheck,
  FileExistsCheck,
  HttpCheck,
  ManualReviewCheck,
  SemanticCheck,
} from './checks.js';

export class CheckRegistry {
  private readonly checks = new Map<string, VerificationCheck>();

  constructor() {
    this.register(new EvidenceMatchCheck());
    this.register(new CommandCheck('command'));
    this.register(new CommandCheck('build'));
    this.register(new CommandCheck('test_suite'));
    this.register(new BrowserInteractionCheck());
    this.register(new AriaSnapshotCheck());
    this.register(new AccessibilityCheck());
    this.register(new FileExistsCheck());
    this.register(new HttpCheck());
    this.register(new ManualReviewCheck());
    this.register(new SemanticCheck());
  }

  register(check: VerificationCheck): void {
    this.checks.set(check.type, check);
  }

  get(type: string): VerificationCheck {
    const check = this.checks.get(type);
    if (!check) return this.checks.get('manual')!;
    return check;
  }

  list(): string[] {
    return [...this.checks.keys()].sort();
  }
}

function taskStatusForVerdict(verdict: string): any {
  return verdict === 'VERIFIED' ? 'VERIFIED' : verdict === 'FAILED' ? 'FAILED' : 'REVIEW_REQUIRED';
}

export class VerificationEngine {
  constructor(private readonly registry = new CheckRegistry()) {}

  async verify(
    context: VerificationContext,
  ): Promise<{ decision: any; receipt: any; results: VerificationResult[] }> {
    if (context.run.status !== 'AWAITING_EVIDENCE' && context.run.status !== 'RUNNING') {
      throw new MadeProofError(
        'RUN_NOT_VERIFIABLE',
        `Run in ${context.run.status} cannot enter verification`,
        409,
      );
    }
    assertRunTransition(context.run.status, 'VERIFYING');
    context.store.updateRunStatus(
      context.workspaceId,
      context.run.id,
      context.run.status,
      'VERIFYING',
    );
    const task = context.store.getTask(context.workspaceId, context.run.task_id);
    if (task.status !== 'AWAITING_EVIDENCE' && task.status !== 'IN_PROGRESS') {
      throw new MadeProofError(
        'TASK_NOT_VERIFIABLE',
        `Task in ${task.status} cannot enter verification`,
        409,
      );
    }
    assertTaskTransition(task.status, 'VERIFYING');
    context.store.updateTaskStatus(context.workspaceId, task.id, task.status, 'VERIFYING');

    const results: VerificationResult[] = [];
    for (const criterion of [...context.contract.acceptanceCriteria].sort(
      (a, b) => a.position - b.position,
    )) {
      const checkRecord = context.store.upsertCheck({
        workspaceId: context.workspaceId,
        runId: context.run.id,
        criterionId: criterion.id,
        type: criterion.verificationType,
        config: criterion.expected,
      });
      context.store.setCheckStatus(context.workspaceId, checkRecord.id, 'RUNNING');
      let checkResult: VerificationResult;
      try {
        checkResult = await this.registry
          .get(criterion.verificationType)
          .execute(context, criterion, checkRecord.id);
      } catch (error) {
        checkResult = this.infrastructureError(checkRecord.id, criterion, error);
      }
      context.store.saveResult(context.workspaceId, context.run.id, checkResult);
      results.push(checkResult);
    }

    const decision = calculateVerdict(context.contract.acceptanceCriteria, results);
    const verdict = context.store.saveVerdict(context.workspaceId, context.run.id, decision);
    context.store.updateRunStatus(
      context.workspaceId,
      context.run.id,
      'VERIFYING',
      decision.verdict === 'ERROR' ? 'FAILED' : 'COMPLETED',
    );
    const currentTask = context.store.getTask(context.workspaceId, task.id);
    const nextTaskStatus = taskStatusForVerdict(decision.verdict);
    assertTaskTransition(currentTask.status, nextTaskStatus);
    context.store.updateTaskStatus(
      context.workspaceId,
      task.id,
      currentTask.status,
      nextTaskStatus,
    );

    const evidence = context.store.listEvidence(context.workspaceId, context.run.id);
    const receiptBody: Record<string, unknown> = {
      schemaVersion: 1,
      product: 'MADEPROOF',
      task: { id: task.id, title: task.title, projectId: task.project_id },
      contract: {
        id: context.contract.id,
        version: context.contract.version,
        digest: sha256(canonicalJson(context.contract)),
      },
      run: {
        id: context.run.id,
        attempt: context.run.attempt,
        artifactRef: context.run.artifact_ref,
        metadata: context.run.metadata,
      },
      timestamps: { runCreatedAt: context.run.created_at, verifiedAt: new Date().toISOString() },
      criteria: context.contract.acceptanceCriteria.map((criterion) => {
        const checkResult = results.find((item) => item.criterionId === criterion.id);
        return {
          id: criterion.id,
          title: criterion.title,
          required: criterion.required,
          severity: criterion.severity,
          result: checkResult?.status,
          confidence: checkResult?.confidence,
          evidenceIds: checkResult?.evidenceIds ?? [],
        };
      }),
      evidenceDigest: sha256(
        canonicalJson(
          evidence.map((item) => ({
            id: item.id,
            type: item.type,
            hash: item.contentHash,
            provenance: item.provenance,
            trustTier: item.trustTier,
          })),
        ),
      ),
      verdict: decision,
      machineVerdict: verdict.machine_verdict,
      humanVerdict: verdict.human_verdict ?? null,
      verifier: { engine: 'madeproof-core', version: '0.1.0', checkTypes: this.registry.list() },
      cost: { currency: 'USD', amount: 0, semanticProviderCalls: 0 },
    };
    const canonical = canonicalJson(receiptBody);
    const digest = sha256(canonical);
    let signature: string | undefined;
    let signingKeyId: string | undefined;
    if (process.env.RECEIPT_SIGNING_PRIVATE_KEY) {
      signature = crypto
        .sign(null, Buffer.from(canonical), process.env.RECEIPT_SIGNING_PRIVATE_KEY)
        .toString('base64url');
      signingKeyId = process.env.RECEIPT_SIGNING_KEY_ID || 'default';
    }
    const receipt = context.store.saveReceipt({
      workspaceId: context.workspaceId,
      runId: context.run.id,
      receipt: receiptBody,
      digest,
      signature,
      signingKeyId,
    });
    context.store.appendAudit({
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      actorType: 'SYSTEM',
      action: 'verification.completed',
      resourceType: 'run',
      resourceId: context.run.id,
      resulting: { decision, receiptDigest: digest },
    });
    return { decision, receipt, results };
  }

  private infrastructureError(
    checkId: string,
    criterion: AcceptanceCriterion,
    error: unknown,
  ): VerificationResult {
    const now = new Date().toISOString();
    return {
      id: `res_${crypto.randomUUID().replaceAll('-', '')}`,
      checkId,
      criterionId: criterion.id,
      status: 'ERROR',
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      summary: 'Verifier infrastructure failed unexpectedly.',
      details: {},
      evidenceIds: [],
      confidence: 0,
      errorCode: 'VERIFIER_INFRASTRUCTURE_ERROR',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
