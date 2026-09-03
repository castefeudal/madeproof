import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { api, login, startTestApplication } from '../helpers/runtime.js';

/**
 * Real golden path over production-like components: HTTP API, durable SQLite
 * verification queue, background worker, and an outbound runner agent that
 * executes checks in an isolated sandbox (browser checks use Chromium via CDP).
 * Flow: task -> contract -> run -> FAILED -> fix -> retry -> VERIFIED -> receipt.
 */
const runtime = await startTestApplication('e2e-core', { distributed: true });
try {
  const auth = await login(runtime.url);

  const project = await api<any>(
    runtime.url,
    auth,
    'POST',
    '/projects',
    { name: 'E2E demo', projectType: 'web' },
    { 'Idempotency-Key': 'e2e-project' },
  );
  assert.equal(project.status, 201);
  const replay = await api<any>(
    runtime.url,
    auth,
    'POST',
    '/projects',
    { name: 'E2E demo', projectType: 'web' },
    { 'Idempotency-Key': 'e2e-project' },
  );
  assert.equal(replay.body.id, project.body.id);
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');

  const task = await api<any>(runtime.url, auth, 'POST', '/tasks', {
    projectId: project.body.id,
    title: 'Fix Scenario B selector',
    intent: 'Scenario B must work with pointer and keyboard and preserve its ARIA state.',
    template: 'frontend-bug-fix-demo',
  });
  assert.equal(task.status, 201, JSON.stringify(task.body));

  const contract = await api<any>(
    runtime.url,
    auth,
    'POST',
    `/tasks/${task.body.id}/contracts`,
    {},
  );
  assert.equal(contract.status, 201, JSON.stringify(contract.body));
  assert.equal(contract.body.acceptanceCriteria.length, 7);

  async function verifyAndWait(runId: string, idempotencyKey: string) {
    const accepted = await api<any>(
      runtime.url,
      auth,
      'POST',
      `/runs/${runId}/verify`,
      {},
      { 'Idempotency-Key': idempotencyKey },
    );
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    assert.ok(accepted.body.job, 'verify must return the queued verification job');
    const replayed = await api<any>(
      runtime.url,
      auth,
      'POST',
      `/runs/${runId}/verify`,
      {},
      { 'Idempotency-Key': idempotencyKey },
    );
    assert.equal(replayed.headers.get('idempotency-replayed'), 'true');
    assert.equal(replayed.body.job.id, accepted.body.job.id);

    const deadline = Date.now() + 240_000;
    let state: any;
    while (Date.now() < deadline) {
      state = await api<any>(runtime.url, auth, 'GET', `/runs/${runId}/verification`);
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(state.body.job?.status)) return state.body;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Verification did not finish: ${JSON.stringify(state.body)}`);
  }

  // Run 1: the agent claims success ("Done. Everything works.") but the target
  // is still broken. Independent verification must return FAILED.
  const run1 = await api<any>(runtime.url, auth, 'POST', `/tasks/${task.body.id}/runs`, {
    metadata: { demoFixed: false },
    artifactRef: 'demo-target@broken',
  });
  assert.equal(run1.status, 201, JSON.stringify(run1.body));
  const evidence = await api<any>(runtime.url, auth, 'POST', `/runs/${run1.body.id}/evidence`, {
    type: 'TEXT',
    value: { claim: 'Done. Everything works.' },
    source: 'execution-agent',
  });
  assert.equal(evidence.status, 201);
  assert.equal(evidence.body.provenance, 'SELF_REPORTED');

  const failed = await verifyAndWait(run1.body.id, 'e2e-verify-failed');
  assert.equal(failed.job.status, 'COMPLETED');
  assert.equal(failed.verdict.machine_verdict, 'FAILED');
  assert.equal(failed.results.filter((item: any) => item.status === 'PASSED').length, 5);
  assert.equal(
    failed.results.find((item: any) => item.summary.includes('keyboard'))?.status,
    'FAILED',
  );
  assert.equal(
    failed.results.find((item: any) => item.summary.includes('ARIA state'))?.status,
    'FAILED',
  );
  const failedReceipt = await api<any>(runtime.url, auth, 'GET', `/runs/${run1.body.id}/receipt`);
  assert.equal(failedReceipt.status, 200);
  assert.equal(failedReceipt.body.receipt.verdict.verdict, 'FAILED');
  assert.match(failedReceipt.body.digest, /^[a-f0-9]{64}$/);

  // Run 2: immutable retry with the fix applied. Verification must return VERIFIED.
  const run2 = await api<any>(runtime.url, auth, 'POST', `/runs/${run1.body.id}/retry`, {
    metadata: { demoFixed: true },
    artifactRef: 'demo-target@fixed',
  });
  assert.equal(run2.body.attempt, 2);
  const verified = await verifyAndWait(run2.body.id, 'e2e-verify-passed');
  assert.equal(verified.verdict.machine_verdict, 'VERIFIED');
  assert.equal(verified.results.filter((item: any) => item.status === 'PASSED').length, 7);
  const verifiedReceipt = await api<any>(runtime.url, auth, 'GET', `/runs/${run2.body.id}/receipt`);
  assert.equal(verifiedReceipt.status, 200);
  assert.match(verifiedReceipt.body.digest, /^[a-f0-9]{64}$/);
  assert.equal(verifiedReceipt.body.receipt.verdict.verdict, 'VERIFIED');
  assert.ok(verifiedReceipt.body.receipt.contract.digest, 'receipt must pin the contract digest');
  assert.equal(verifiedReceipt.body.receipt.criteria.every((c: any) => c.result === 'PASSED'), true);

  // History is immutable: the failed run keeps its FAILED verdict and receipt.
  const oldVerdict = await api<any>(runtime.url, auth, 'GET', `/runs/${run1.body.id}/verdict`);
  const newVerdict = await api<any>(runtime.url, auth, 'GET', `/runs/${run2.body.id}/verdict`);
  assert.equal(oldVerdict.body.decision.verdict, 'FAILED');
  assert.equal(newVerdict.body.decision.verdict, 'VERIFIED');

  const report = {
    generatedAt: new Date().toISOString(),
    taskId: task.body.id,
    contractId: contract.body.id,
    failedRun: {
      id: run1.body.id,
      verdict: failed.verdict.machine_verdict,
      passed: 5,
      total: 7,
      receiptDigest: failedReceipt.body.digest,
    },
    retryRun: {
      id: run2.body.id,
      verdict: verified.verdict.machine_verdict,
      passed: 7,
      total: 7,
      receiptDigest: verifiedReceipt.body.digest,
    },
    evidence: verified.results.map((item: any) => ({
      criterionId: item.criterionId,
      status: item.status,
      summary: item.summary,
      evidenceIds: item.evidenceIds,
    })),
  };
  fs.mkdirSync(path.resolve('artifacts'), { recursive: true });
  fs.writeFileSync(path.resolve('artifacts/e2e-core-flow.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      e2e: 'PASS',
      failedRun: report.failedRun,
      retryRun: report.retryRun,
    }),
  );
} finally {
  await runtime.close();
}
