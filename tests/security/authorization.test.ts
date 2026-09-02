import test from 'node:test';
import assert from 'node:assert/strict';
import { newId, nowIso } from '../../packages/shared/src/ids.js';
import { hashPassword } from '../../packages/security/src/crypto.js';
import { api, login, startTestApplication } from '../helpers/runtime.js';

test('workspace scoping prevents IDOR even when another task ID is known', async () => {
  const runtime = await startTestApplication('tenant');
  try {
    const service = runtime.app.service;
    const owner = {
      id: service.owner.userId,
      workspaceId: service.owner.workspaceId,
      type: 'USER' as const,
      scopes: ['*'],
    };
    const otherUserId = newId('usr');
    const otherWorkspaceId = newId('wsp');
    const now = nowIso();
    service.store.db
      .prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)')
      .run(otherUserId, 'other@example.test', hashPassword('another safe password'), now);
    service.store.db
      .prepare('INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)')
      .run(otherWorkspaceId, 'Other workspace', now);
    service.store.db
      .prepare(
        'INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)',
      )
      .run(otherWorkspaceId, otherUserId, 'OWNER', now);
    const other = {
      id: otherUserId,
      workspaceId: otherWorkspaceId,
      type: 'USER' as const,
      scopes: ['*'],
    };
    const otherProject = service.createProject(other, { name: 'Private project' });
    const otherTask = service.createTask(other, {
      projectId: otherProject.id,
      title: 'Private task',
      intent: 'Remain private',
    });
    assert.throws(
      () => service.getTask(owner, otherTask.id),
      (error: any) => error.code === 'TASK_NOT_FOUND' && error.status === 404,
    );
    assert.throws(
      () => service.getProject(owner, otherProject.id),
      (error: any) => error.code === 'PROJECT_NOT_FOUND' && error.status === 404,
    );
  } finally {
    await runtime.close();
  }
});

test('API key scopes and revocation are enforced', async () => {
  const runtime = await startTestApplication('api-key-scope');
  try {
    const service = runtime.app.service;
    const owner = {
      id: service.owner.userId,
      workspaceId: service.owner.workspaceId,
      type: 'USER' as const,
      scopes: ['*'],
    };
    const created = service.createApiKey(owner, { name: 'read only', scopes: ['tasks:read'] });
    const keyActor = service.authenticateApiKey(created.secret);
    assert.throws(
      () => service.createProject(keyActor, { name: 'Forbidden' }),
      (error: any) => error.code === 'INSUFFICIENT_SCOPE',
    );
    assert.equal(service.revokeApiKey(owner, created.key.id), true);
    assert.throws(
      () => service.authenticateApiKey(created.secret),
      (error: any) => error.code === 'AUTH_REQUIRED',
    );
  } finally {
    await runtime.close();
  }
});

test('session write without CSRF is rejected and security headers are present', async () => {
  const runtime = await startTestApplication('csrf');
  try {
    const auth = await login(runtime.url);
    const response = await fetch(`${runtime.url}/api/v1/projects`, {
      method: 'POST',
      headers: { Cookie: auth.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No CSRF' }),
    });
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.error.code, 'CSRF_REJECTED');
    const landing = await fetch(runtime.url);
    assert.equal(landing.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(landing.headers.get('x-frame-options'), 'DENY');
    assert.match(landing.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  } finally {
    await runtime.close();
  }
});

test('expired session is rejected', async () => {
  const runtime = await startTestApplication('expired-session');
  try {
    const auth = await login(runtime.url);
    runtime.app.service.store.db
      .prepare("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'")
      .run();
    const response = await api<any>(runtime.url, auth, 'GET', '/dashboard');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTH_REQUIRED');
  } finally {
    await runtime.close();
  }
});
