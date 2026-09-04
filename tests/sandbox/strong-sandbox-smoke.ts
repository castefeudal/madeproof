import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeCommandRunner, BWRAP_PATHS, supportsCgroupNamespace } from '../../apps/runner/src/command-runner.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'madeproof-strong-sandbox-'));
const previous = process.env.MADEPROOF_SANDBOX_SECRET;
process.env.MADEPROOF_SANDBOX_SECRET = 'must-not-enter-sandbox';

try {
  fs.writeFileSync(path.join(root, 'payload.txt'), 'sandbox-ok');
  // When the host itself runs as root (local dev containers), explicitly allow
  // the outer process; Bubblewrap still remaps the user inside the sandbox.
  const allowRootProcess = typeof process.getuid === 'function' && process.getuid() === 0;
  const runner = new SafeCommandRunner({ allowedRoots: [root], allowRootProcess });
  const script = `const fs=require('fs');if(fs.existsSync('/app'))process.exit(42);if(process.env.MADEPROOF_SANDBOX_SECRET)process.exit(43);process.stdout.write(fs.readFileSync('payload.txt','utf8'));`;
  // GitHub-hosted Ubuntu blocks configuring loopback inside an unprivileged
  // nested network namespace. This smoke therefore validates the real bwrap
  // user/mount/pid/ipc/uts + filesystem boundary with networking left
  // enabled. SafeCommandRunner still adds --unshare-net whenever a production
  // check requests network:'disabled'; that branch is covered by code/security tests.
  const result = await runner.execute({ command: 'node', args: ['-e', script], cwd: root, timeoutMs: 5000, network: 'enabled' });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, 'sandbox-ok');
  // The base user/mount/pid/ipc/uts boundary is mandatory.
  assert.ok(result.isolation.includes('bubblewrap-user-mount-pid-ipc-uts-namespaces'));
  // cgroup namespace is capability-dependent: the isolation report may only
  // claim it when the kernel actually supports it, and must never claim it
  // otherwise. This mirrors the production capability detection exactly.
  const bwrap = BWRAP_PATHS.map((candidate) => {
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch {
      return null;
    }
  }).find(Boolean);
  assert.ok(bwrap, 'bubblewrap must be installed for the strong sandbox smoke');
  if (supportsCgroupNamespace(bwrap)) {
    assert.ok(result.isolation.includes('cgroup-namespace'));
  } else {
    assert.ok(!result.isolation.includes('cgroup-namespace'));
  }
  assert.ok(result.isolation.includes('filesystem-allowlist'));
  assert.ok(!result.isolation.includes('weak-isolation-fallback'));
  console.log(JSON.stringify({ strongSandbox: 'PASS', isolation: result.isolation, networkNamespace: 'covered separately' }));
} finally {
  if (previous === undefined) delete process.env.MADEPROOF_SANDBOX_SECRET;
  else process.env.MADEPROOF_SANDBOX_SECRET = previous;
  fs.rmSync(root, { recursive: true, force: true });
}
