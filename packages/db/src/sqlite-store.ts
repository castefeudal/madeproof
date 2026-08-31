import sqlite from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { newId, nowIso } from '../../shared/src/ids.js';
import { MadeProofError } from '../../shared/src/errors.js';
import { canonicalJson, sha256 } from '../../shared/src/canonical.js';
import type { EvidenceItem, OutcomeContract, RunStatus, TaskStatus, VerificationResult, VerdictDecision } from '../../domain/src/types.js';
import { assertTaskTransition } from '../../domain/src/state-machine.js';

const { DatabaseSync } = sqlite as any;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  return JSON.parse(value) as T;
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'project';
}

export class SqliteStore {
  readonly db: any;
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.dataDir, 'madeproof.db'));
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }

  migrate(): void {
    const migration = fs.readFileSync(path.resolve('packages/db/migrations/sqlite/0001_init.sql'), 'utf8');
    this.db.exec(migration);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  bootstrapOwner(email: string, passwordHash: string): { userId: string; workspaceId: string } {
    const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(email) as any;
    if (existing) {
      const membership = this.db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY created_at LIMIT 1').get(existing.id) as any;
      if (!membership) throw new MadeProofError('BOOTSTRAP_CORRUPT', 'Owner exists without a workspace membership', 500);
      return { userId: existing.id, workspaceId: membership.workspace_id };
    }
    return this.transaction(() => {
      const userId = newId('usr');
      const workspaceId = newId('wsp');
      const now = nowIso();
      this.db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(userId, email, passwordHash, now);
      this.db.prepare('INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)').run(workspaceId, 'MADEPROOF Workspace', now);
      this.db.prepare('INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)').run(workspaceId, userId, 'OWNER', now);
      return { userId, workspaceId };
    });
  }

  getUserByEmail(email: string): any | null {
    return (this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any) ?? null;
  }

  getUserById(id: string): any | null {
    return (this.db.prepare('SELECT id,email,created_at FROM users WHERE id = ?').get(id) as any) ?? null;
  }

  getDefaultWorkspaceForUser(userId: string): any | null {
    return (this.db.prepare(`SELECT w.*, wm.role FROM workspaces w JOIN workspace_members wm ON wm.workspace_id=w.id WHERE wm.user_id=? ORDER BY w.created_at LIMIT 1`).get(userId) as any) ?? null;
  }

  hasWorkspaceAccess(userId: string, workspaceId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM workspace_members WHERE user_id=? AND workspace_id=?').get(userId, workspaceId));
  }

  createSession(userId: string, tokenHash: string, csrfToken: string, expiresAt: string): any {
    const row = { id: newId('ses'), userId, tokenHash, csrfToken, expiresAt, createdAt: nowIso() };
    this.db.prepare('INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?,?)')
      .run(row.id, row.userId, row.tokenHash, row.csrfToken, row.expiresAt, row.createdAt);
    return row;
  }

  getSession(tokenHash: string): any | null {
    return (this.db.prepare(`SELECT s.*, u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at > ?`).get(tokenHash, nowIso()) as any) ?? null;
  }

  revokeSession(tokenHash: string): void {
    this.db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').run(nowIso(), tokenHash);
  }

  createApiKey(input: { workspaceId: string; userId: string; name: string; prefix: string; keyHash: string; scopes: string[]; expiresAt?: string }): any {
    const row = { id: newId('key'), createdAt: nowIso(), ...input };
    this.db.prepare(`INSERT INTO api_keys(id,workspace_id,created_by,name,prefix,key_hash,scopes_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.workspaceId, row.userId, row.name, row.prefix, row.keyHash, JSON.stringify(row.scopes), row.expiresAt ?? null, row.createdAt);
    return row;
  }

  getApiKey(keyHash: string): any | null {
    const row = this.db.prepare(`SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
      .get(keyHash, nowIso()) as any;
    if (!row) return null;
    this.db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(nowIso(), row.id);
    return { ...row, scopes: parseJson<string[]>(row.scopes_json, []) };
  }

  listApiKeys(workspaceId: string): any[] {
    return (this.db.prepare('SELECT id,name,prefix,scopes_json,expires_at,revoked_at,last_used_at,created_at FROM api_keys WHERE workspace_id=? ORDER BY created_at DESC').all(workspaceId) as any[])
      .map((row) => ({ ...row, scopes: parseJson<string[]>(row.scopes_json, []) }));
  }

  revokeApiKey(workspaceId: string, keyId: string): boolean {
    const result = this.db.prepare('UPDATE api_keys SET revoked_at=? WHERE id=? AND workspace_id=? AND revoked_at IS NULL').run(nowIso(), keyId, workspaceId);
    return result.changes === 1;
  }

  createProject(input: { workspaceId: string; name: string; projectType?: string; repositoryUrl?: string }): any {
    const id = newId('prj');
    const now = nowIso();
    const base = slugify(input.name);
    let slug = base;
    let suffix = 1;
    while (this.db.prepare('SELECT 1 FROM projects WHERE workspace_id=? AND slug=?').get(input.workspaceId, slug)) {
      suffix += 1;
      slug = `${base}-${suffix}`;
    }
    this.db.prepare(`INSERT INTO projects(id,workspace_id,name,slug,project_type,repository_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, input.workspaceId, input.name, slug, input.projectType ?? 'software', input.repositoryUrl ?? null, now, now);
    return this.getProject(input.workspaceId, id);
  }

  listProjects(workspaceId: string, limit = 50, offset = 0): any[] {
    return this.db.prepare('SELECT * FROM projects WHERE workspace_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(workspaceId, limit, offset) as any[];
  }

  getProject(workspaceId: string, projectId: string): any {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=? AND workspace_id=?').get(projectId, workspaceId) as any;
    if (!row) throw new MadeProofError('PROJECT_NOT_FOUND', 'Project not found', 404);
    return row;
  }

  createTask(input: { workspaceId: string; projectId: string; title: string; intent: string; template?: string; actorId: string }): any {
    this.getProject(input.workspaceId, input.projectId);
    const id = newId('tsk');
    const now = nowIso();
    this.db.prepare(`INSERT INTO tasks(id,workspace_id,project_id,title,intent,template,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.workspaceId, input.projectId, input.title, input.intent, input.template ?? null, 'DRAFT', input.actorId, now, now);
    return this.getTask(input.workspaceId, id);
  }

  listTasks(workspaceId: string, filters: { status?: string; projectId?: string; limit?: number; offset?: number } = {}): any[] {
    const clauses = ['workspace_id=?'];
    const params: unknown[] = [workspaceId];
    if (filters.status) { clauses.push('status=?'); params.push(filters.status); }
    if (filters.projectId) { clauses.push('project_id=?'); params.push(filters.projectId); }
    params.push(filters.limit ?? 50, filters.offset ?? 0);
    return this.db.prepare(`SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params) as any[];
  }

  getTask(workspaceId: string, taskId: string): any {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=? AND workspace_id=?').get(taskId, workspaceId) as any;
    if (!row) throw new MadeProofError('TASK_NOT_FOUND', 'Task not found', 404);
    return row;
  }

  updateTaskStatus(workspaceId: string, taskId: string, expected: TaskStatus, next: TaskStatus): void {
    const result = this.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=? AND workspace_id=? AND status=?')
      .run(next, nowIso(), taskId, workspaceId, expected);
    if (result.changes !== 1) throw new MadeProofError('TASK_STATE_CONFLICT', `Task is no longer in ${expected}`, 409);
  }

  createContract(workspaceId: string, contract: OutcomeContract): OutcomeContract {
    return this.transaction(() => {
      const task = this.getTask(workspaceId, contract.taskId);
      if (task.status !== 'DRAFT' && task.status !== 'READY') {
        throw new MadeProofError('CONTRACT_LOCKED', 'A new contract version cannot be created while a run is active', 409);
      }
      this.db.prepare(`INSERT INTO outcome_contracts(id,workspace_id,task_id,version,goal,expected_outcome,contract_json,created_at,locked_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(contract.id, workspaceId, contract.taskId, contract.version, contract.goal, contract.expectedOutcome, JSON.stringify(contract), contract.createdAt, contract.lockedAt);
      const insertCriterion = this.db.prepare(`INSERT INTO acceptance_criteria(id,workspace_id,contract_id,position,title,required,severity,category,verification_type,criterion_json) VALUES(?,?,?,?,?,?,?,?,?,?)`);
      for (const item of contract.acceptanceCriteria) {
        insertCriterion.run(item.id, workspaceId, contract.id, item.position, item.title, item.required ? 1 : 0, item.severity, item.category, item.verificationType, JSON.stringify(item));
      }
      this.db.prepare('UPDATE tasks SET latest_contract_version=?,status=?,updated_at=? WHERE id=? AND workspace_id=?')
        .run(contract.version, 'READY', nowIso(), contract.taskId, workspaceId);
      return contract;
    });
  }

  getContract(workspaceId: string, taskId: string, version?: number): OutcomeContract {
    const row = version
      ? this.db.prepare('SELECT * FROM outcome_contracts WHERE workspace_id=? AND task_id=? AND version=?').get(workspaceId, taskId, version)
      : this.db.prepare('SELECT * FROM outcome_contracts WHERE workspace_id=? AND task_id=? ORDER BY version DESC LIMIT 1').get(workspaceId, taskId);
    if (!row) throw new MadeProofError('CONTRACT_NOT_FOUND', 'Outcome contract not found', 404);
    const contract = parseJson<OutcomeContract>((row as any).contract_json, {} as OutcomeContract);
    contract.lockedAt = (row as any).locked_at ?? null;
    return contract;
  }

  listContracts(workspaceId: string, taskId: string): OutcomeContract[] {
    this.getTask(workspaceId, taskId);
    return (this.db.prepare('SELECT contract_json,locked_at FROM outcome_contracts WHERE workspace_id=? AND task_id=? ORDER BY version DESC').all(workspaceId, taskId) as any[])
      .map((row) => ({ ...parseJson<OutcomeContract>(row.contract_json, {} as OutcomeContract), lockedAt: row.locked_at ?? null }));
  }

  lockContract(workspaceId: string, contractId: string): string {
    const lockedAt = nowIso();
    this.transaction(() => {
      const row = this.db.prepare('SELECT contract_json,locked_at FROM outcome_contracts WHERE id=? AND workspace_id=?').get(contractId, workspaceId) as any;
      if (!row) throw new MadeProofError('CONTRACT_NOT_FOUND', 'Outcome contract not found', 404);
      if (!row.locked_at) {
        const contract = parseJson<OutcomeContract>(row.contract_json, {} as OutcomeContract);
        contract.lockedAt = lockedAt;
        this.db.prepare('UPDATE outcome_contracts SET locked_at=?,contract_json=? WHERE id=? AND workspace_id=?')
          .run(lockedAt, JSON.stringify(contract), contractId, workspaceId);
      }
    });
    return lockedAt;
  }

  startRun(input: { workspaceId: string; taskId: string; actorId: string; metadata?: Record<string, unknown>; artifactRef?: string; agentId?: string }): any {
    return this.transaction(() => {
      const task = this.getTask(input.workspaceId, input.taskId);
      if (task.status !== 'IN_PROGRESS') throw new MadeProofError('TASK_STATE_CONFLICT', 'Task must be IN_PROGRESS before a run is created', 409);
      const contract = this.getContract(input.workspaceId, input.taskId);
      const contractRow = this.db.prepare('SELECT contract_json,locked_at FROM outcome_contracts WHERE id=? AND workspace_id=?').get(contract.id, input.workspaceId) as any;
      if (!contractRow) throw new MadeProofError('CONTRACT_NOT_FOUND', 'Outcome contract not found', 404);
      if (!contractRow.locked_at) {
        const lockedAt = nowIso();
        const lockedContract = parseJson<OutcomeContract>(contractRow.contract_json, {} as OutcomeContract);
        lockedContract.lockedAt = lockedAt;
        this.db.prepare('UPDATE outcome_contracts SET locked_at=?,contract_json=? WHERE id=? AND workspace_id=?')
          .run(lockedAt, JSON.stringify(lockedContract), contract.id, input.workspaceId);
      }
      assertTaskTransition('IN_PROGRESS', 'AWAITING_EVIDENCE');
      const last = this.db.prepare('SELECT MAX(attempt) AS attempt FROM runs WHERE task_id=?').get(input.taskId) as any;
      const attempt = Number(last?.attempt ?? 0) + 1;
      const id = newId('run');
      const now = nowIso();
      this.db.prepare(`INSERT INTO runs(id,workspace_id,task_id,contract_id,contract_version,status,attempt,agent_id,artifact_ref,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, input.workspaceId, input.taskId, contract.id, contract.version, 'AWAITING_EVIDENCE', attempt, input.agentId ?? null, input.artifactRef ?? null, JSON.stringify(input.metadata ?? {}), now, now);
      this.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=? AND workspace_id=?')
        .run('AWAITING_EVIDENCE', now, input.taskId, input.workspaceId);
      return this.getRun(input.workspaceId, id);
    });
  }

  getRun(workspaceId: string, runId: string): any {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=? AND workspace_id=?').get(runId, workspaceId) as any;
    if (!row) throw new MadeProofError('RUN_NOT_FOUND', 'Run not found', 404);
    return { ...row, metadata: parseJson(row.metadata_json, {}) };
  }

  listRuns(workspaceId: string, taskId: string): any[] {
    this.getTask(workspaceId, taskId);
    return (this.db.prepare('SELECT * FROM runs WHERE workspace_id=? AND task_id=? ORDER BY attempt DESC').all(workspaceId, taskId) as any[])
      .map((row) => ({ ...row, metadata: parseJson(row.metadata_json, {}) }));
  }

  updateRunStatus(workspaceId: string, runId: string, expected: RunStatus, next: RunStatus): void {
    const now = nowIso();
    const finished = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(next) ? now : null;
    const started = ['RUNNING', 'VERIFYING'].includes(next) ? now : null;
    const result = this.db.prepare(`UPDATE runs SET status=?,updated_at=?,started_at=COALESCE(started_at,?),finished_at=COALESCE(?,finished_at) WHERE id=? AND workspace_id=? AND status=?`)
      .run(next, now, started, finished, runId, workspaceId, expected);
    if (result.changes !== 1) throw new MadeProofError('RUN_STATE_CONFLICT', `Run is no longer in ${expected}`, 409);
  }

  addEvidence(item: EvidenceItem): EvidenceItem {
    this.getRun(item.workspaceId, item.runId);
    this.db.prepare(`INSERT INTO evidence(id,workspace_id,run_id,criterion_id,type,source,source_actor,created_at,observed_at,content_hash,mime_type,size_bytes,storage_location,provenance,trust_tier,sanitization_state,value_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(item.id, item.workspaceId, item.runId, item.criterionId, item.type, item.source, item.sourceActor, item.createdAt, item.observedAt, item.contentHash, item.mimeType, item.sizeBytes, item.storageLocation, item.provenance, item.trustTier, item.sanitizationState, item.value === undefined ? null : JSON.stringify(item.value));
    return item;
  }

  listEvidence(workspaceId: string, runId: string): EvidenceItem[] {
    this.getRun(workspaceId, runId);
    return (this.db.prepare('SELECT * FROM evidence WHERE workspace_id=? AND run_id=? ORDER BY created_at').all(workspaceId, runId) as any[])
      .map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        runId: row.run_id,
        criterionId: row.criterion_id,
        type: row.type,
        source: row.source,
        sourceActor: row.source_actor,
        createdAt: row.created_at,
        observedAt: row.observed_at,
        contentHash: row.content_hash,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        storageLocation: row.storage_location,
        provenance: row.provenance,
        trustTier: row.trust_tier,
        sanitizationState: row.sanitization_state,
        value: parseJson(row.value_json, undefined)
      }));
  }

  upsertCheck(input: { workspaceId: string; runId: string; criterionId: string; type: string; config: Record<string, unknown> }): any {
    const existing = this.db.prepare('SELECT * FROM verification_checks WHERE run_id=? AND criterion_id=?').get(input.runId, input.criterionId) as any;
    if (existing) return existing;
    const id = newId('chk');
    const now = nowIso();
    this.db.prepare(`INSERT INTO verification_checks(id,workspace_id,run_id,criterion_id,type,status,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(id, input.workspaceId, input.runId, input.criterionId, input.type, 'PENDING', JSON.stringify(input.config), now, now);
    return this.db.prepare('SELECT * FROM verification_checks WHERE id=?').get(id) as any;
  }

  setCheckStatus(workspaceId: string, checkId: string, status: string): void {
    const result = this.db.prepare('UPDATE verification_checks SET status=?,updated_at=? WHERE id=? AND workspace_id=?').run(status, nowIso(), checkId, workspaceId);
    if (result.changes !== 1) throw new MadeProofError('CHECK_NOT_FOUND', 'Verification check not found', 404);
  }

  saveResult(workspaceId: string, runId: string, result: VerificationResult): void {
    this.transaction(() => {
      this.db.prepare(`INSERT OR REPLACE INTO verification_results(id,workspace_id,run_id,check_id,criterion_id,status,started_at,finished_at,duration_ms,summary,details_json,evidence_ids_json,confidence,error_code,error_message) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(result.id, workspaceId, runId, result.checkId, result.criterionId, result.status, result.startedAt, result.finishedAt, result.durationMs, result.summary, JSON.stringify(result.details), JSON.stringify(result.evidenceIds), result.confidence, result.errorCode ?? null, result.errorMessage ?? null);
      this.setCheckStatus(workspaceId, result.checkId, result.status);
    });
  }

  getResults(workspaceId: string, runId: string): VerificationResult[] {
    this.getRun(workspaceId, runId);
    return (this.db.prepare('SELECT * FROM verification_results WHERE workspace_id=? AND run_id=? ORDER BY started_at').all(workspaceId, runId) as any[])
      .map((row) => ({
        id: row.id,
        checkId: row.check_id,
        criterionId: row.criterion_id,
        status: row.status,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        durationMs: row.duration_ms,
        summary: row.summary,
        details: parseJson(row.details_json, {}),
        evidenceIds: parseJson(row.evidence_ids_json, []),
        confidence: row.confidence,
        errorCode: row.error_code ?? undefined,
        errorMessage: row.error_message ?? undefined
      }));
  }

  saveVerdict(workspaceId: string, runId: string, decision: VerdictDecision): any {
    const existing = this.db.prepare('SELECT * FROM verdicts WHERE run_id=? AND workspace_id=?').get(runId, workspaceId) as any;
    if (existing) return this.getVerdict(workspaceId, runId);
    const row = { id: newId('vrd'), createdAt: nowIso() };
    this.db.prepare(`INSERT INTO verdicts(id,workspace_id,run_id,machine_verdict,confidence,reason,decision_json,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(row.id, workspaceId, runId, decision.verdict, decision.confidence, decision.reason, JSON.stringify(decision), row.createdAt);
    return this.getVerdict(workspaceId, runId);
  }

  getVerdict(workspaceId: string, runId: string): any {
    this.getRun(workspaceId, runId);
    const row = this.db.prepare('SELECT * FROM verdicts WHERE run_id=? AND workspace_id=?').get(runId, workspaceId) as any;
    if (!row) throw new MadeProofError('VERDICT_NOT_READY', 'Verdict is not available yet', 404);
    return { ...row, decision: parseJson(row.decision_json, {}) };
  }

  saveReceipt(input: { workspaceId: string; runId: string; receipt: Record<string, unknown>; digest: string; signature?: string; signingKeyId?: string }): any {
    const existing = this.db.prepare('SELECT * FROM receipts WHERE run_id=? AND workspace_id=?').get(input.runId, input.workspaceId) as any;
    if (existing) return this.getReceipt(input.workspaceId, existing.id);
    const id = newId('rcp');
    const createdAt = nowIso();
    this.db.prepare(`INSERT INTO receipts(id,workspace_id,run_id,receipt_version,receipt_json,digest,signature,signing_key_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(id, input.workspaceId, input.runId, 1, JSON.stringify(input.receipt), input.digest, input.signature ?? null, input.signingKeyId ?? null, createdAt);
    return this.getReceipt(input.workspaceId, id);
  }

  getReceipt(workspaceId: string, receiptId: string): any {
    const row = this.db.prepare('SELECT * FROM receipts WHERE id=? AND workspace_id=?').get(receiptId, workspaceId) as any;
    if (!row) throw new MadeProofError('RECEIPT_NOT_FOUND', 'Verification receipt not found', 404);
    return { ...row, receipt: parseJson(row.receipt_json, {}) };
  }

  getReceiptByRun(workspaceId: string, runId: string): any {
    const row = this.db.prepare('SELECT id FROM receipts WHERE run_id=? AND workspace_id=?').get(runId, workspaceId) as any;
    if (!row) throw new MadeProofError('RECEIPT_NOT_FOUND', 'Verification receipt not found', 404);
    return this.getReceipt(workspaceId, row.id);
  }

  appendAudit(input: { workspaceId: string; actorId: string; actorType: string; action: string; resourceType: string; resourceId: string; previous?: unknown; resulting?: unknown; metadata?: Record<string, unknown> }): void {
    this.db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_id,actor_type,action,resource_type,resource_id,timestamp,previous_state_digest,resulting_state_digest,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(newId('aud'), input.workspaceId, input.actorId, input.actorType, input.action, input.resourceType, input.resourceId, nowIso(), input.previous === undefined ? null : sha256(canonicalJson(input.previous)), input.resulting === undefined ? null : sha256(canonicalJson(input.resulting)), JSON.stringify(input.metadata ?? {}));
  }

  getIdempotency(workspaceId: string, key: string, route: string): any | null {
    const row = this.db.prepare('SELECT * FROM idempotency_records WHERE workspace_id=? AND key=? AND route=? AND expires_at>?').get(workspaceId, key, route, nowIso()) as any;
    return row ? { ...row, response: parseJson(row.response_json, {}) } : null;
  }

  saveIdempotency(input: { workspaceId: string; key: string; route: string; requestHash: string; responseStatus: number; response: unknown }): void {
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(`INSERT OR REPLACE INTO idempotency_records(workspace_id,key,route,request_hash,response_status,response_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(input.workspaceId, input.key, input.route, input.requestHash, input.responseStatus, JSON.stringify(input.response), createdAt, expiresAt);
  }

  listAttention(workspaceId: string): any[] {
    return this.db.prepare(`SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.workspace_id=? AND t.status IN ('FAILED','REVIEW_REQUIRED') ORDER BY t.updated_at DESC LIMIT 50`).all(workspaceId) as any[];
  }

  dashboardCounts(workspaceId: string): Record<string, number> {
    const rows = this.db.prepare(`SELECT status,COUNT(*) AS count FROM tasks WHERE workspace_id=? GROUP BY status`).all(workspaceId) as any[];
    const map = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    return {
      attention: (map.FAILED ?? 0) + (map.REVIEW_REQUIRED ?? 0),
      running: (map.IN_PROGRESS ?? 0) + (map.AWAITING_EVIDENCE ?? 0) + (map.VERIFYING ?? 0),
      verified: map.VERIFIED ?? 0
    };
  }
}
