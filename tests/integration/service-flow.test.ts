import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApplication } from '../helpers/runtime.js';

test('self-reported evidence cannot produce VERIFIED, but independently executed evidence can', async () => {
  const runtime = await startTestApplication('service-flow');
  try {
    const service = runtime.app.service;
    const actor = {
      id: service.owner.userId,
      workspaceId: service.owner.workspaceId,
      type: 'USER' as const,
      scopes: ['*'],
    };
    const project = service.createProject(actor, { name: 'Trust test' });

    const selfTask = service.createTask(actor, {
      projectId: project.id,
      title: 'Self report',
      intent: 'Prove an outcome',
    });
    service.generateContract(actor, selfTask.id);
    const selfRun = service.startRun(actor, selfTask.id);
    service.addEvidence(actor, selfRun.id, {
      type: 'JSON',
      value: { outcomeSatisfied: true, forbiddenAction: false },
      source: 'agent',
    });
    service.addEvidence(actor, selfRun.id, {
      type: 'TEST_REPORT',
      value: { status: 'passed' },
      source: 'agent',
    });
    service.addEvidence(actor, selfRun.id, {
      type: 'COMMAND_OUTPUT',
      value: { exitCode: 0 },
      source: 'agent',
    });
    const selfVerdict = await service.verify(actor, selfRun.id);
    assert.equal(selfVerdict.decision.verdict, 'FAILED');

    const observedTask = service.createTask(actor, {
      projectId: project.id,
      title: 'Observed evidence',
      intent: 'Prove an outcome',
    });
    const contract = service.generateContract(actor, observedTask.id);
    const observedRun = service.startRun(actor, observedTask.id);
    const values: Record<string, any> = {
      [contract.acceptanceCriteria[0]!.id]: { type: 'JSON', value: { outcomeSatisfied: true } },
      [contract.acceptanceCriteria[1]!.id]: { type: 'TEST_REPORT', value: { status: 'passed' } },
      [contract.acceptanceCriteria[2]!.id]: { type: 'COMMAND_OUTPUT', value: { exitCode: 0 } },
      [contract.acceptanceCriteria[3]!.id]: { type: 'JSON', value: { forbiddenAction: false } },
    };
    for (const criterion of contract.acceptanceCriteria) {
      const definition = values[criterion.id];
      const evidence = service.evidenceService.createInline({
        workspaceId: actor.workspaceId,
        runId: observedRun.id,
        criterionId: criterion.id,
        type: definition.type,
        value: definition.value,
        source: 'test-runner',
        sourceActor: 'madeproof-runner',
        provenance: 'EXECUTED_BY_MADEPROOF',
      });
      service.store.addEvidence(evidence);
    }
    const observedVerdict = await service.verify(actor, observedRun.id);
    assert.equal(observedVerdict.decision.verdict, 'VERIFIED');
    assert.match(observedVerdict.receipt.digest, /^[a-f0-9]{64}$/);
  } finally {
    await runtime.close();
  }
});

test('locked contract is immutable and retry creates a new run without rewriting history', async () => {
  const runtime = await startTestApplication('immutability');
  try {
    const service = runtime.app.service;
    const actor = {
      id: service.owner.userId,
      workspaceId: service.owner.workspaceId,
      type: 'USER' as const,
      scopes: ['*'],
    };
    const project = service.createProject(actor, { name: 'History' });
    const task = service.createTask(actor, {
      projectId: project.id,
      title: 'History task',
      intent: 'Preserve audit history',
    });
    service.generateContract(actor, task.id);
    const run1 = service.startRun(actor, task.id);
    await service.verify(actor, run1.id);
    assert.throws(
      () => service.updateContract(actor, task.id, { goal: 'retroactively weakened' }),
      (error: any) => error.code === 'CONTRACT_LOCKED',
    );
    const run2 = service.retry(actor, run1.id);
    assert.notEqual(run2.id, run1.id);
    assert.equal(run2.attempt, 2);
    assert.equal(service.getVerdict(actor, run1.id).machine_verdict, 'FAILED');
  } finally {
    await runtime.close();
  }
});
