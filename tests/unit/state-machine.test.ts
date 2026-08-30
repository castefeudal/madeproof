import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRunTransition, assertTaskTransition } from '../../packages/domain/src/state-machine.js';

test('task state machine allows the intended lifecycle', () => {
  assert.doesNotThrow(() => assertTaskTransition('DRAFT', 'READY'));
  assert.doesNotThrow(() => assertTaskTransition('READY', 'IN_PROGRESS'));
  assert.doesNotThrow(() => assertTaskTransition('IN_PROGRESS', 'AWAITING_EVIDENCE'));
  assert.doesNotThrow(() => assertTaskTransition('AWAITING_EVIDENCE', 'VERIFYING'));
  assert.doesNotThrow(() => assertTaskTransition('VERIFYING', 'VERIFIED'));
  assert.doesNotThrow(() => assertTaskTransition('VERIFIED', 'IN_PROGRESS'));
});

test('UI or handler cannot jump directly to VERIFIED', () => {
  assert.throws(() => assertTaskTransition('READY', 'VERIFIED'), (error: any) => error.code === 'INVALID_TASK_TRANSITION');
  assert.throws(() => assertTaskTransition('AWAITING_EVIDENCE', 'VERIFIED'), (error: any) => error.code === 'INVALID_TASK_TRANSITION');
});

test('completed runs are immutable terminal history', () => {
  assert.throws(() => assertRunTransition('COMPLETED', 'VERIFYING'), (error: any) => error.code === 'INVALID_RUN_TRANSITION');
  assert.doesNotThrow(() => assertRunTransition('AWAITING_EVIDENCE', 'VERIFYING'));
  assert.doesNotThrow(() => assertRunTransition('VERIFYING', 'COMPLETED'));
});
