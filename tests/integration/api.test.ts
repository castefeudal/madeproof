import test from 'node:test';
import assert from 'node:assert/strict';
import { api, login, startTestApplication } from '../helpers/runtime.js';

test('write endpoints are idempotent and conflicting replay is rejected', async () => {
  const runtime = await startTestApplication('api-idempotency');
  try {
    const auth = await login(runtime.url);
    const headers = { 'Idempotency-Key': 'same-project-request' };
    const first = await api<any>(runtime.url, auth, 'POST', '/projects', { name: 'Idempotent project' }, headers);
    const second = await api<any>(runtime.url, auth, 'POST', '/projects', { name: 'Idempotent project' }, headers);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.body.id, first.body.id);
    assert.equal(second.headers.get('idempotency-replayed'), 'true');
    const conflict = await api<any>(runtime.url, auth, 'POST', '/projects', { name: 'Different project' }, headers);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
    const projects = await api<any>(runtime.url, auth, 'GET', '/projects');
    assert.equal(projects.body.items.length, 1);
  } finally { await runtime.close(); }
});

test('health and OpenAPI endpoints expose executable service state', async () => {
  const runtime = await startTestApplication('api-health');
  try {
    const live = await fetch(`${runtime.url}/health/live`);
    const ready = await fetch(`${runtime.url}/health/ready`);
    const schema = await fetch(`${runtime.url}/api/v1/openapi.json`);
    assert.equal(live.status, 200);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).status, 'ready');
    assert.equal((await schema.json()).info.title, 'MADEPROOF API');
  } finally { await runtime.close(); }
});
