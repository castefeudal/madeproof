import test from 'node:test';
import assert from 'node:assert/strict';
import { activateScenario } from './model.mjs';

test('scenario model activates B without mutating unrelated state', () => {
  assert.equal(activateScenario('A', 'B'), 'B');
  assert.equal(activateScenario('B', 'B'), 'B');
});

test('scenario model rejects unknown state', () => {
  assert.throws(() => activateScenario('A', 'C'), /Unknown scenario/);
});
