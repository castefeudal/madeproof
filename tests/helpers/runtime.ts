import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../../apps/api/src/app.js';

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

export async function startTestApplication(label = 'test') {
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
  return {
    app,
    url: started.url,
    dataDir,
    async close() {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
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
