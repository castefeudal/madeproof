import http from 'node:http';
import path from 'node:path';
import url from 'node:url';
import { loadConfig, type RuntimeConfig } from '../../../packages/config/src/runtime.js';
import { SqliteStore } from '../../../packages/db/src/sqlite-store.js';
import { EvidenceService } from '../../../packages/evidence/src/evidence-service.js';
import { VerificationEngine } from '../../../packages/verification/src/engine.js';
import { SafeCommandRunner } from '../../runner/src/command-runner.js';
import { MadeProofService, type Actor } from '../../../packages/core/src/service.js';
import { securityHeaders } from '../../../packages/security/src/headers.js';
import { RateLimiter } from '../../../packages/security/src/rate-limit.js';
import { hashToken } from '../../../packages/security/src/crypto.js';
import { canonicalJson, sha256 } from '../../../packages/shared/src/canonical.js';
import { asMadeProofError, MadeProofError } from '../../../packages/shared/src/errors.js';
import { newId } from '../../../packages/shared/src/ids.js';
import { requiredString } from '../../../packages/shared/src/validation.js';
import { parseCookies, readJson, sendJson, sendText, serveStatic } from './http-utils.js';
import { openApiDocument } from './openapi.js';
import { handleMcpHttp } from '../../mcp/src/protocol.js';

export interface Application {
  server: any;
  service: MadeProofService;
  config: RuntimeConfig;
  start(): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

function setCommonHeaders(response: any, config: RuntimeConfig, requestId: string): void {
  response.setHeader('X-Request-Id', requestId);
  for (const [key, value] of Object.entries(securityHeaders(config.env === 'production')))
    response.setHeader(key, value);
}

function scopeFor(method: string, pathname: string): string | undefined {
  if (pathname.includes('/receipts/')) return 'receipts:read';
  if (pathname.includes('/verify') || pathname.includes('/retry')) return 'verification:run';
  if (pathname.includes('/evidence') && method === 'POST') return 'evidence:write';
  if (pathname.startsWith('/api/v1/projects'))
    return method === 'GET' ? 'projects:read' : 'projects:write';
  if (
    pathname === '/api/v1/dashboard' ||
    pathname === '/api/v1/attention' ||
    pathname === '/api/v1/agent-reliability'
  )
    return 'tasks:read';
  if (pathname.startsWith('/api/v1/tasks') || pathname.startsWith('/api/v1/runs'))
    return method === 'GET' ? 'tasks:read' : 'tasks:write';
  return undefined;
}

function authenticate(
  service: MadeProofService,
  request: any,
  requiredScope?: string,
): { actor: Actor; session?: any; sessionToken?: string } {
  const authorization = String(request.headers.authorization ?? '');
  if (authorization.startsWith('Bearer '))
    return { actor: service.authenticateApiKey(authorization.slice(7), requiredScope) };
  const sessionToken = parseCookies(request.headers.cookie).mp_session;
  if (!sessionToken) throw new MadeProofError('AUTH_REQUIRED', 'Authentication is required', 401);
  const session = service.store.getSession(hashToken(sessionToken));
  if (!session) throw new MadeProofError('AUTH_REQUIRED', 'Session is invalid or expired', 401);
  return { actor: service.authenticateSession(sessionToken), session, sessionToken };
}

function enforceCsrf(request: any, auth: { session?: any }): void {
  if (!auth.session || ['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET')) return;
  if (request.headers['x-csrf-token'] !== auth.session.csrf_token)
    throw new MadeProofError('CSRF_REJECTED', 'CSRF token is missing or invalid', 403);
}

async function asyncIdempotent<T>(
  service: MadeProofService,
  actor: Actor,
  key: string | undefined,
  route: string,
  body: unknown,
  operation: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  if (!key) return { ...(await operation()), replayed: false };
  if (key.length > 200)
    throw new MadeProofError('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key is too long', 422);
  const requestHash = sha256(canonicalJson(body));
  const existing = service.store.getIdempotency(actor.workspaceId, key, route);
  if (existing) {
    if (existing.request_hash !== requestHash)
      throw new MadeProofError(
        'IDEMPOTENCY_CONFLICT',
        'Idempotency-Key was already used with a different request body',
        409,
      );
    return { status: existing.response_status, body: existing.response as T, replayed: true };
  }
  const value = await operation();
  service.store.saveIdempotency({
    workspaceId: actor.workspaceId,
    key,
    route,
    requestHash,
    responseStatus: value.status,
    response: value.body,
  });
  return { ...value, replayed: false };
}

export function createApplication(overrides: Partial<RuntimeConfig> = {}): Application {
  const config = loadConfig(overrides);
  if (config.databaseKind !== 'sqlite') {
    throw new MadeProofError(
      'POSTGRES_LIVE_ADAPTER_PENDING',
      'The PostgreSQL schema is implemented, but this build environment cannot install or live-verify the PostgreSQL driver. Use sqlite only for the executable local evaluation build.',
      500,
    );
  }
  const store = new SqliteStore(config.dataDir);
  const evidenceService = new EvidenceService(config.dataDir);
  const projectRoot = path.resolve(process.cwd());
  const service = new MadeProofService(
    store,
    evidenceService,
    new VerificationEngine(),
    new SafeCommandRunner(),
    config,
    projectRoot,
  );
  const authLimiter = new RateLimiter(10, 60_000);
  const apiLimiter = new RateLimiter(240, 60_000);
  const moduleDir = path.dirname(url.fileURLToPath(import.meta.url));
  const webRoot = path.resolve(moduleDir, '../../web/public');
  const demoRoot = path.resolve(moduleDir, '../../../examples/demo-target/public');

  const server = http.createServer(async (request: any, response: any) => {
    const requestId = newId('req');
    setCommonHeaders(response, config, requestId);
    const parsedUrl = new URL(request.url ?? '/', config.publicBaseUrl);
    const pathname = parsedUrl.pathname;
    const method = request.method ?? 'GET';
    const ip = request.socket?.remoteAddress ?? 'unknown';
    try {
      if (method === 'OPTIONS') {
        response.writeHead(204, { Allow: 'GET,POST,DELETE,OPTIONS' });
        response.end();
        return;
      }
      const rate = (pathname === '/api/v1/auth/login' ? authLimiter : apiLimiter).consume(
        `${ip}:${pathname.split('/').slice(0, 4).join('/')}`,
      );
      response.setHeader('RateLimit-Remaining', String(rate.remaining));
      response.setHeader('RateLimit-Reset', String(Math.ceil(rate.resetAt / 1000)));
      if (!rate.allowed)
        throw new MadeProofError(
          'RATE_LIMITED',
          'Too many requests; retry after the rate-limit window resets',
          429,
        );

      if (pathname === '/health/live')
        return sendJson(response, 200, { status: 'live', version: '0.1.0', requestId });
      if (pathname === '/health/ready') {
        service.store.db.prepare('SELECT 1 AS ok').get();
        return sendJson(response, 200, {
          status: 'ready',
          database: 'sqlite-local-evaluation',
          requestId,
        });
      }
      if (pathname === '/api/v1/openapi.json') return sendJson(response, 200, openApiDocument);
      if (pathname.startsWith('/demo-target')) {
        const relative = pathname.replace('/demo-target', '') || '/';
        if (serveStatic(response, demoRoot, relative)) return;
        throw new MadeProofError('NOT_FOUND', 'Demo target asset not found', 404);
      }
      if (pathname === '/api/v1/auth/login' && method === 'POST') {
        const body = await readJson(request);
        const login = service.login(
          requiredString(body.email, 'email', 3),
          requiredString(body.password, 'password', 1),
        );
        const cookie = `mp_session=${encodeURIComponent(login.token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=28800${config.env === 'production' ? '; Secure' : ''}`;
        return sendJson(
          response,
          200,
          {
            user: login.user,
            workspace: login.workspace,
            csrfToken: login.csrfToken,
            expiresAt: login.expiresAt,
          },
          { 'Set-Cookie': cookie, 'Cache-Control': 'no-store' },
        );
      }
      if (pathname === '/mcp' && method === 'POST') {
        const auth = authenticate(service, request, 'tasks:read');
        return await handleMcpHttp({
          request,
          response,
          service,
          actor: { ...auth.actor, type: 'MCP' },
          requestId,
          config,
        });
      }

      if (pathname.startsWith('/api/v1/')) {
        const auth = authenticate(service, request, scopeFor(method, pathname));
        enforceCsrf(request, auth);
        const actor = auth.actor;
        const idempotencyKey =
          typeof request.headers['idempotency-key'] === 'string'
            ? request.headers['idempotency-key']
            : undefined;

        if (pathname === '/api/v1/auth/me' && method === 'GET') {
          return sendJson(response, 200, {
            actor,
            workspace: service.store.getDefaultWorkspaceForUser(actor.id),
            csrfToken: auth.session?.csrf_token ?? null,
          });
        }
        if (pathname === '/api/v1/auth/logout' && method === 'POST') {
          if (auth.sessionToken) service.logout(auth.sessionToken);
          return sendJson(
            response,
            200,
            { ok: true },
            { 'Set-Cookie': 'mp_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0' },
          );
        }
        if (pathname === '/api/v1/dashboard' && method === 'GET')
          return sendJson(response, 200, service.dashboard(actor));
        if (pathname === '/api/v1/attention' && method === 'GET')
          return sendJson(response, 200, { items: service.store.listAttention(actor.workspaceId) });
        if (pathname === '/api/v1/agent-reliability' && method === 'GET')
          return sendJson(
            response,
            200,
            service.agentReliability(actor, parsedUrl.searchParams.get('agentId') ?? undefined),
          );

        if (pathname === '/api/v1/projects' && method === 'GET') {
          return sendJson(response, 200, {
            items: service.listProjects(
              actor,
              Number(parsedUrl.searchParams.get('limit') ?? 50),
              Number(parsedUrl.searchParams.get('offset') ?? 0),
            ),
          });
        }
        if (pathname === '/api/v1/projects' && method === 'POST') {
          const body = await readJson(request);
          const outcome = service.idempotent(actor, idempotencyKey, pathname, body, () => ({
            status: 201,
            body: service.createProject(actor, {
              name: requiredString(body.name, 'name', 2),
              projectType: body.projectType,
              repositoryUrl: body.repositoryUrl,
            }),
          }));
          return sendJson(
            response,
            outcome.status,
            outcome.body,
            outcome.replayed ? { 'Idempotency-Replayed': 'true' } : {},
          );
        }
        const projectMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
        if (projectMatch && method === 'GET')
          return sendJson(response, 200, service.getProject(actor, projectMatch[1]!));

        if (pathname === '/api/v1/tasks' && method === 'GET') {
          return sendJson(response, 200, {
            items: service.listTasks(actor, {
              status: parsedUrl.searchParams.get('status') ?? undefined,
              projectId: parsedUrl.searchParams.get('projectId') ?? undefined,
              limit: Number(parsedUrl.searchParams.get('limit') ?? 50),
              offset: Number(parsedUrl.searchParams.get('offset') ?? 0),
            }),
          });
        }
        if (pathname === '/api/v1/tasks' && method === 'POST') {
          const body = await readJson(request);
          const outcome = service.idempotent(actor, idempotencyKey, pathname, body, () => ({
            status: 201,
            body: service.createTask(actor, {
              projectId: requiredString(body.projectId, 'projectId'),
              title: requiredString(body.title, 'title', 2),
              intent: requiredString(body.intent, 'intent', 5),
              template: body.template,
            }),
          }));
          return sendJson(
            response,
            outcome.status,
            outcome.body,
            outcome.replayed ? { 'Idempotency-Replayed': 'true' } : {},
          );
        }
        const taskMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
        if (taskMatch && method === 'GET')
          return sendJson(response, 200, service.getTask(actor, taskMatch[1]!));
        const contractsMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/contracts$/);
        if (contractsMatch && method === 'GET')
          return sendJson(response, 200, {
            items: service.listContracts(actor, contractsMatch[1]!),
          });
        if (contractsMatch && method === 'POST') {
          const body = await readJson(request);
          const outcome = service.idempotent(actor, idempotencyKey, pathname, body, () => ({
            status: 201,
            body: body.acceptanceCriteria
              ? service.updateContract(actor, contractsMatch[1]!, body)
              : service.generateContract(actor, contractsMatch[1]!),
          }));
          return sendJson(
            response,
            outcome.status,
            outcome.body,
            outcome.replayed ? { 'Idempotency-Replayed': 'true' } : {},
          );
        }
        const taskRunsMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/runs$/);
        if (taskRunsMatch && method === 'POST') {
          const body = await readJson(request);
          const outcome = service.idempotent(actor, idempotencyKey, pathname, body, () => ({
            status: 201,
            body: service.startRun(actor, taskRunsMatch[1]!, body),
          }));
          return sendJson(
            response,
            outcome.status,
            outcome.body,
            outcome.replayed ? { 'Idempotency-Replayed': 'true' } : {},
          );
        }

        const runMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
        if (runMatch && method === 'GET')
          return sendJson(response, 200, service.getRun(actor, runMatch[1]!));
        const evidenceMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/evidence$/);
        if (evidenceMatch && method === 'GET')
          return sendJson(response, 200, {
            items: service.store.listEvidence(actor.workspaceId, evidenceMatch[1]!),
          });
        if (evidenceMatch && method === 'POST') {
          const body = await readJson(request);
          const outcome = service.idempotent(actor, idempotencyKey, pathname, body, () => ({
            status: 201,
            body: service.addEvidence(actor, evidenceMatch[1]!, {
              criterionId: body.criterionId,
              type: requiredString(body.type, 'type'),
              value: body.value,
              source: body.source,
              mimeType: body.mimeType,
            }),
          }));
          return sendJson(
            response,
            outcome.status,
            outcome.body,
            outcome.replayed ? { 'Idempotency-Replayed': 'true' } : {},
          );
        }
        const verifyMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/verify$/);
        if (verifyMatch && method === 'POST') {
          const body = await readJson(request);
          const outcome = await asyncIdempotent(
            service,
            actor,
            idempotencyKey,
            pathname,
            body,
            async () => ({ status: 200, body: await service.verify(actor, verifyMatch[1]!) }),
          );
          return sendJson(
            response,
            outcome.status,
            outcome.body,
            outcome.replayed ? { 'Idempotency-Replayed': 'true' } : {},
          );
        }
        const verificationMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/verification$/);
        if (verificationMatch && method === 'GET')
          return sendJson(response, 200, service.getVerification(actor, verificationMatch[1]!));
        const verdictMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/verdict$/);
        if (verdictMatch && method === 'GET')
          return sendJson(response, 200, service.getVerdict(actor, verdictMatch[1]!));
        const failedMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/failed-checks$/);
        if (failedMatch && method === 'GET')
          return sendJson(response, 200, {
            items: service.getFailedChecks(actor, failedMatch[1]!),
          });
        const retryMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/retry$/);
        if (retryMatch && method === 'POST') {
          const body = await readJson(request);
          const outcome = service.idempotent(actor, idempotencyKey, pathname, body, () => ({
            status: 201,
            body: service.retry(actor, retryMatch[1]!, body),
          }));
          return sendJson(
            response,
            outcome.status,
            outcome.body,
            outcome.replayed ? { 'Idempotency-Replayed': 'true' } : {},
          );
        }

        const receiptJsonMatch = pathname.match(/^\/api\/v1\/receipts\/([^/.]+)\.json$/);
        if (receiptJsonMatch && method === 'GET')
          return sendJson(response, 200, service.getReceipt(actor, receiptJsonMatch[1]!));
        const receiptMatch = pathname.match(/^\/api\/v1\/receipts\/([^/]+)$/);
        if (receiptMatch && method === 'GET')
          return sendJson(response, 200, service.getReceipt(actor, receiptMatch[1]!));
        const runReceiptMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/receipt$/);
        if (runReceiptMatch && method === 'GET')
          return sendJson(response, 200, service.getReceiptByRun(actor, runReceiptMatch[1]!));

        if (pathname === '/api/v1/api-keys' && method === 'GET')
          return sendJson(response, 200, { items: service.listApiKeys(actor) });
        if (pathname === '/api/v1/api-keys' && method === 'POST') {
          const body = await readJson(request);
          return sendJson(
            response,
            201,
            service.createApiKey(actor, {
              name: requiredString(body.name, 'name', 2),
              scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : [],
              expiresAt: body.expiresAt,
            }),
          );
        }
        const apiKeyMatch = pathname.match(/^\/api\/v1\/api-keys\/([^/]+)$/);
        if (apiKeyMatch && method === 'DELETE') {
          const revoked = service.revokeApiKey(actor, apiKeyMatch[1]!);
          return sendJson(response, revoked ? 200 : 404, { revoked });
        }

        throw new MadeProofError('NOT_FOUND', 'API route not found', 404);
      }

      if (serveStatic(response, webRoot, pathname)) return;
      sendText(response, 404, 'Not found');
    } catch (error) {
      const safe = asMadeProofError(error);
      if (safe.status >= 500)
        console.error(
          JSON.stringify({ level: 'error', requestId, code: safe.code, message: safe.message }),
        );
      sendJson(
        response,
        safe.status,
        {
          error: {
            code: safe.code,
            message:
              safe.status >= 500
                ? 'The request could not be completed due to an internal error.'
                : safe.message,
            requestId,
            details: safe.status < 500 ? safe.details : undefined,
          },
        },
        safe.status === 429 ? { 'Retry-After': '60' } : {},
      );
    }
  });

  return {
    server,
    service,
    config,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => resolve());
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      config.port = port;
      config.publicBaseUrl = `http://${config.host}:${port}`;
      return { url: config.publicBaseUrl, port };
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
