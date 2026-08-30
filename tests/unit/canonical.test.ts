import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, sha256, timingSafeEqualText } from '../../packages/shared/src/canonical.js';

test('canonical JSON is stable across key insertion order', () => {
  const a = canonicalJson({ z: 1, nested: { b: 2, a: 1 }, items: [3, 2, 1] });
  const b = canonicalJson({ items: [3, 2, 1], nested: { a: 1, b: 2 }, z: 1 });
  assert.equal(a, b);
  assert.equal(sha256(a), sha256(b));
});

test('timing-safe text comparison handles same and different values', () => {
  assert.equal(timingSafeEqualText('proof', 'proof'), true);
  assert.equal(timingSafeEqualText('proof', 'claim'), false);
  assert.equal(timingSafeEqualText('short', 'longer'), false);
});
