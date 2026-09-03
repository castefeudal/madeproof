import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../../apps/api/src/app.js';
import { RunnerAgent } from '../../apps/runner/src/agent.js';
import { VerificationWorker } from '../../apps/worker/src/worker.js';
import { EvidenceService } from '../../packages/evidence/src/evidence-service.js';
import type { Actor, MadeProofService } from '../../packages/core/src/service.js';
import { SqliteStore } from '../../packages/db/src/sqlite-store.js';

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

export interface TestRuntime {
  app: ReturnType<typeof createApplication>;
  url: string;
  dataDir: string;
  worker?: VerificationWorker;
  runner?: RunnerAgent;
  close(): Promise<void>;
}

export interface StartTestOptions {
  /**
   * Also start a real in-process verification worker and an outbound runner
   * agent that talks to the API over HTTP, mirroring the production topology.
   */
  distributed?: boolean;
}

export async function startTestApplication(
  label = 'test',
  options: StartTestOptions = {},
): Promise<TestRuntime> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `madeproof-${label}-`));
  const port = await freePort();
  const app = createApplication({
    env: 'test',
    host: '127.0.0.1',
    port,
    dataDir,
    publicBaseUrl: `http://127.0.0.1:${port}`,
    adminEmail: 'owner@example.test',
    adminPassword: 'correct horse battery staple',
    sessionSecret: 'test-session-secret-is-at-least-thirty-two-characters',
    encryptionKey: 'test-encryption-key-is-at-least-thirty-two-characters',
    databaseKind: 'sqlite',
  });
  const started = await app.start();
  let worker: VerificationWorker | undefined;
  let runner: RunnerAgent | undefined;
  if (options.distributed) {
    const service = app.service;
    const owner: Actor = {
      id: service.owner.userId,
      workspaceId: service.owner.workspaceId,
      type: 'USER',
      scopes: ['*'],
    };
    const capabilities = ['command', 'build', 'test_suite', 'browser', 'accessibility', 'file', 'http'];
    const registration = await service.createRunner(owner, {
      name: `test-runner-${label}`,
      version: '0.1.0',
      capabilities,
    });
    runner = new RunnerAgent({
      baseUrl: started.url,
      credential: registration.secret,
      version: '0.1.0',
      capabilities,
      allowedRoots: [process.cwd()],
      allowRootProcess: typeof process.getuid === 'function' && process.getuid() === 0,
      pollIntervalMs: 10,
    });
    runner.runLoop().catch(() => {});
    worker = new VerificationWorker(new SqliteStore(dataDir), new EvidenceService(dataDir), {
      workerId: `test-worker-${label}`,
      leaseSeconds: 5,
      baseUrl: started.url,
      projectRoot: process.cwd(),
      idleDelayMs: 10,
      runnerPollDelayMs: 10,
      runnerWaitMaxMs: 20000,
    });
    worker.runLoop().catch(() => {});
  }
  return {
    app,
    url: started.url,
    dataDir,
    worker,
    runner,
    async close() {
      runner?.stop();
      worker?.stop();
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/** Poll service.getVerification until the verification job leaves an active state. */
export async function waitForServiceVerification(
  service: MadeProofService,
  actor: { id: string; workspaceId: string; type: 'USER'; scopes: string[] },
  runId: string,
  timeoutMs = 10000,
): Promise<{ job: any; results: any[]; verdict: any }> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = await service.getVerification(actor, runId);
    if (last.job && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(last.job.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Verification did not finish within ${timeoutMs}ms; last state: ${JSON.stringify(last?.job ?? null)}`,
  );
}

/**
 * Enqueue verification, run one real worker pass over the same data directory,
 * then wait for the job to reach a final state. Uses only evidence checks, so
 * no runner is required.
 */
export async function runServiceVerification(
  service: MadeProofService,
  actor: { id: string; workspaceId: string; type: 'USER'; scopes: string[] },
  runId: string,
  timeoutMs = 10000,
): Promise<{ job: any; results: any[]; verdict: any }> {
  await service.verify(actor, runId);
  const dataDir = service.config.dataDir;
  const worker = new VerificationWorker(new SqliteStore(dataDir), new EvidenceService(dataDir), {
    workerId: 'test-inline-worker',
    leaseSeconds: 5,
    baseUrl: service.config.publicBaseUrl,
    projectRoot: process.cwd(),
    runnerPollDelayMs: 10,
    runnerWaitMaxMs: 1000,
  });
  try {
    assert.equal(await worker.runOnce(), true);
  } finally {
    worker.stop();
  }
  return await waitForServiceVerification(service, actor, runId, timeoutMs);
}

export async function login(
  baseUrl: string,
): Promise<{ cookie: string; csrf: string; user: any; workspace: any }> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password: 'correct horse battery staple' }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Login failed: ${JSON.stringify(body)}`);
  const setCookie = response.headers.get('set-cookie') ?? '';
  return {
    cookie: setCookie.split(';')[0]!,
    csrf: body.csrfToken,
    user: body.user,
    workspace: body.workspace,
  };
}

export async function api<T = any>(
  baseUrl: string,
  auth: { cookie: string; csrf: string },
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T; headers: any }> {
  const response = await fetch(`${baseUrl}/api/v1${pathname}`, {
    method,
    headers: {
      Accept: 'application/json',
      Cookie: auth.cookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(['GET', 'HEAD'].includes(method) ? {} : { 'X-CSRF-Token': auth.csrf }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, body: payload as T, headers: response.headers };
}

export async function createFullScopeApiKey(
  baseUrl: string,
  auth: { cookie: string; csrf: string },
): Promise<string> {
  const response = await api<any>(baseUrl, auth, 'POST', '/api-keys', {
    name: 'integration key',
    scopes: [
      'projects:read',
      'projects:write',
      'tasks:read',
      'tasks:write',
      'evidence:write',
      'verification:run',
      'receipts:read',
    ],
  });
  if (response.status !== 201)
    throw new Error(`API key creation failed: ${JSON.stringify(response.body)}`);
  return response.body.secret;
}
