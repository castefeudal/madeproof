import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../../apps/api/src/app.js';
import { SqliteDistributedStore } from '../../packages/db/src/sqlite-distributed-store.js';
import { EvidenceService } from '../../packages/evidence/src/evidence-service.js';
import { VerificationWorker } from '../../apps/worker/src/worker.js';
import { RunnerAgent } from '../../apps/runner/src/agent.js';

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function startTestApplication(label = 'test', options: { distributed?: boolean } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `madeproof-${label}-`));
  const port = await freePort();
  const app = createApplication({
    env: 'test', host: '127.0.0.1', port, dataDir, publicBaseUrl: `http://127.0.0.1:${port}`,
    adminEmail: 'owner@example.test', adminPassword: 'correct horse battery staple',
    sessionSecret: 'test-session-secret-is-at-least-thirty-two-characters',
    encryptionKey: 'test-encryption-key-is-at-least-thirty-two-characters', databaseKind: 'sqlite'
  });
  const started = await app.start();
  let workerStore: SqliteDistributedStore | undefined;
  let worker: VerificationWorker | undefined;
  let runner: RunnerAgent | undefined;
  let workerLoop: Promise<void> | undefined;
  let runnerLoop: Promise<void> | undefined;
  if (options.distributed) {
    const actor = { id: app.service.owner.userId, workspaceId: app.service.owner.workspaceId, type: 'USER' as const, scopes: ['*'] };
    const capabilities = ['command', 'build', 'test_suite', 'browser', 'accessibility', 'file', 'http'];
    const registration = await app.service.createRunner(actor, { name: `test-runner-${label}`, version: '0.1.0', capabilities });
    workerStore = new SqliteDistributedStore(dataDir);
    await workerStore.migrate();
    worker = new VerificationWorker(workerStore, new EvidenceService(dataDir), { workerId: `test-worker-${label}`, leaseSeconds: 5, idleDelayMs: 20, runnerPollDelayMs: 20, runnerWaitMaxMs: 30_000, baseUrl: started.url, projectRoot: path.resolve('.') });
    runner = new RunnerAgent({ baseUrl: started.url, credential: registration.secret, version: '0.1.0', capabilities, allowedRoots: [path.resolve('.')], pollIntervalMs: 20, allowRootProcess: typeof process.getuid === 'function' && process.getuid() === 0, allowWeakIsolationFallback: true });
    workerLoop = worker.runLoop();
    runnerLoop = runner.runLoop();
  }
  return {
    app, url: started.url, dataDir,
    async close() {
      runner?.stop(); worker?.stop();
      await Promise.allSettled([runnerLoop, workerLoop].filter(Boolean) as Promise<void>[]);
      if (workerStore) await workerStore.close();
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };
}

export async function waitForServiceVerification(service: any, actor: any, runId: string, timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = await service.getVerification(actor, runId);
    if (last?.verdict) return last;
    if (last?.job?.status === 'FAILED' || last?.job?.status === 'CANCELLED') throw new Error(`Verification job ended as ${last.job.status}: ${JSON.stringify(last.job)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for verification: ${JSON.stringify(last)}`);
}

export async function login(baseUrl: string): Promise<{ cookie: string; csrf: string; user: any; workspace: any }> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.test', password: 'correct horse battery staple' }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`Login failed: ${JSON.stringify(body)}`);
  const setCookie = response.headers.get('set-cookie') ?? '';
  return { cookie: setCookie.split(';')[0]!, csrf: body.csrfToken, user: body.user, workspace: body.workspace };
}

export async function api<T = any>(baseUrl: string, auth: { cookie: string; csrf: string }, method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: any }> {
  const response = await fetch(`${baseUrl}/api/v1${pathname}`, { method, headers: { Accept: 'application/json', Cookie: auth.cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(['GET', 'HEAD'].includes(method) ? {} : { 'X-CSRF-Token': auth.csrf }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, body: payload as T, headers: response.headers };
}

export async function createFullScopeApiKey(baseUrl: string, auth: { cookie: string; csrf: string }): Promise<string> {
  const response = await api<any>(baseUrl, auth, 'POST', '/api-keys', { name: 'integration key', scopes: ['projects:read', 'projects:write', 'tasks:read', 'tasks:write', 'evidence:write', 'verification:run', 'receipts:read'] });
  if (response.status !== 201) throw new Error(`API key creation failed: ${JSON.stringify(response.body)}`);
  return response.body.secret;
}
