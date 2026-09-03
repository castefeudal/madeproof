import fs from 'node:fs';
import path from 'node:path';
import { findMigrationsDir } from './migrations.js';
import { newId } from '../../shared/src/ids.js';
import { MadeProofError } from '../../shared/src/errors.js';
function slugify(v: string) {
  return (
    v
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'project'
  );
}
function json<T>(v: unknown, f: T): T {
  if (v == null) return f;
  if (typeof v === 'string') return JSON.parse(v) as T;
  return v as T;
}
export class PostgresStoreBase {
  private pool: any | null = null;
  constructor(readonly databaseUrl: string) {}
  protected async getPool() {
    if (this.pool) return this.pool;
    let pg: any;
    try {
      pg = await import('pg');
    } catch (e) {
      throw new MadeProofError(
        'POSTGRES_DRIVER_MISSING',
        'PostgreSQL mode requires the pg package.',
        500,
        { cause: e instanceof Error ? e.message : String(e) },
      );
    }
    this.pool = new pg.Pool({
      connectionString: this.databaseUrl,
      max: Number(process.env.PG_POOL_MAX ?? 12),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    return this.pool;
  }
  protected async query(t: string, p: unknown[] = []) {
    return (await this.getPool()).query(t, p);
  }
  protected async workspaceQuery(w: string, t: string, p: unknown[] = []) {
    const c = await (await this.getPool()).connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('madeproof.workspace_id',$1,true)", [w]);
      const r = await c.query(t, p);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      try {
        await c.query('ROLLBACK');
      } catch {}
      throw e;
    } finally {
      c.release();
    }
  }
  async migrate() {
    const c = await (await this.getPool()).connect();
    try {
      await c.query('SELECT pg_advisory_lock(583412907112)');
      await c.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const d = findMigrationsDir('postgres');
      for (const n of fs
        .readdirSync(d)
        .filter((x: string) => x.endsWith('.sql'))
        .sort()) {
        if ((await c.query('SELECT 1 FROM schema_migrations WHERE version=$1', [n])).rowCount)
          continue;
        await c.query('BEGIN');
        try {
          await c.query(fs.readFileSync(path.join(d, n), 'utf8'));
          await c.query('INSERT INTO schema_migrations(version) VALUES($1)', [n]);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        }
      }
    } finally {
      try {
        await c.query('SELECT pg_advisory_unlock(583412907112)');
      } catch {}
      c.release();
    }
  }
  async ping() {
    return Boolean((await this.query('SELECT 1')).rowCount);
  }
  async close() {
    if (this.pool) await this.pool.end();
    this.pool = null;
  }
  async bootstrapOwner(email: string, passwordHash: string) {
    const e = (await this.query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
    if (e) {
      const m = (
        await this.query(
          'SELECT workspace_id FROM workspace_members WHERE user_id=$1 ORDER BY created_at LIMIT 1',
          [e.id],
        )
      ).rows[0];
      if (!m)
        throw new MadeProofError(
          'BOOTSTRAP_CORRUPT',
          'Owner exists without a workspace membership',
          500,
        );
      return { userId: e.id, workspaceId: m.workspace_id };
    }
    const c = await (await this.getPool()).connect();
    try {
      await c.query('BEGIN');
      const userId = newId('usr'),
        workspaceId = newId('wsp');
      await c.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
        userId,
        email,
        passwordHash,
      ]);
      await c.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [
        workspaceId,
        'MADEPROOF Workspace',
      ]);
      await c.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)', [
        workspaceId,
        userId,
        'OWNER',
      ]);
      await c.query('COMMIT');
      return { userId, workspaceId };
    } catch (e2) {
      await c.query('ROLLBACK');
      throw e2;
    } finally {
      c.release();
    }
  }
  async getUserByEmail(e: string) {
    return (await this.query('SELECT * FROM users WHERE email=$1', [e])).rows[0] ?? null;
  }
  async getUserById(id: string) {
    return (
      (await this.query('SELECT id,email,created_at FROM users WHERE id=$1', [id])).rows[0] ?? null
    );
  }
  async getDefaultWorkspaceForUser(id: string) {
    return (
      (
        await this.query(
          'SELECT w.*,wm.role FROM workspaces w JOIN workspace_members wm ON wm.workspace_id=w.id WHERE wm.user_id=$1 ORDER BY w.created_at LIMIT 1',
          [id],
        )
      ).rows[0] ?? null
    );
  }
  async hasWorkspaceAccess(u: string, w: string) {
    return Boolean(
      (
        await this.query('SELECT 1 FROM workspace_members WHERE user_id=$1 AND workspace_id=$2', [
          u,
          w,
        ])
      ).rowCount,
    );
  }
  async createSession(u: string, h: string, c: string, x: string) {
    return (
      await this.query(
        'INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [newId('ses'), u, h, c, x],
      )
    ).rows[0];
  }
  async getSession(h: string) {
    return (
      (
        await this.query(
          'SELECT s.*,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()',
          [h],
        )
      ).rows[0] ?? null
    );
  }
  async revokeSession(h: string) {
    await this.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [h]);
  }
  async createApiKey(i: any) {
    const r = (
      await this.query(
        'INSERT INTO api_keys(id,workspace_id,created_by,name,prefix,key_hash,scopes_json,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *',
        [
          newId('key'),
          i.workspaceId,
          i.userId,
          i.name,
          i.prefix,
          i.keyHash,
          JSON.stringify(i.scopes),
          i.expiresAt ?? null,
        ],
      )
    ).rows[0];
    return { ...r, scopes: json<string[]>(r.scopes_json, []) };
  }
  async getApiKey(h: string) {
    const r = (
      await this.query(
        'UPDATE api_keys SET last_used_at=now() WHERE key_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) RETURNING *',
        [h],
      )
    ).rows[0];
    return r ? { ...r, scopes: json<string[]>(r.scopes_json, []) } : null;
  }
  async listApiKeys(w: string) {
    return (
      await this.workspaceQuery(
        w,
        'SELECT id,name,prefix,scopes_json,expires_at,revoked_at,last_used_at,created_at FROM api_keys WHERE workspace_id=$1 ORDER BY created_at DESC',
        [w],
      )
    ).rows.map((r: any) => ({ ...r, scopes: json<string[]>(r.scopes_json, []) }));
  }
  async revokeApiKey(w: string, id: string) {
    return (
      (
        await this.workspaceQuery(
          w,
          'UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL',
          [id, w],
        )
      ).rowCount === 1
    );
  }
  async createProject(i: any) {
    const id = newId('prj'),
      b = slugify(i.name);
    let s = b;
    for (let n = 0; n < 50; n++) {
      try {
        return (
          await this.workspaceQuery(
            i.workspaceId,
            'INSERT INTO projects(id,workspace_id,name,slug,project_type,repository_url) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
            [id, i.workspaceId, i.name, s, i.projectType ?? 'software', i.repositoryUrl ?? null],
          )
        ).rows[0];
      } catch (e: any) {
        if (e?.code !== '23505') throw e;
        s = `${b}-${n + 2}`;
      }
    }
    throw new MadeProofError(
      'PROJECT_SLUG_CONFLICT',
      'Could not allocate a unique project slug',
      409,
    );
  }
  async listProjects(w: string, l = 50, o = 0) {
    return (
      await this.workspaceQuery(
        w,
        'SELECT * FROM projects WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [w, l, o],
      )
    ).rows;
  }
  async getProject(w: string, id: string) {
    const r = (
      await this.workspaceQuery(w, 'SELECT * FROM projects WHERE workspace_id=$1 AND id=$2', [
        w,
        id,
      ])
    ).rows[0];
    if (!r) throw new MadeProofError('PROJECT_NOT_FOUND', 'Project not found', 404);
    return r;
  }
  async createTask(i: any) {
    await this.getProject(i.workspaceId, i.projectId);
    return (
      await this.workspaceQuery(
        i.workspaceId,
        "INSERT INTO tasks(id,workspace_id,project_id,title,intent,template,status,created_by) VALUES($1,$2,$3,$4,$5,$6,'DRAFT',$7) RETURNING *",
        [
          newId('tsk'),
          i.workspaceId,
          i.projectId,
          i.title,
          i.intent,
          i.template ?? null,
          i.actorId,
        ],
      )
    ).rows[0];
  }
  async listTasks(w: string, f: any = {}) {
    const c = ['workspace_id=$1'],
      p: any[] = [w];
    if (f.status) {
      p.push(f.status);
      c.push(`status=$${p.length}`);
    }
    if (f.projectId) {
      p.push(f.projectId);
      c.push(`project_id=$${p.length}`);
    }
    p.push(Math.min(f.limit ?? 50, 100));
    const l = p.length;
    p.push(Math.max(f.offset ?? 0, 0));
    return (
      await this.workspaceQuery(
        w,
        `SELECT * FROM tasks WHERE ${c.join(' AND ')} ORDER BY updated_at DESC LIMIT $${l} OFFSET $${p.length}`,
        p,
      )
    ).rows;
  }
  async getTask(w: string, id: string) {
    const r = (
      await this.workspaceQuery(w, 'SELECT * FROM tasks WHERE workspace_id=$1 AND id=$2', [w, id])
    ).rows[0];
    if (!r) throw new MadeProofError('TASK_NOT_FOUND', 'Task not found', 404);
    return r;
  }
}
