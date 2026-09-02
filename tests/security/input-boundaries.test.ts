import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { validateExternalUrl } from '../../packages/security/src/url-policy.js';
import { EvidenceService } from '../../packages/evidence/src/evidence-service.js';

test('URL policy blocks unsafe schemes, credentials, loopback and metadata targets', async () => {
  await assert.rejects(
    () => validateExternalUrl('file:///etc/passwd'),
    (error: any) => error.code === 'URL_SCHEME_FORBIDDEN',
  );
  await assert.rejects(
    () => validateExternalUrl('http://user:pass@example.com'),
    (error: any) => error.code === 'URL_CREDENTIALS_FORBIDDEN',
  );
  await assert.rejects(
    () => validateExternalUrl('http://127.0.0.1:3000'),
    (error: any) => error.code === 'SSRF_BLOCKED',
  );
  await assert.rejects(
    () => validateExternalUrl('http://169.254.169.254/latest/meta-data'),
    (error: any) => error.code === 'SSRF_BLOCKED',
  );
  const local = await validateExternalUrl('http://127.0.0.1:3000', { allowLocal: true });
  assert.equal(local.hostname, '127.0.0.1');
});

test('evidence file names cannot traverse storage and uploads are bounded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'madeproof-evidence-test-'));
  try {
    const service = new EvidenceService(root);
    assert.throws(
      () =>
        service.createFile({
          workspaceId: 'w',
          runId: 'r',
          type: 'FILE',
          bytes: new Uint8Array([1]),
          extension: '../sh',
          source: 'test',
          sourceActor: 'test',
          provenance: 'IMPORTED',
          mimeType: 'application/octet-stream',
        }),
      (error: any) => error.code === 'INVALID_FILE_EXTENSION',
    );
    assert.throws(
      () =>
        service.createInline({
          workspaceId: 'w',
          runId: 'r',
          type: 'TEXT',
          value: 'x'.repeat(600_000),
          source: 'test',
          sourceActor: 'test',
          provenance: 'IMPORTED',
        }),
      (error: any) => error.code === 'EVIDENCE_TOO_LARGE',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
