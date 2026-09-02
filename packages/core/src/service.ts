import { generateOutcomeContract } from '../../domain/src/contract-generator.js';
import { assertTaskTransition } from '../../domain/src/state-machine.js';
import type { AcceptanceCriterion, OutcomeContract } from '../../domain/src/types.js';
import type { SqliteStore } from '../../db/src/sqlite-store.js';
import type { EvidenceService } from '../../evidence/src/evidence-service.js';
import type { VerificationEngine } from '../../verification/src/engine.js';
import type { SafeCommandRunner } from '../../../apps/runner/src/command-runner.js';
import type { RuntimeConfig } from '../../config/src/runtime.js';
import { canonicalJson, sha256 } from '../../shared/src/canonical.js';
import { MadeProofError } from '../../shared/src/errors.js';
import { newId } from '../../shared/src/ids.js';
import { hashPassword, hashToken, randomToken, verifyPassword } from '../../security/src/crypto.js';

export interface Actor {
  id: string;
  workspaceId: string;
  type: 'USER' | 'API_KEY' | 'MCP' | 'GITHUB' | 'SYSTEM';
  scopes: string[];
  email?: string;
}

export class MadeProofService {
  readonly owner: { userId: string; workspaceId: string };

  constructor(
    readonly store: SqliteStore,
    readonly evidenceService: EvidenceService,
    readonly engine: VerificationEngine,
    readonly commandRunner: SafeCommandRunner,
    readonly config: RuntimeConfig,
    readonly projectRoot: string,
  ) {
    store.migrate();
    this.owner = store.bootstrapOwner(config.adminEmail, hashPassword(config.adminPassword));
  }

  login(
    email: string,
    password: string,
  ): { token: string; csrfToken: string; expiresAt: string; user: any; workspace: any } {
    const user = this.store.getUserByEmail(email.toLowerCase());
    if (!user || !verifyPassword(password, user.password_hash))
      throw new MadeProofError('AUTH_INVALID', 'Email or password is incorrect', 401);
    const token = randomToken();
    const csrfToken = randomToken(24);
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    this.store.createSession(user.id, hashToken(token), csrfToken, expiresAt);
    const workspace = this.store.getDefaultWorkspaceForUser(user.id);
    return { token, csrfToken, expiresAt, user: { id: user.id, email: user.email }, workspace };
  }

  logout(token: string): void {
    this.store.revokeSession(hashToken(token));
  }

  authenticateSession(token: string): Actor {
    const session = this.store.getSession(hashToken(token));
    if (!session) throw new MadeProofError('AUTH_REQUIRED', 'Session is invalid or expired', 401);
    const workspace = this.store.getDefaultWorkspaceForUser(session.user_id);
    if (!workspace)
      throw new MadeProofError('WORKSPACE_REQUIRED', 'User has no accessible workspace', 403);
    return {
      id: session.user_id,
      workspaceId: workspace.id,
      type: 'USER',
      scopes: ['*'],
      email: session.email,
    };
  }

  authenticateApiKey(token: string, requiredScope?: string): Actor {
    const key = this.store.getApiKey(hashToken(token));
    if (!key)
      throw new MadeProofError('AUTH_REQUIRED', 'API key is invalid, expired or revoked', 401);
    if (requiredScope && !key.scopes.includes(requiredScope) && !key.scopes.includes('*')) {
      throw new MadeProofError(
        'INSUFFICIENT_SCOPE',
        `API key requires scope ${requiredScope}`,
        403,
      );
    }
    return { id: key.id, workspaceId: key.workspace_id, type: 'API_KEY', scopes: key.scopes };
  }

  createApiKey(
    actor: Actor,
    input: { name: string; scopes: string[]; expiresAt?: string },
  ): { secret: string; key: any } {
    this.requireUser(actor);
    const allowed = new Set([
      'tasks:read',
      'tasks:write',
      'evidence:write',
      'verification:run',
      'receipts:read',
      'projects:write',
      'projects:read',
    ]);
    const scopes = [...new Set(input.scopes)];
    if (!scopes.length || scopes.some((scope) => !allowed.has(scope)))
      throw new MadeProofError('VALIDATION_ERROR', 'One or more API key scopes are invalid', 422);
    const secret = `mp_${randomToken(32)}`;
    const prefix = secret.slice(0, 12);
    const key = this.store.createApiKey({
      workspaceId: actor.workspaceId,
      userId: actor.id,
      name: input.name,
      prefix,
      keyHash: hashToken(secret),
      scopes,
      expiresAt: input.expiresAt,
    });
    this.audit(actor, 'api_key.created', 'api_key', key.id, undefined, {
      name: input.name,
      scopes,
    });
    return {
      secret,
      key: {
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        scopes: key.scopes,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
      },
    };
  }

  listApiKeys(actor: Actor): any[] {
    this.requireUser(actor);
    return this.store.listApiKeys(actor.workspaceId);
  }

  revokeApiKey(actor: Actor, keyId: string): boolean {
    this.requireUser(actor);
    const revoked = this.store.revokeApiKey(actor.workspaceId, keyId);
    if (revoked) this.audit(actor, 'api_key.revoked', 'api_key', keyId);
    return revoked;
  }

  createProject(
    actor: Actor,
    input: { name: string; projectType?: string; repositoryUrl?: string },
  ): any {
    this.requireScope(actor, 'projects:write');
    const project = this.store.createProject({ workspaceId: actor.workspaceId, ...input });
    this.audit(actor, 'project.created', 'project', project.id, undefined, project);
    return project;
  }

  listProjects(actor: Actor, limit = 50, offset = 0): any[] {
    this.requireScope(actor, 'projects:read');
    return this.store.listProjects(actor.workspaceId, Math.min(limit, 100), Math.max(offset, 0));
  }

  getProject(actor: Actor, projectId: string): any {
    this.requireScope(actor, 'projects:read');
    return this.store.getProject(actor.workspaceId, projectId);
  }

  createTask(
    actor: Actor,
    input: { projectId: string; title: string; intent: string; template?: string },
  ): any {
    this.requireScope(actor, 'tasks:write');
    const task = this.store.createTask({
      workspaceId: actor.workspaceId,
      actorId: actor.id,
      ...input,
    });
    this.audit(actor, 'task.created', 'task', task.id, undefined, task);
    return task;
  }

  listTasks(
    actor: Actor,
    filters: { status?: string; projectId?: string; limit?: number; offset?: number } = {},
  ): any[] {
    this.requireScope(actor, 'tasks:read');
    return this.store.listTasks(actor.workspaceId, filters);
  }

  getTask(actor: Actor, taskId: string): any {
    this.requireScope(actor, 'tasks:read');
    return this.store.getTask(actor.workspaceId, taskId);
  }

  generateContract(actor: Actor, taskId: string): OutcomeContract {
    this.requireScope(actor, 'tasks:write');
    const task = this.store.getTask(actor.workspaceId, taskId);
    const version = Number(task.latest_contract_version) + 1;
    const contract = generateOutcomeContract({
      taskId,
      version,
      intent: task.intent,
      template: task.template ?? undefined,
    });
    const created = this.store.createContract(actor.workspaceId, contract);
    this.audit(actor, 'contract.created', 'contract', contract.id, undefined, created);
    return created;
  }

  updateContract(
    actor: Actor,
    taskId: string,
    input: Partial<OutcomeContract> & { acceptanceCriteria?: AcceptanceCriterion[] },
  ): OutcomeContract {
    this.requireScope(actor, 'tasks:write');
    const task = this.store.getTask(actor.workspaceId, taskId);
    const previous = this.store.getContract(actor.workspaceId, taskId);
    if (previous.lockedAt)
      throw new MadeProofError(
        'CONTRACT_LOCKED',
        'This contract version is attached to a run. Create a new task or retry the locked contract.',
        409,
      );
    const next: OutcomeContract = {
      ...previous,
      id: newId('contract'),
      version: Number(task.latest_contract_version) + 1,
      goal: input.goal ?? previous.goal,
      expectedOutcome: input.expectedOutcome ?? previous.expectedOutcome,
      scope: input.scope ?? previous.scope,
      constraints: input.constraints ?? previous.constraints,
      forbiddenActions: input.forbiddenActions ?? previous.forbiddenActions,
      requiredEvidence: input.requiredEvidence ?? previous.requiredEvidence,
      risk: input.risk ?? previous.risk,
      verificationStrategy: input.verificationStrategy ?? previous.verificationStrategy,
      acceptanceCriteria: input.acceptanceCriteria ?? previous.acceptanceCriteria,
      createdAt: new Date().toISOString(),
      lockedAt: null,
    };
    if (!next.acceptanceCriteria.length)
      throw new MadeProofError(
        'VALIDATION_ERROR',
        'Outcome contract requires at least one acceptance criterion',
        422,
      );
    const created = this.store.createContract(actor.workspaceId, next);
    this.audit(actor, 'contract.version_created', 'contract', next.id, previous, created);
    return created;
  }

  listContracts(actor: Actor, taskId: string): OutcomeContract[] {
    this.requireScope(actor, 'tasks:read');
    return this.store.listContracts(actor.workspaceId, taskId);
  }

  startRun(
    actor: Actor,
    taskId: string,
    input: { metadata?: Record<string, unknown>; artifactRef?: string; agentId?: string } = {},
  ): any {
    this.requireScope(actor, 'tasks:write');
    const task = this.store.getTask(actor.workspaceId, taskId);
    if (!['READY', 'FAILED', 'REVIEW_REQUIRED', 'VERIFIED'].includes(task.status))
      throw new MadeProofError(
        'TASK_NOT_RUNNABLE',
        `Task in ${task.status} cannot start a new run`,
        409,
      );
    assertTaskTransition(task.status, 'IN_PROGRESS');
    this.store.updateTaskStatus(actor.workspaceId, task.id, task.status, 'IN_PROGRESS');
    const run = this.store.startRun({
      workspaceId: actor.workspaceId,
      taskId,
      actorId: actor.id,
      ...input,
    });
    this.audit(actor, 'run.created', 'run', run.id, undefined, run);
    return run;
  }

  addEvidence(
    actor: Actor,
    runId: string,
    input: {
      criterionId?: string;
      type: string;
      value: unknown;
      source?: string;
      mimeType?: string;
    },
  ): any {
    this.requireScope(actor, 'evidence:write');
    const run = this.store.getRun(actor.workspaceId, runId);
    if (!['AWAITING_EVIDENCE', 'RUNNING'].includes(run.status))
      throw new MadeProofError(
        'RUN_NOT_ACCEPTING_EVIDENCE',
        `Run in ${run.status} is not accepting evidence`,
        409,
      );
    const item = this.evidenceService.createInline({
      workspaceId: actor.workspaceId,
      runId,
      criterionId: input.criterionId,
      type: input.type,
      value: input.value,
      source: input.source ?? actor.type.toLowerCase(),
      sourceActor: actor.id,
      provenance: actor.type === 'GITHUB' ? 'EXTERNAL_SIGNED' : 'SELF_REPORTED',
      mimeType: input.mimeType,
    });
    this.store.addEvidence(item);
    this.audit(actor, 'evidence.added', 'evidence', item.id, undefined, {
      runId,
      type: item.type,
      provenance: item.provenance,
      hash: item.contentHash,
    });
    return item;
  }

  async verify(actor: Actor, runId: string): Promise<any> {
    this.requireScope(actor, 'verification:run');
    const run = this.store.getRun(actor.workspaceId, runId);
    const contract = this.store.getContract(actor.workspaceId, run.task_id, run.contract_version);
    const evidence = this.store.listEvidence(actor.workspaceId, runId);
    return await this.engine.verify({
      workspaceId: actor.workspaceId,
      actorId: actor.id,
      run,
      contract,
      evidence,
      store: this.store,
      evidenceService: this.evidenceService,
      commandRunner: this.commandRunner,
      projectRoot: this.projectRoot,
      baseUrl: this.config.publicBaseUrl,
    });
  }

  retry(
    actor: Actor,
    runId: string,
    input: { metadata?: Record<string, unknown>; artifactRef?: string } = {},
  ): any {
    this.requireScope(actor, 'verification:run');
    const previous = this.store.getRun(actor.workspaceId, runId);
    return this.startRun(actor, previous.task_id, {
      metadata: { ...previous.metadata, ...input.metadata },
      artifactRef: input.artifactRef ?? previous.artifact_ref,
    });
  }

  getRun(actor: Actor, runId: string): any {
    this.requireScope(actor, 'tasks:read');
    return this.store.getRun(actor.workspaceId, runId);
  }

  getVerification(actor: Actor, runId: string): any {
    this.requireScope(actor, 'tasks:read');
    return {
      results: this.store.getResults(actor.workspaceId, runId),
      verdict: this.store.getVerdict(actor.workspaceId, runId),
    };
  }

  getVerdict(actor: Actor, runId: string): any {
    this.requireScope(actor, 'tasks:read');
    return this.store.getVerdict(actor.workspaceId, runId);
  }

  getFailedChecks(actor: Actor, runId: string): any[] {
    this.requireScope(actor, 'tasks:read');
    const results = this.store.getResults(actor.workspaceId, runId);
    const run = this.store.getRun(actor.workspaceId, runId);
    const contract = this.store.getContract(actor.workspaceId, run.task_id, run.contract_version);
    return results
      .filter((item) => ['FAILED', 'INCONCLUSIVE', 'ERROR'].includes(item.status))
      .map((item) => ({
        ...item,
        criterion: contract.acceptanceCriteria.find(
          (criterion) => criterion.id === item.criterionId,
        ),
      }));
  }

  getReceipt(actor: Actor, receiptId: string): any {
    this.requireScope(actor, 'receipts:read');
    return this.store.getReceipt(actor.workspaceId, receiptId);
  }

  getReceiptByRun(actor: Actor, runId: string): any {
    this.requireScope(actor, 'receipts:read');
    return this.store.getReceiptByRun(actor.workspaceId, runId);
  }

  dashboard(actor: Actor): any {
    this.requireScope(actor, 'tasks:read');
    return {
      counts: this.store.dashboardCounts(actor.workspaceId),
      attention: this.store.listAttention(actor.workspaceId),
      projects: this.store.listProjects(actor.workspaceId, 10, 0),
      tasks: this.store.listTasks(actor.workspaceId, { limit: 20 }),
    };
  }

  agentReliability(actor: Actor, agentId?: string): any {
    this.requireScope(actor, 'tasks:read');
    return {
      agentId: agentId ?? null,
      status: 'INSUFFICIENT_SAMPLE',
      minimumSample: 5,
      message:
        'MADEPROOF does not calculate reliability from fewer than five completed runs in the same domain.',
    };
  }

  idempotent<T>(
    actor: Actor,
    key: string | undefined,
    route: string,
    input: unknown,
    operation: () => { status: number; body: T },
  ): { status: number; body: T; replayed: boolean } {
    if (!key) {
      const value = operation();
      return { ...value, replayed: false };
    }
    if (key.length > 200)
      throw new MadeProofError('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key is too long', 422);
    const requestHash = sha256(canonicalJson(input));
    const existing = this.store.getIdempotency(actor.workspaceId, key, route);
    if (existing) {
      if (existing.request_hash !== requestHash)
        throw new MadeProofError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was already used with a different request body',
          409,
        );
      return { status: existing.response_status, body: existing.response as T, replayed: true };
    }
    const value = operation();
    this.store.saveIdempotency({
      workspaceId: actor.workspaceId,
      key,
      route,
      requestHash,
      responseStatus: value.status,
      response: value.body,
    });
    return { ...value, replayed: false };
  }

  private requireScope(actor: Actor, scope: string): void {
    if (actor.scopes.includes('*')) return;
    const readAlias = scope.endsWith(':read') && actor.scopes.includes('tasks:read');
    if (!actor.scopes.includes(scope) && !readAlias)
      throw new MadeProofError('INSUFFICIENT_SCOPE', `This operation requires scope ${scope}`, 403);
  }

  private requireUser(actor: Actor): void {
    if (actor.type !== 'USER')
      throw new MadeProofError(
        'USER_SESSION_REQUIRED',
        'This operation requires an interactive user session',
        403,
      );
  }

  private audit(
    actor: Actor,
    action: string,
    resourceType: string,
    resourceId: string,
    previous?: unknown,
    resulting?: unknown,
  ): void {
    this.store.appendAudit({
      workspaceId: actor.workspaceId,
      actorId: actor.id,
      actorType: actor.type,
      action,
      resourceType,
      resourceId,
      previous,
      resulting,
      metadata: {},
    });
  }
}
