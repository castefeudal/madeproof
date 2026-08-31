export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'MADEPROOF API',
    version: '0.1.0',
    description: 'Evidence-first verification API for delegated AI work.'
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'mp_session' }
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'requestId'],
            properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' } }
          }
        }
      }
    }
  },
  paths: {
    '/projects': {
      get: { summary: 'List projects', security: [{ bearerAuth: [] }, { sessionCookie: [] }], responses: { '200': { description: 'Project list' } } },
      post: { summary: 'Create project', security: [{ bearerAuth: [] }, { sessionCookie: [] }], responses: { '201': { description: 'Project created' } } }
    },
    '/tasks': {
      get: { summary: 'List tasks', security: [{ bearerAuth: [] }, { sessionCookie: [] }], responses: { '200': { description: 'Task list' } } },
      post: { summary: 'Create task', security: [{ bearerAuth: [] }, { sessionCookie: [] }], responses: { '201': { description: 'Task created' } } }
    },
    '/tasks/{taskId}/contracts': {
      get: { summary: 'List outcome contract versions', security: [{ bearerAuth: [] }, { sessionCookie: [] }], responses: { '200': { description: 'Contracts' } } },
      post: { summary: 'Generate or create a new immutable contract version', security: [{ bearerAuth: [] }, { sessionCookie: [] }], responses: { '201': { description: 'Contract created' } } }
    },
    '/tasks/{taskId}/runs': {
      post: { summary: 'Start a run and lock the selected contract version', security: [{ bearerAuth: [] }, { sessionCookie: [] }], responses: { '201': { description: 'Run started' } } }
    },
    '/runs/{runId}/evidence': {
      get: { summary: 'List evidence', security: [{ bearerAuth: [] }, { sessionCookie: [] }], responses: { '200': { description: 'Evidence list' } } },
      post: { summary: 'Submit evidence; agent submissions remain self-reported', security: [{ bearerAuth: [] }, { sessionCookie: [] }], responses: { '201': { description: 'Evidence accepted' } } }
    },
    '/runs/{runId}/verify': {
      post: { summary: 'Run independent verification', security: [{ bearerAuth: [] }, { sessionCookie: [] }], responses: { '200': { description: 'Verification result' } } }
    },
    '/runs/{runId}/verdict': {
      get: { summary: 'Get final machine verdict', security: [{ bearerAuth: [] }, { sessionCookie: [] }], responses: { '200': { description: 'Verdict' } } }
    },
    '/receipts/{receiptId}.json': {
      get: { summary: 'Get canonical logical receipt data', security: [{ bearerAuth: [] }, { sessionCookie: [] }], responses: { '200': { description: 'Receipt' } } }
    }
  }
} as const;
