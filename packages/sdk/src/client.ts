export class MadeProofApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'MadeProofApiError';
  }
}

export class MadeProof {
  readonly baseUrl: string;
  readonly apiKey: string;

  constructor(input: { baseUrl: string; apiKey: string }) {
    this.baseUrl = input.baseUrl.replace(/\/$/, '');
    this.apiKey = input.apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = payload?.error ?? {};
      throw new MadeProofApiError(
        error.code ?? 'HTTP_ERROR',
        error.message ?? `HTTP ${response.status}`,
        response.status,
        error.requestId,
      );
    }
    return payload as T;
  }

  readonly projects = {
    create: (
      input: { name: string; projectType?: string; repositoryUrl?: string },
      idempotencyKey?: string,
    ) => this.request<any>('POST', '/projects', input, idempotencyKey),
    list: () => this.request<{ items: any[] }>('GET', '/projects'),
    get: (projectId: string) =>
      this.request<any>('GET', `/projects/${encodeURIComponent(projectId)}`),
  };

  readonly tasks = {
    create: (
      input: { projectId: string; title: string; intent: string; template?: string },
      idempotencyKey?: string,
    ) => this.request<any>('POST', '/tasks', input, idempotencyKey),
    list: (query = '') =>
      this.request<{ items: any[] }>('GET', `/tasks${query ? `?${query}` : ''}`),
    get: (taskId: string) => this.request<any>('GET', `/tasks/${encodeURIComponent(taskId)}`),
  };

  readonly contracts = {
    generate: (taskId: string, idempotencyKey?: string) =>
      this.request<any>(
        'POST',
        `/tasks/${encodeURIComponent(taskId)}/contracts`,
        {},
        idempotencyKey,
      ),
    update: (taskId: string, input: unknown, idempotencyKey?: string) =>
      this.request<any>(
        'POST',
        `/tasks/${encodeURIComponent(taskId)}/contracts`,
        input,
        idempotencyKey,
      ),
    list: (taskId: string) =>
      this.request<{ items: any[] }>('GET', `/tasks/${encodeURIComponent(taskId)}/contracts`),
  };

  readonly runs = {
    start: (
      taskId: string,
      input: { metadata?: Record<string, unknown>; artifactRef?: string; agentId?: string } = {},
      idempotencyKey?: string,
    ) =>
      this.request<any>('POST', `/tasks/${encodeURIComponent(taskId)}/runs`, input, idempotencyKey),
    get: (runId: string) => this.request<any>('GET', `/runs/${encodeURIComponent(runId)}`),
    retry: (
      runId: string,
      input: { metadata?: Record<string, unknown>; artifactRef?: string } = {},
      idempotencyKey?: string,
    ) =>
      this.request<any>('POST', `/runs/${encodeURIComponent(runId)}/retry`, input, idempotencyKey),
  };

  readonly evidence = {
    add: (
      runId: string,
      input: { criterionId?: string; type: string; value: unknown; source?: string },
      idempotencyKey?: string,
    ) =>
      this.request<any>(
        'POST',
        `/runs/${encodeURIComponent(runId)}/evidence`,
        input,
        idempotencyKey,
      ),
    list: (runId: string) =>
      this.request<{ items: any[] }>('GET', `/runs/${encodeURIComponent(runId)}/evidence`),
  };

  readonly verification = {
    verify: (runId: string, idempotencyKey?: string) =>
      this.request<any>('POST', `/runs/${encodeURIComponent(runId)}/verify`, {}, idempotencyKey),
    get: (runId: string) =>
      this.request<any>('GET', `/runs/${encodeURIComponent(runId)}/verification`),
    verdict: (runId: string) =>
      this.request<any>('GET', `/runs/${encodeURIComponent(runId)}/verdict`),
    failures: (runId: string) =>
      this.request<{ items: any[] }>('GET', `/runs/${encodeURIComponent(runId)}/failed-checks`),
  };

  readonly receipts = {
    byRun: (runId: string) =>
      this.request<any>('GET', `/runs/${encodeURIComponent(runId)}/receipt`),
    get: (receiptId: string) =>
      this.request<any>('GET', `/receipts/${encodeURIComponent(receiptId)}.json`),
  };

  readonly attention = {
    list: () => this.request<{ items: any[] }>('GET', '/attention'),
  };

  readonly agents = {
    reliability: (agentId?: string) =>
      this.request<any>(
        'GET',
        `/agent-reliability${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`,
      ),
  };
}
