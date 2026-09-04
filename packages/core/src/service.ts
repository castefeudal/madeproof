import { generateOutcomeContract } from '../../domain/src/contract-generator.js';
import { assertTaskTransition } from '../../domain/src/state-machine.js';
import type { AcceptanceCriterion, OutcomeContract } from '../../domain/src/types.js';
import type { MadeProofStore } from '../../db/src/store.js';
import type { EvidenceService } from '../../evidence/src/evidence-service.js';
import type { RuntimeConfig } from '../../config/src/runtime.js';
import { canonicalJson, sha256 } from '../../shared/src/canonical.js';
import { MadeProofError } from '../../shared/src/errors.js';
import { newId } from '../../shared/src/ids.js';
import { hashPassword, hashToken, randomToken, verifyPassword } from '../../security/src/crypto.js';

export interface Actor {
  id: string;
  workspaceId: string;
  type: 'USER' | 'API_KEY' | 'MCP' | 'GITHUB' | 'RUNNER' | 'SYSTEM';
  scopes: string[];
  email?: string;
}

export interface RunnerActor extends Actor {
  runnerId: string;
  capabilities: string[];
  version: string;
}

export const RUNNER_CAPABILITIES = [
  'command',
  'build',
  'test_suite',
  'browser',
  'accessibility',
  'file',
  'http',
] as const;

export function isCompatibleRunnerVersion(version: string): boolean {
  return /^0\.1\.\d+$/.test(version);
}

export class MadeProofService {
  owner: { userId: string; workspaceId: string };

  constructor(
    readonly store: MadeProofStore,
    readonly evidenceService: EvidenceService,
    readonly config: RuntimeConfig,
    readonly projectRoot: string,
  ) {
    this.owner = { userId: '', workspaceId: '' };
  }

  /** Runs migrations and creates/loads the owner account. Async because PostgreSQL migrations are asynchronous. */
  async initialize(): Promise<void> {
    await this.store.migrate();
    this.owner = await this.store.bootstrapOwner(
      this.config.adminEmail,
      hashPassword(this.config.adminPassword),
    );
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ token: string; csrfToken: string; expiresAt: string; user: any; workspace: any }> {
    const user = await this.store.getUserByEmail(email.toLowerCase());
    if (!user || !verifyPassword(password, user.password_hash))
      throw new MadeProofError('AUTH_INVALID', 'Email or password is incorrect', 401);
    const token = randomToken();
    const csrfToken = randomToken(24);
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    await this.store.createSession(user.id, hashToken(token), csrfToken, expiresAt);
    const workspace = await this.store.getDefaultWorkspaceForUser(user.id);
    return { token, csrfToken, expiresAt, user: { id: user.id, email: user.email }, workspace };
  }

  async logout(token: string): Promise<void> {
    await this.store.revokeSession(hashToken(token));
  }

  async authenticateSession(token: string): Promise<Actor> {
    const session = await this.store.getSession(hashToken(token));
    if (!session) throw new MadeProofError('AUTH_REQUIRED', 'Session is invalid or expired', 401);
    const workspace = await this.store.getDefaultWorkspaceForUser(session.user_id);
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

  async authenticateApiKey(token: string, requiredScope?: string): Promise<Actor> {
    const key = await this.store.getApiKey(hashToken(token));
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

  async createApiKey(
    actor: Actor,
    input: { name: string; scopes: string[]; expiresAt?: string },
  ): Promise<{ secret: string; key: any }> {
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
    const key = await this.store.createApiKey({
      workspaceId: actor.workspaceId,
      userId: actor.id,
      name: input.name,
      prefix,
      keyHash: hashToken(secret),
      scopes,
      expiresAt: input.expiresAt,
    });
    await this.audit(actor, 'api_key.created', 'api_key', key.id, undefined, {
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

  async listApiKeys(actor: Actor): Promise<any[]> {
    this.requireUser(actor);
    return this.store.listApiKeys(actor.workspaceId);
  }

  async revokeApiKey(actor: Actor, keyId: string): Promise<boolean> {
    this.requireUser(actor);
    const revoked = await this.store.revokeApiKey(actor.workspaceId, keyId);
    if (revoked) await this.audit(actor, 'api_key.revoked', 'api_key', keyId);
    return revoked;
  }

  // ---------------------------------------------------------------- runners

  async createRunner(
    actor: Actor,
    input: { name: string; version: string; capabilities: string[] },
  ): Promise<{ runner: any; secret: string }> {
    this.requireUser(actor);
    if (!input.name || input.name.length > 100)
      throw new MadeProofError('VALIDATION_ERROR', 'Runner name must be 1-100 characters', 422);
    if (!isCompatibleRunnerVersion(input.version))
      throw new MadeProofError(
        'RUNNER_VERSION_INCOMPATIBLE',
        'Runner protocol version must match 0.1.x',
        400,
      );
    const capabilities = [...new Set(input.capabilities)];
    if (
      !capabilities.length ||
      capabilities.some(
        (capability) => !(RUNNER_CAPABILITIES as readonly string[]).includes(capability),
      )
    )
      throw new MadeProofError(
        'VALIDATION_ERROR',
        `Runner capabilities must be a non-empty subset of: ${RUNNER_CAPABILITIES.join(', ')}`,
        422,
      );
    const secret = `mpr_${randomToken(32)}`;
    const runner = await this.store.registerRunner({
      workspaceId: actor.workspaceId,
      name: input.name,
      credentialHash: hashToken(secret),
      version: input.version,
      capabilities,
    });
    await this.audit(actor, 'runner.registered', 'runner', runner.id, undefined, {
      name: input.name,
      capabilities,
    });
    return {
      runner: this.publicRunner(runner),
      secret,
    };
  }

  async listRunners(actor: Actor): Promise<any[]> {
    this.requireUser(actor);
    const runners = await this.store.listRunners(actor.workspaceId);
    return runners.map((runner: any) => this.publicRunner(runner));
  }

  private publicRunner(runner: any): any {
    return {
      id: runner.id,
      workspaceId: runner.workspace_id,
      name: runner.name,
      version: runner.version,
      capabilities: runner.capabilities,
      lastHeartbeatAt: runner.last_heartbeat_at ?? null,
      revokedAt: runner.revoked_at ?? null,
      createdAt: runner.created_at,
    };
  }

  async authenticateRunner(secret: string): Promise<RunnerActor> {
    const runner = await this.store.getRunnerByCredentialHash(hashToken(secret));
    if (!runner)
      throw new MadeProofError(
        'RUNNER_AUTH_REQUIRED',
        'Runner credential is invalid, expired or revoked',
        401,
      );
    if (!isCompatibleRunnerVersion(runner.version))
      throw new MadeProofError(
        'RUNNER_VERSION_INCOMPATIBLE',
        'Runner protocol version must match 0.1.x',
        400,
      );
    return {
      id: runner.id,
      workspaceId: runner.workspace_id,
      type: 'RUNNER',
      scopes: ['runner'],
      runnerId: runner.id,
      capabilities: runner.capabilities,
      version: runner.version,
    };
  }

  async runnerHeartbeat(
    runner: RunnerActor,
    version: string,
    capabilities: string[],
  ): Promise<void> {
    if (!isCompatibleRunnerVersion(version))
      throw new MadeProofError(
        'RUNNER_VERSION_INCOMPATIBLE',
        'Runner protocol version must match 0.1.x',
        400,
      );
    const registered = new Set(runner.capabilities);
    for (const capability of capabilities)
      if (!registered.has(capability))
        throw new MadeProofError(
          'RUNNER_CAPABILITY_MISMATCH',
          `Runner was not registered with capability ${capability}`,
          403,
        );
    await this.store.heartbeatRunner(runner.workspaceId, runner.runnerId, version, capabilities);
  }

  async revokeRunner(actor: Actor, runnerId: string): Promise<boolean> {
    this.requireUser(actor);
    const revoked = await this.store.revokeRunner(actor.workspaceId, runnerId);
    if (revoked) await this.audit(actor, 'runner.revoked', 'runner', runnerId);
    return revoked;
  }

  // ------------------------------------------------------- projects & tasks

  async createProject(
    actor: Actor,
    input: { name: string; projectType?: string; repositoryUrl?: string },
  ): Promise<any> {
    this.requireScope(actor, 'projects:write');
    const project = await this.store.createProject({ workspaceId: actor.workspaceId, ...input });
    await this.audit(actor, 'project.created', 'project', project.id, undefined, project);
    return project;
  }

  async listProjects(actor: Actor, limit = 50, offset = 0): Promise<any[]> {
    this.requireScope(actor, 'projects:read');
    return this.store.listProjects(actor.workspaceId, Math.min(limit, 100), Math.max(offset, 0));
  }

  async getProject(actor: Actor, projectId: string): Promise<any> {
    this.requireScope(actor, 'projects:read');
    return this.store.getProject(actor.workspaceId, projectId);
  }

  async createTask(
    actor: Actor,
    input: { projectId: string; title: string; intent: string; template?: string },
  ): Promise<any> {
    this.requireScope(actor, 'tasks:write');
    const task = await this.store.createTask({
      workspaceId: actor.workspaceId,
      actorId: actor.id,
      ...input,
    });
    await this.audit(actor, 'task.created', 'task', task.id, undefined, task);
    return task;
  }

  async listTasks(
    actor: Actor,
    filters: { status?: string; projectId?: string; limit?: number; offset?: number } = {},
  ): Promise<any[]> {
    this.requireScope(actor, 'tasks:read');
    return this.store.listTasks(actor.workspaceId, filters);
  }

  async getTask(actor: Actor, taskId: string): Promise<any> {
    this.requireScope(actor, 'tasks:read');
    return this.store.getTask(actor.workspaceId, taskId);
  }

  async generateContract(actor: Actor, taskId: string): Promise<OutcomeContract> {
    this.requireScope(actor, 'tasks:write');
    const task = await this.store.getTask(actor.workspaceId, taskId);
    const version = Number(task.latest_contract_version) + 1;
    const contract = generateOutcomeContract({
      taskId,
      version,
      intent: task.intent,
      template: task.template ?? undefined,
    });
    const created = await this.store.createContract(actor.workspaceId, contract);
    await this.audit(actor, 'contract.created', 'contract', contract.id, undefined, created);
    return created;
  }

  async updateContract(
    actor: Actor,
    taskId: string,
    input: Partial<OutcomeContract> & { acceptanceCriteria?: AcceptanceCriterion[] },
  ): Promise<OutcomeContract> {
    this.requireScope(actor, 'tasks:write');
    const task = await this.store.getTask(actor.workspaceId, taskId);
    const previous = await this.store.getContract(actor.workspaceId, taskId);
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
    const created = await this.store.createContract(actor.workspaceId, next);
    await this.audit(actor, 'contract.version_created', 'contract', next.id, previous, created);
    return created;
  }

  async listContracts(actor: Actor, taskId: string): Promise<OutcomeContract[]> {
    this.requireScope(actor, 'tasks:read');
    return this.store.listContracts(actor.workspaceId, taskId);
  }

  // ------------------------------------------------------------------- runs

  async startRun(
    actor: Actor,
    taskId: string,
    input: { metadata?: Record<string, unknown>; artifactRef?: string; agentId?: string } = {},
  ): Promise<any> {
    this.requireScope(actor, 'tasks:write');
    const task = await this.store.getTask(actor.workspaceId, taskId);
    if (!['READY', 'FAILED', 'REVIEW_REQUIRED', 'VERIFIED'].includes(task.status))
      throw new MadeProofError(
        'TASK_NOT_RUNNABLE',
        `Task in ${task.status} cannot start a new run`,
        409,
      );
    assertTaskTransition(task.status, 'IN_PROGRESS');
    await this.store.updateTaskStatus(actor.workspaceId, task.id, task.status, 'IN_PROGRESS');
    const run = await this.store.startRun({
      workspaceId: actor.workspaceId,
      taskId,
      actorId: actor.id,
      ...input,
    });
    await this.audit(actor, 'run.created', 'run', run.id, undefined, run);
    return run;
  }

  async listRuns(actor: Actor, taskId: string): Promise<any[]> {
    this.requireScope(actor, 'tasks:read');
    return this.store.listRuns(actor.workspaceId, taskId);
  }

  async getRun(actor: Actor, runId: string): Promise<any> {
    this.requireScope(actor, 'tasks:read');
    return this.store.getRun(actor.workspaceId, runId);
  }

  /**
   * Record agent-reported evidence. It is stored with SELF_REPORTED provenance
   * and is never treated as independent proof by the verification engine.
   */
  async addEvidence(
    actor: Actor,
    runId: string,
    input: {
      criterionId?: string;
      type: string;
      value: unknown;
      source?: string;
      mimeType?: string;
    },
  ): Promise<any> {
    this.requireScope(actor, 'evidence:write');
    const run = await this.store.getRun(actor.workspaceId, runId);
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
    await this.store.addEvidence(item);
    await this.audit(actor, 'evidence.added', 'evidence', item.id, undefined, {
      runId,
      type: item.type,
      provenance: item.provenance,
      hash: item.contentHash,
    });
    return item;
  }

  /**
   * Queue independent verification for a run. The control plane never executes checks:
   * a durable verification job is created and a worker performs it, delegating
   * executable checks to an isolated runner. Returns the queued job.
   */
  async verify(actor: Actor, runId: string): Promise<any> {
    this.requireScope(actor, 'verification:run');
    const run = await this.store.getRun(actor.workspaceId, runId);
    if (!['AWAITING_EVIDENCE', 'RUNNING'].includes(run.status))
      throw new MadeProofError(
        'RUN_NOT_VERIFIABLE',
        `Run in ${run.status} cannot enter verification; create a retry run instead.`,
        409,
      );
    const job = await this.store.enqueueVerificationJob({
      workspaceId: actor.workspaceId,
      runId,
      actorId: actor.id,
    });
    await this.audit(actor, 'verification.queued', 'run', runId, undefined, { jobId: job.id });
    return job;
  }

  async cancelVerification(actor: Actor, runId: string): Promise<boolean> {
    this.requireScope(actor, 'verification:run');
    const cancelled = await this.store.cancelVerificationJob(actor.workspaceId, runId);
    if (!cancelled) return false;
    const run = await this.store.getRun(actor.workspaceId, runId);
    if (!['CREATED', 'QUEUED', 'RUNNING', 'AWAITING_EVIDENCE', 'VERIFYING'].includes(run.status))
      return true;
    const task = await this.store.getTask(actor.workspaceId, run.task_id);
    assertTaskTransition(task.status, 'CANCELLED');
    await this.store.updateRunStatus(actor.workspaceId, runId, run.status, 'CANCELLED');
    await this.store.updateTaskStatus(actor.workspaceId, task.id, task.status, 'CANCELLED');
    await this.audit(actor, 'verification.cancelled', 'run', runId, undefined, {
      jobId: (await this.store.getVerificationJob(actor.workspaceId, runId))?.id,
    });
    return true;
  }

  async getVerification(actor: Actor, runId: string): Promise<any> {
    this.requireScope(actor, 'tasks:read');
    return {
      job: await this.store.getVerificationJob(actor.workspaceId, runId),
      results: await this.store.getResults(actor.workspaceId, runId),
      verdict: await this.store.getVerdict(actor.workspaceId, runId),
    };
  }

  async getVerdict(actor: Actor, runId: string): Promise<any> {
    this.requireScope(actor, 'tasks:read');
    return this.store.getVerdict(actor.workspaceId, runId);
  }

  async getFailedChecks(actor: Actor, runId: string): Promise<any[]> {
    this.requireScope(actor, 'tasks:read');
    const results = await this.store.getResults(actor.workspaceId, runId);
    const run = await this.store.getRun(actor.workspaceId, runId);
    const contract = await this.store.getContract(
      actor.workspaceId,
      run.task_id,
      run.contract_version,
    );
    return results
      .filter((item: any) => ['FAILED', 'INCONCLUSIVE', 'ERROR'].includes(item.status))
      .map((item: any) => ({
        ...item,
        criterion: contract.acceptanceCriteria.find(
          (criterion) => criterion.id === item.criterionId,
        ),
      }));
  }

  async retry(
    actor: Actor,
    runId: string,
    input: { metadata?: Record<string, unknown>; artifactRef?: string } = {},
  ): Promise<any> {
    this.requireScope(actor, 'verification:run');
    const previous = await this.store.getRun(actor.workspaceId, runId);
    return this.startRun(actor, previous.task_id, {
      metadata: { ...previous.metadata, ...input.metadata },
      artifactRef: input.artifactRef ?? previous.artifact_ref,
    });
  }

  async getReceipt(actor: Actor, receiptId: string): Promise<any> {
    this.requireScope(actor, 'receipts:read');
    return this.store.getReceipt(actor.workspaceId, receiptId);
  }

  async getReceiptByRun(actor: Actor, runId: string): Promise<any> {
    this.requireScope(actor, 'receipts:read');
    return this.store.getReceiptByRun(actor.workspaceId, runId);
  }

  async dashboard(actor: Actor): Promise<any> {
    this.requireScope(actor, 'tasks:read');
    return {
      counts: await this.store.dashboardCounts(actor.workspaceId),
      attention: await this.store.listAttention(actor.workspaceId),
      projects: await this.store.listProjects(actor.workspaceId, 10, 0),
      tasks: await this.store.listTasks(actor.workspaceId, { limit: 20 }),
    };
  }

  async agentReliability(actor: Actor, agentId?: string): Promise<any> {
    this.requireScope(actor, 'tasks:read');
    return {
      agentId: agentId ?? null,
      status: 'INSUFFICIENT_SAMPLE',
      minimumSample: 5,
      message:
        'MADEPROOF does not calculate reliability from fewer than five completed runs in the same domain.',
    };
  }

  async idempotent<T>(
    actor: Actor,
    key: string | undefined,
    route: string,
    input: unknown,
    operation: () => { status: number; body: T } | Promise<{ status: number; body: T }>,
  ): Promise<{ status: number; body: T; replayed: boolean }> {
    if (!key) {
      const value = await operation();
      return { ...value, replayed: false };
    }
    if (key.length > 200)
      throw new MadeProofError('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key is too long', 422);
    const requestHash = sha256(canonicalJson(input));
    const existing = await this.store.getIdempotency(actor.workspaceId, key, route);
    if (existing) {
      if (existing.request_hash !== requestHash)
        throw new MadeProofError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was already used with a different request body',
          409,
        );
      return { status: existing.response_status, body: existing.response as T, replayed: true };
    }
    const value = await operation();
    await this.store.saveIdempotency({
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

  private async audit(
    actor: Actor,
    action: string,
    resourceType: string,
    resourceId: string,
    previous?: unknown,
    resulting?: unknown,
  ): Promise<void> {
    await this.store.appendAudit({
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
