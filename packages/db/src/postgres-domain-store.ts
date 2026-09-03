import { PostgresStoreBase } from './postgres-base.js';
import type {
  EvidenceItem,
  OutcomeContract,
  RunStatus,
  TaskStatus,
  VerificationResult,
  VerdictDecision,
} from '../../domain/src/types.js';
import { assertTaskTransition } from '../../domain/src/state-machine.js';
import { MadeProofError } from '../../shared/src/errors.js';
import { canonicalJson, sha256 } from '../../shared/src/canonical.js';
import { newId, nowIso } from '../../shared/src/ids.js';
function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}
function evidenceFromRow(row: any): EvidenceItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    criterionId: row.criterion_id ?? undefined,
    type: row.type,
    source: row.source,
    sourceActor: row.source_actor,
    createdAt: new Date(row.created_at).toISOString(),
    observedAt: new Date(row.observed_at).toISOString(),
    contentHash: row.content_hash,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    storageLocation: row.storage_location,
    provenance: row.provenance,
    trustTier: Number(row.trust_tier),
    sanitizationState: row.sanitization_state,
    value: json(row.value_json, undefined),
  };
}
export class PostgresStoreDomain extends PostgresStoreBase {
  async updateTaskStatus(w: string, id: string, e: TaskStatus, n: TaskStatus) {
    const r = await this.workspaceQuery(
      w,
      'UPDATE tasks SET status=$1,updated_at=now() WHERE id=$2 AND workspace_id=$3 AND status=$4',
      [n, id, w, e],
    );
    if (r.rowCount !== 1)
      throw new MadeProofError('TASK_STATE_CONFLICT', `Task is no longer in ${e}`, 409);
  }
  async createContract(w: string, c: OutcomeContract) {
    const db = await (await this.getPool()).connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT set_config('madeproof.workspace_id',$1,true)", [w]);
      const t = (
        await db.query('SELECT * FROM tasks WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
          w,
          c.taskId,
        ])
      ).rows[0];
      if (!t) throw new MadeProofError('TASK_NOT_FOUND', 'Task not found', 404);
      if (!['DRAFT', 'READY'].includes(t.status))
        throw new MadeProofError(
          'CONTRACT_LOCKED',
          'A new contract version cannot be created while a run is active',
          409,
        );
      await db.query(
        'INSERT INTO outcome_contracts(id,workspace_id,task_id,version,goal,expected_outcome,contract_json,created_at,locked_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',
        [
          c.id,
          w,
          c.taskId,
          c.version,
          c.goal,
          c.expectedOutcome,
          JSON.stringify(c),
          c.createdAt,
          c.lockedAt,
        ],
      );
      for (const x of c.acceptanceCriteria)
        await db.query(
          'INSERT INTO acceptance_criteria(id,workspace_id,contract_id,position,title,required,severity,category,verification_type,criterion_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',
          [
            x.id,
            w,
            c.id,
            x.position,
            x.title,
            x.required,
            x.severity,
            x.category,
            x.verificationType,
            JSON.stringify(x),
          ],
        );
      await db.query(
        "UPDATE tasks SET latest_contract_version=$1,status='READY',updated_at=now() WHERE id=$2 AND workspace_id=$3",
        [c.version, c.taskId, w],
      );
      await db.query('COMMIT');
      return c;
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  }
  async getContract(w: string, t: string, v?: number): Promise<OutcomeContract> {
    const r = v
      ? await this.workspaceQuery(
          w,
          'SELECT contract_json,locked_at FROM outcome_contracts WHERE workspace_id=$1 AND task_id=$2 AND version=$3',
          [w, t, v],
        )
      : await this.workspaceQuery(
          w,
          'SELECT contract_json,locked_at FROM outcome_contracts WHERE workspace_id=$1 AND task_id=$2 ORDER BY version DESC LIMIT 1',
          [w, t],
        );
    const x = r.rows[0];
    if (!x) throw new MadeProofError('CONTRACT_NOT_FOUND', 'Outcome contract not found', 404);
    return {
      ...json<OutcomeContract>(x.contract_json, {} as OutcomeContract),
      lockedAt: x.locked_at ? new Date(x.locked_at).toISOString() : null,
    };
  }
  async listContracts(w: string, t: string) {
    await this.getTask(w, t);
    return (
      await this.workspaceQuery(
        w,
        'SELECT contract_json,locked_at FROM outcome_contracts WHERE workspace_id=$1 AND task_id=$2 ORDER BY version DESC',
        [w, t],
      )
    ).rows.map((x: any) => ({
      ...json<OutcomeContract>(x.contract_json, {} as OutcomeContract),
      lockedAt: x.locked_at ? new Date(x.locked_at).toISOString() : null,
    }));
  }
  async lockContract(w: string, id: string) {
    const at = nowIso(),
      r = await this.workspaceQuery(
        w,
        "UPDATE outcome_contracts SET locked_at=COALESCE(locked_at,$1),contract_json=jsonb_set(contract_json,'{lockedAt}',to_jsonb(COALESCE(locked_at,$1)::text),true) WHERE id=$2 AND workspace_id=$3 RETURNING locked_at",
        [at, id, w],
      );
    if (!r.rowCount)
      throw new MadeProofError('CONTRACT_NOT_FOUND', 'Outcome contract not found', 404);
    return new Date(r.rows[0].locked_at).toISOString();
  }
  async startRun(i: any) {
    const db = await (await this.getPool()).connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT set_config('madeproof.workspace_id',$1,true)", [i.workspaceId]);
      const t = (
        await db.query('SELECT * FROM tasks WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
          i.workspaceId,
          i.taskId,
        ])
      ).rows[0];
      if (!t) throw new MadeProofError('TASK_NOT_FOUND', 'Task not found', 404);
      if (t.status !== 'IN_PROGRESS')
        throw new MadeProofError(
          'TASK_STATE_CONFLICT',
          'Task must be IN_PROGRESS before a run is created',
          409,
        );
      const c = (
        await db.query(
          'SELECT * FROM outcome_contracts WHERE workspace_id=$1 AND task_id=$2 ORDER BY version DESC LIMIT 1 FOR UPDATE',
          [i.workspaceId, i.taskId],
        )
      ).rows[0];
      if (!c) throw new MadeProofError('CONTRACT_NOT_FOUND', 'Outcome contract not found', 404);
      if (!c.locked_at) {
        const at = nowIso(),
          j = json<OutcomeContract>(c.contract_json, {} as OutcomeContract);
        j.lockedAt = at;
        await db.query(
          'UPDATE outcome_contracts SET locked_at=$1,contract_json=$2::jsonb WHERE id=$3 AND workspace_id=$4',
          [at, JSON.stringify(j), c.id, i.workspaceId],
        );
      }
      assertTaskTransition('IN_PROGRESS', 'AWAITING_EVIDENCE');
      const a =
          Number(
            (
              await db.query(
                'SELECT COALESCE(MAX(attempt),0) AS attempt FROM runs WHERE task_id=$1',
                [i.taskId],
              )
            ).rows[0].attempt,
          ) + 1,
        id = newId('run'),
        r = (
          await db.query(
            "INSERT INTO runs(id,workspace_id,task_id,contract_id,contract_version,status,attempt,agent_id,artifact_ref,metadata_json) VALUES($1,$2,$3,$4,$5,'AWAITING_EVIDENCE',$6,$7,$8,$9::jsonb) RETURNING *",
            [
              id,
              i.workspaceId,
              i.taskId,
              c.id,
              c.version,
              a,
              i.agentId ?? null,
              i.artifactRef ?? null,
              JSON.stringify(i.metadata ?? {}),
            ],
          )
        ).rows[0];
      await db.query(
        "UPDATE tasks SET status='AWAITING_EVIDENCE',updated_at=now() WHERE id=$1 AND workspace_id=$2",
        [i.taskId, i.workspaceId],
      );
      await db.query('COMMIT');
      return { ...r, metadata: json(r.metadata_json, {}) };
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  }
  async getRun(w: string, id: string) {
    const r = (
      await this.workspaceQuery(w, 'SELECT * FROM runs WHERE id=$1 AND workspace_id=$2', [id, w])
    ).rows[0];
    if (!r) throw new MadeProofError('RUN_NOT_FOUND', 'Run not found', 404);
    return { ...r, metadata: json(r.metadata_json, {}) };
  }
  async listRuns(w: string, t: string) {
    await this.getTask(w, t);
    return (
      await this.workspaceQuery(
        w,
        'SELECT * FROM runs WHERE workspace_id=$1 AND task_id=$2 ORDER BY attempt DESC',
        [w, t],
      )
    ).rows.map((r: any) => ({ ...r, metadata: json(r.metadata_json, {}) }));
  }
  async updateRunStatus(w: string, id: string, e: RunStatus, n: RunStatus) {
    const f = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(n),
      s = ['RUNNING', 'VERIFYING'].includes(n),
      r = await this.workspaceQuery(
        w,
        'UPDATE runs SET status=$1,updated_at=now(),started_at=COALESCE(started_at,CASE WHEN $2::boolean THEN now() ELSE NULL END),finished_at=COALESCE(CASE WHEN $3::boolean THEN now() ELSE NULL END,finished_at) WHERE id=$4 AND workspace_id=$5 AND status=$6',
        [n, s, f, id, w, e],
      );
    if (r.rowCount !== 1)
      throw new MadeProofError('RUN_STATE_CONFLICT', `Run is no longer in ${e}`, 409);
  }
  async addEvidence(i: EvidenceItem) {
    await this.getRun(i.workspaceId, i.runId);
    await this.workspaceQuery(
      i.workspaceId,
      'INSERT INTO evidence(id,workspace_id,run_id,criterion_id,type,source,source_actor,created_at,observed_at,content_hash,mime_type,size_bytes,storage_location,provenance,trust_tier,sanitization_state,value_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)',
      [
        i.id,
        i.workspaceId,
        i.runId,
        i.criterionId ?? null,
        i.type,
        i.source,
        i.sourceActor,
        i.createdAt,
        i.observedAt,
        i.contentHash,
        i.mimeType,
        i.sizeBytes,
        i.storageLocation,
        i.provenance,
        i.trustTier,
        i.sanitizationState,
        i.value === undefined ? null : JSON.stringify(i.value),
      ],
    );
    return i;
  }
  async listEvidence(w: string, r: string) {
    await this.getRun(w, r);
    return (
      await this.workspaceQuery(
        w,
        'SELECT * FROM evidence WHERE workspace_id=$1 AND run_id=$2 ORDER BY created_at',
        [w, r],
      )
    ).rows.map(evidenceFromRow);
  }
  async upsertCheck(i: any) {
    return (
      await this.workspaceQuery(
        i.workspaceId,
        "INSERT INTO verification_checks(id,workspace_id,run_id,criterion_id,type,status,config_json) VALUES($1,$2,$3,$4,$5,'PENDING',$6::jsonb) ON CONFLICT(run_id,criterion_id) DO UPDATE SET updated_at=now() RETURNING *",
        [newId('chk'), i.workspaceId, i.runId, i.criterionId, i.type, JSON.stringify(i.config)],
      )
    ).rows[0];
  }
  async setCheckStatus(w: string, id: string, s: string) {
    const r = await this.workspaceQuery(
      w,
      'UPDATE verification_checks SET status=$1,updated_at=now() WHERE id=$2 AND workspace_id=$3',
      [s, id, w],
    );
    if (r.rowCount !== 1)
      throw new MadeProofError('CHECK_NOT_FOUND', 'Verification check not found', 404);
  }
  async saveResult(w: string, rid: string, r: VerificationResult) {
    const db = await (await this.getPool()).connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT set_config('madeproof.workspace_id',$1,true)", [w]);
      await db.query(
        'INSERT INTO verification_results(id,workspace_id,run_id,check_id,criterion_id,status,started_at,finished_at,duration_ms,summary,details_json,evidence_ids_json,confidence,error_code,error_message) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15) ON CONFLICT(check_id) DO UPDATE SET id=EXCLUDED.id,status=EXCLUDED.status,started_at=EXCLUDED.started_at,finished_at=EXCLUDED.finished_at,duration_ms=EXCLUDED.duration_ms,summary=EXCLUDED.summary,details_json=EXCLUDED.details_json,evidence_ids_json=EXCLUDED.evidence_ids_json,confidence=EXCLUDED.confidence,error_code=EXCLUDED.error_code,error_message=EXCLUDED.error_message',
        [
          r.id,
          w,
          rid,
          r.checkId,
          r.criterionId,
          r.status,
          r.startedAt,
          r.finishedAt,
          r.durationMs,
          r.summary,
          JSON.stringify(r.details),
          JSON.stringify(r.evidenceIds),
          r.confidence,
          r.errorCode ?? null,
          r.errorMessage ?? null,
        ],
      );
      await db.query(
        'UPDATE verification_checks SET status=$1,updated_at=now() WHERE id=$2 AND workspace_id=$3',
        [r.status, r.checkId, w],
      );
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  }
  async getResults(w: string, r: string): Promise<VerificationResult[]> {
    await this.getRun(w, r);
    return (
      await this.workspaceQuery(
        w,
        'SELECT * FROM verification_results WHERE workspace_id=$1 AND run_id=$2 ORDER BY started_at',
        [w, r],
      )
    ).rows.map((x: any) => ({
      id: x.id,
      checkId: x.check_id,
      criterionId: x.criterion_id,
      status: x.status,
      startedAt: new Date(x.started_at).toISOString(),
      finishedAt: new Date(x.finished_at).toISOString(),
      durationMs: Number(x.duration_ms),
      summary: x.summary,
      details: json(x.details_json, {}),
      evidenceIds: json<string[]>(x.evidence_ids_json, []),
      confidence: Number(x.confidence),
      errorCode: x.error_code ?? undefined,
      errorMessage: x.error_message ?? undefined,
    }));
  }
  async saveVerdict(w: string, r: string, d: VerdictDecision) {
    const e = (
      await this.workspaceQuery(w, 'SELECT id FROM verdicts WHERE run_id=$1 AND workspace_id=$2', [
        r,
        w,
      ])
    ).rows[0];
    if (e) return this.getVerdict(w, r);
    await this.workspaceQuery(
      w,
      'INSERT INTO verdicts(id,workspace_id,run_id,machine_verdict,confidence,reason,decision_json) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [newId('vrd'), w, r, d.verdict, d.confidence, d.reason, JSON.stringify(d)],
    );
    return this.getVerdict(w, r);
  }
  async getVerdict(w: string, r: string) {
    await this.getRun(w, r);
    const x = (
      await this.workspaceQuery(w, 'SELECT * FROM verdicts WHERE run_id=$1 AND workspace_id=$2', [
        r,
        w,
      ])
    ).rows[0];
    if (!x) return null;
    return { ...x, decision: json(x.decision_json, {}) };
  }
  async saveReceipt(i: any) {
    const e = (
      await this.workspaceQuery(
        i.workspaceId,
        'SELECT id FROM receipts WHERE run_id=$1 AND workspace_id=$2',
        [i.runId, i.workspaceId],
      )
    ).rows[0];
    if (e) return this.getReceipt(i.workspaceId, e.id);
    const id = newId('rcp');
    await this.workspaceQuery(
      i.workspaceId,
      'INSERT INTO receipts(id,workspace_id,run_id,receipt_version,receipt_json,digest,signature,signing_key_id) VALUES($1,$2,$3,1,$4::jsonb,$5,$6,$7)',
      [
        id,
        i.workspaceId,
        i.runId,
        JSON.stringify(i.receipt),
        i.digest,
        i.signature ?? null,
        i.signingKeyId ?? null,
      ],
    );
    return this.getReceipt(i.workspaceId, id);
  }
  async getReceipt(w: string, id: string) {
    const r = (
      await this.workspaceQuery(w, 'SELECT * FROM receipts WHERE id=$1 AND workspace_id=$2', [
        id,
        w,
      ])
    ).rows[0];
    if (!r) throw new MadeProofError('RECEIPT_NOT_FOUND', 'Verification receipt not found', 404);
    return { ...r, receipt: json(r.receipt_json, {}) };
  }
  async getReceiptByRun(w: string, r: string) {
    const x = (
      await this.workspaceQuery(w, 'SELECT id FROM receipts WHERE run_id=$1 AND workspace_id=$2', [
        r,
        w,
      ])
    ).rows[0];
    if (!x) throw new MadeProofError('RECEIPT_NOT_FOUND', 'Verification receipt not found', 404);
    return this.getReceipt(w, x.id);
  }
  async appendAudit(i: any) {
    await this.workspaceQuery(
      i.workspaceId,
      'INSERT INTO audit_events(id,workspace_id,actor_id,actor_type,action,resource_type,resource_id,previous_state_digest,resulting_state_digest,metadata_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',
      [
        newId('aud'),
        i.workspaceId,
        i.actorId,
        i.actorType,
        i.action,
        i.resourceType,
        i.resourceId,
        i.previous === undefined ? null : sha256(canonicalJson(i.previous)),
        i.resulting === undefined ? null : sha256(canonicalJson(i.resulting)),
        JSON.stringify(i.metadata ?? {}),
      ],
    );
  }
  async getIdempotency(w: string, k: string, r: string) {
    const x = (
      await this.workspaceQuery(
        w,
        'SELECT * FROM idempotency_records WHERE workspace_id=$1 AND key=$2 AND route=$3 AND expires_at>now()',
        [w, k, r],
      )
    ).rows[0];
    return x ? { ...x, response: json(x.response_json, {}) } : null;
  }
  async saveIdempotency(i: any) {
    await this.workspaceQuery(
      i.workspaceId,
      "INSERT INTO idempotency_records(workspace_id,key,route,request_hash,response_status,response_json,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,now(),now()+interval '24 hours') ON CONFLICT(workspace_id,key,route) DO UPDATE SET request_hash=EXCLUDED.request_hash,response_status=EXCLUDED.response_status,response_json=EXCLUDED.response_json,created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at",
      [i.workspaceId, i.key, i.route, i.requestHash, i.responseStatus, JSON.stringify(i.response)],
    );
  }
  async listAttention(w: string) {
    return (
      await this.workspaceQuery(
        w,
        "SELECT t.*,p.name AS project_name FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.workspace_id=$1 AND t.status IN ('FAILED','REVIEW_REQUIRED') ORDER BY t.updated_at DESC LIMIT 50",
        [w],
      )
    ).rows;
  }
  async dashboardCounts(w: string) {
    const rows = (
        await this.workspaceQuery(
          w,
          'SELECT status,COUNT(*)::int AS count FROM tasks WHERE workspace_id=$1 GROUP BY status',
          [w],
        )
      ).rows,
      m = Object.fromEntries(rows.map((x: any) => [x.status, Number(x.count)]));
    return {
      attention: (m.FAILED ?? 0) + (m.REVIEW_REQUIRED ?? 0),
      running: (m.IN_PROGRESS ?? 0) + (m.AWAITING_EVIDENCE ?? 0) + (m.VERIFYING ?? 0),
      verified: m.VERIFIED ?? 0,
    };
  }
}
