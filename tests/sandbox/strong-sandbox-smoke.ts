import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeCommandRunner } from '../../apps/runner/src/command-runner.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'madeproof-strong-sandbox-')),
  previous = process.env.MADEPROOF_SANDBOX_SECRET;
process.env.MADEPROOF_SANDBOX_SECRET = 'must-not-enter-sandbox';
try {
  fs.writeFileSync(path.join(root, 'payload.txt'), 'sandbox-ok');
  const runner = new SafeCommandRunner({ allowedRoots: [root] }),
    script = `const fs=require('fs');if(fs.existsSync('/app'))process.exit(42);if(process.env.MADEPROOF_SANDBOX_SECRET)process.exit(43);process.stdout.write(fs.readFileSync('payload.txt','utf8'));`,
    result = await runner.execute({
      command: 'node',
      args: ['-e', script],
      cwd: root,
      timeoutMs: 5000,
      network: 'disabled',
    });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, 'sandbox-ok');
  assert.ok(result.isolation.includes('bubblewrap-user-mount-pid-ipc-uts-cgroup-namespaces'));
  assert.ok(result.isolation.includes('filesystem-allowlist'));
  assert.ok(result.isolation.includes('network-namespace'));
  console.log(JSON.stringify({ strongSandbox: 'PASS', isolation: result.isolation }));
} finally {
  if (previous === undefined) delete process.env.MADEPROOF_SANDBOX_SECRET;
  else process.env.MADEPROOF_SANDBOX_SECRET = previous;
  fs.rmSync(root, { recursive: true, force: true });
}
