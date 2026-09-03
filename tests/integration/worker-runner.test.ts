import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApplication, waitForServiceVerification } from '../helpers/runtime.js';
import { VerificationWorker } from '../../apps/worker/src/worker.js';
import { SqliteStore } from '../../packages/db/src/sqlite-store.js';
import { EvidenceService } from '../../packages/evidence/src/evidence-service.js';

test('control plane queues verification but cannot execute it without a worker', async () => {
  const r = await startTestApplication('queue-only');
  try {
    const s = r.app.service,
      a = {
        id: s.owner.userId,
        workspaceId: s.owner.workspaceId,
        type: 'USER' as const,
        scopes: ['*'],
      },
      p = await s.createProject(a, { name: 'Queue boundary' }),
      t = await s.createTask(a, {
        projectId: p.id,
        title: 'Queued only',
        intent: 'Control plane must not execute checks',
      });
    await s.generateContract(a, t.id);
    const run = await s.startRun(a, t.id),
      job = await s.verify(a, run.id);
    assert.equal(job.status, 'QUEUED');
    await new Promise((x) => setTimeout(x, 120));
    const state = await s.getVerification(a, run.id);
    assert.equal(state.job.status, 'QUEUED');
    assert.equal(state.results.length, 0);
    assert.equal(state.verdict, null);
  } finally {
    await r.close();
  }
});

test('worker reclaims stale verification lease and completes without duplicate result', async () => {
  const r = await startTestApplication('worker-recovery'),
    crashed = new SqliteStore(r.dataDir),
    recovery = new SqliteStore(r.dataDir);
  try {
    crashed.migrate();
    recovery.migrate();
    const s = r.app.service,
      a = {
        id: s.owner.userId,
        workspaceId: s.owner.workspaceId,
        type: 'USER' as const,
        scopes: ['*'],
      },
      p = await s.createProject(a, { name: 'Recovery' }),
      t = await s.createTask(a, {
        projectId: p.id,
        title: 'Recover stale job',
        intent: 'Verification resumes after worker crash',
      }),
      c = await s.generateContract(a, t.id),
      run = await s.startRun(a, t.id),
      trusted = [
        { type: 'JSON', value: { outcomeSatisfied: true } },
        { type: 'TEST_REPORT', value: { status: 'passed' } },
        { type: 'COMMAND_OUTPUT', value: { exitCode: 0 } },
        { type: 'JSON', value: { forbiddenAction: false } },
      ];
    for (let i = 0; i < c.acceptanceCriteria.length; i++) {
      const criterion = c.acceptanceCriteria[i]!,
        d = trusted[i]!,
        e = s.evidenceService.createInline({
          workspaceId: a.workspaceId,
          runId: run.id,
          criterionId: criterion.id,
          type: d.type,
          value: d.value,
          source: 'fixture',
          sourceActor: 'trusted',
          provenance: 'EXECUTED_BY_MADEPROOF',
        });
      await s.store.addEvidence(e);
    }
    await s.verify(a, run.id);
    const lease = await crashed.claimVerificationJob('crashed-worker', 1);
    assert.ok(lease);
    await new Promise((x) => setTimeout(x, 1150));
    const worker = new VerificationWorker(recovery, new EvidenceService(r.dataDir), {
      workerId: 'recovery-worker',
      leaseSeconds: 2,
      baseUrl: r.url,
      projectRoot: process.cwd(),
      idleDelayMs: 10,
      runnerPollDelayMs: 10,
      runnerWaitMaxMs: 1000,
    });
    assert.equal(await worker.runOnce(), true);
    const f = await waitForServiceVerification(s, a, run.id, 5000);
    assert.equal(f.job.status, 'COMPLETED');
    assert.equal(Number(f.job.attempt), 2);
    assert.equal(f.verdict.machine_verdict, 'VERIFIED');
  } finally {
    crashed.close();
    recovery.close();
    await r.close();
  }
});

test('verification cancellation is durable', async () => {
  const r = await startTestApplication('cancel-job');
  try {
    const s = r.app.service,
      a = {
        id: s.owner.userId,
        workspaceId: s.owner.workspaceId,
        type: 'USER' as const,
        scopes: ['*'],
      },
      p = await s.createProject(a, { name: 'Cancellation' }),
      t = await s.createTask(a, {
        projectId: p.id,
        title: 'Cancel verification',
        intent: 'Cancellation must be durable',
      });
    await s.generateContract(a, t.id);
    const run = await s.startRun(a, t.id);
    await s.verify(a, run.id);
    assert.equal(await s.cancelVerification(a, run.id), true);
    const state = await s.getVerification(a, run.id);
    assert.equal(state.job.status, 'CANCELLED');
    assert.equal((await s.getRun(a, run.id)).status, 'CANCELLED');
    assert.equal((await s.getTask(a, t.id)).status, 'CANCELLED');
  } finally {
    await r.close();
  }
});

test('distributed worker and outbound runner execute a real isolated command', async () => {
  const r = await startTestApplication('runner-command', { distributed: true });
  try {
    const s = r.app.service,
      a = {
        id: s.owner.userId,
        workspaceId: s.owner.workspaceId,
        type: 'USER' as const,
        scopes: ['*'],
      },
      p = await s.createProject(a, { name: 'Runner command' }),
      t = await s.createTask(a, {
        projectId: p.id,
        title: 'Execute command',
        intent: 'Runner executes an isolated deterministic command',
      }),
      g = await s.generateContract(a, t.id),
      criterion = {
        ...g.acceptanceCriteria[0]!,
        id: 'crit_runner_command',
        title: 'Runner command exits successfully',
        description: 'A command executes outside control plane',
        verificationType: 'command' as const,
        category: 'test' as const,
        expected: {
          command: 'node',
          args: ['-e', "process.stdout.write('runner-ok')"],
          network: 'disabled',
        },
        evidenceRequirements: ['COMMAND_OUTPUT'],
        timeoutSeconds: 10,
        retryPolicy: { maxAttempts: 2, backoffMs: 0 },
        position: 1,
      };
    await s.updateContract(a, t.id, {
      acceptanceCriteria: [criterion],
      verificationStrategy: [`command:${criterion.id}`],
      requiredEvidence: ['COMMAND_OUTPUT'],
    });
    const run = await s.startRun(a, t.id);
    await s.verify(a, run.id);
    const v = await waitForServiceVerification(s, a, run.id, 15000);
    assert.equal(v.verdict.machine_verdict, 'VERIFIED');
    assert.equal(v.results[0].status, 'PASSED');
    assert.equal(v.results[0].details.stdout, 'runner-ok');
    assert.ok(v.results[0].details.isolation.includes('environment-allowlist'));
  } finally {
    await r.close();
  }
});
