import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { api, login, startTestApplication } from '../helpers/runtime.js';

async function waitForVerification(baseUrl: string, auth: any, runId: string, timeoutMs = 45_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    const response = await api<any>(baseUrl, auth, 'GET', `/runs/${runId}/verification`);
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    assert.equal(response.status, 200);
    last = response.body;
    if (last.verdict) return last;
    if (last.job?.status === 'FAILED' || last.job?.status === 'CANCELLED') throw new Error(`verification job ${last.job.status}: ${JSON.stringify(last.job)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`verification timed out: ${JSON.stringify(last)}`);
}

const runtime = await startTestApplication('e2e-core', { distributed: true });
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
  const queuedFailed = await api<any>(runtime.url, auth, 'POST', `/runs/${run1.body.id}/verify`, {}, { 'Idempotency-Key': 'e2e-verify-failed' });
  assert.equal(queuedFailed.status, 202);
  assert.equal(queuedFailed.body.status, 'QUEUED');
  const failed = await waitForVerification(runtime.url, auth, run1.body.id);
  assert.equal(failed.verdict.machine_verdict, 'FAILED', JSON.stringify(failed, null, 2));
  assert.equal(failed.results.filter((item: any) => item.status === 'PASSED').length, 5, JSON.stringify(failed.results, null, 2));
  assert.equal(failed.results.find((item: any) => item.summary.toLowerCase().includes('keyboard'))?.status, 'FAILED', JSON.stringify(failed.results, null, 2));
  assert.equal(failed.results.find((item: any) => item.summary.includes('ARIA state'))?.status, 'FAILED', JSON.stringify(failed.results, null, 2));

  const run2 = await api<any>(runtime.url, auth, 'POST', `/runs/${run1.body.id}/retry`, { metadata: { demoFixed: true }, artifactRef: 'demo-target@fixed' });
  assert.equal(run2.body.attempt, 2);
  const queuedVerified = await api<any>(runtime.url, auth, 'POST', `/runs/${run2.body.id}/verify`, {}, { 'Idempotency-Key': 'e2e-verify-passed' });
  assert.equal(queuedVerified.status, 202);
  const verified = await waitForVerification(runtime.url, auth, run2.body.id);
  assert.equal(verified.verdict.machine_verdict, 'VERIFIED', JSON.stringify(verified, null, 2));
  assert.equal(verified.results.filter((item: any) => item.status === 'PASSED').length, 7, JSON.stringify(verified.results, null, 2));
  const receiptResponse = await api<any>(runtime.url, auth, 'GET', `/runs/${run2.body.id}/receipt`);
  assert.equal(receiptResponse.status, 200);
  assert.match(receiptResponse.body.digest, /^[a-f0-9]{64}$/);

  const oldVerdict = await api<any>(runtime.url, auth, 'GET', `/runs/${run1.body.id}/verdict`);
  const newVerdict = await api<any>(runtime.url, auth, 'GET', `/runs/${run2.body.id}/verdict`);
  assert.equal(oldVerdict.body.machine_verdict, 'FAILED');
  assert.equal(newVerdict.body.machine_verdict, 'VERIFIED');

  const failedReceipt = await api<any>(runtime.url, auth, 'GET', `/runs/${run1.body.id}/receipt`);
  const report = {
    generatedAt: new Date().toISOString(),
    taskId: task.body.id,
    contractId: contract.body.id,
    failedRun: { id: run1.body.id, verdict: failed.verdict.machine_verdict, passed: 5, total: 7, receiptDigest: failedReceipt.body.digest },
    retryRun: { id: run2.body.id, verdict: verified.verdict.machine_verdict, passed: 7, total: 7, receiptDigest: receiptResponse.body.digest },
    evidence: verified.results.map((item: any) => ({ criterionId: item.criterionId, status: item.status, summary: item.summary, evidenceIds: item.evidenceIds }))
  };
  fs.mkdirSync(path.resolve('artifacts'), { recursive: true });
  fs.writeFileSync(path.resolve('artifacts/e2e-core-flow.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await runtime.close();
}
