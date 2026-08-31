import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { api, login, startTestApplication } from '../helpers/runtime.js';

const runtime = await startTestApplication('e2e-core');
try {
  const auth = await login(runtime.url);
  const project = await api<any>(runtime.url, auth, 'POST', '/projects', { name: 'E2E demo', projectType: 'web' }, { 'Idempotency-Key': 'e2e-project' });
  assert.equal(project.status, 201);
  const replay = await api<any>(runtime.url, auth, 'POST', '/projects', { name: 'E2E demo', projectType: 'web' }, { 'Idempotency-Key': 'e2e-project' });
  assert.equal(replay.body.id, project.body.id);
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');

  const task = await api<any>(runtime.url, auth, 'POST', '/tasks', { projectId: project.body.id, title: 'Fix Scenario B selector', intent: 'Scenario B must work with pointer and keyboard and preserve its ARIA state.', template: 'frontend-bug-fix-demo' });
  const contract = await api<any>(runtime.url, auth, 'POST', `/tasks/${task.body.id}/contracts`, {});
  assert.equal(contract.body.acceptanceCriteria.length, 7);
  const run1 = await api<any>(runtime.url, auth, 'POST', `/tasks/${task.body.id}/runs`, { metadata: { demoFixed: false }, artifactRef: 'demo-target@broken' });
  await api(runtime.url, auth, 'POST', `/runs/${run1.body.id}/evidence`, { type: 'TEXT', value: { claim: 'Done. Everything works.' }, source: 'execution-agent' });
  const failed = await api<any>(runtime.url, auth, 'POST', `/runs/${run1.body.id}/verify`, {}, { 'Idempotency-Key': 'e2e-verify-failed' });
  assert.equal(failed.body.decision.verdict, 'FAILED');
  assert.equal(failed.body.results.filter((item: any) => item.status === 'PASSED').length, 5);
  assert.equal(failed.body.results.find((item: any) => item.summary.includes('keyboard'))?.status, 'FAILED');
  assert.equal(failed.body.results.find((item: any) => item.summary.includes('ARIA state'))?.status, 'FAILED');

  const run2 = await api<any>(runtime.url, auth, 'POST', `/runs/${run1.body.id}/retry`, { metadata: { demoFixed: true }, artifactRef: 'demo-target@fixed' });
  assert.equal(run2.body.attempt, 2);
  const verified = await api<any>(runtime.url, auth, 'POST', `/runs/${run2.body.id}/verify`, {}, { 'Idempotency-Key': 'e2e-verify-passed' });
  assert.equal(verified.body.decision.verdict, 'VERIFIED');
  assert.equal(verified.body.results.filter((item: any) => item.status === 'PASSED').length, 7);
  assert.match(verified.body.receipt.digest, /^[a-f0-9]{64}$/);

  const oldVerdict = await api<any>(runtime.url, auth, 'GET', `/runs/${run1.body.id}/verdict`);
  const newVerdict = await api<any>(runtime.url, auth, 'GET', `/runs/${run2.body.id}/verdict`);
  assert.equal(oldVerdict.body.machine_verdict, 'FAILED');
  assert.equal(newVerdict.body.machine_verdict, 'VERIFIED');

  const report = {
    generatedAt: new Date().toISOString(),
    taskId: task.body.id,
    contractId: contract.body.id,
    failedRun: { id: run1.body.id, verdict: failed.body.decision.verdict, passed: 5, total: 7, receiptDigest: failed.body.receipt.digest },
    retryRun: { id: run2.body.id, verdict: verified.body.decision.verdict, passed: 7, total: 7, receiptDigest: verified.body.receipt.digest },
    evidence: verified.body.results.map((item: any) => ({ criterionId: item.criterionId, status: item.status, summary: item.summary, evidenceIds: item.evidenceIds }))
  };
  fs.mkdirSync(path.resolve('artifacts'), { recursive: true });
  fs.writeFileSync(path.resolve('artifacts/e2e-core-flow.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await runtime.close();
}
