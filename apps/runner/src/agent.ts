import path from 'node:path';
import { SafeCommandRunner } from './command-runner.js';
import {
  RunnerCheckExecutor,
  type RunnerCheckPayload,
} from '../../../packages/verification/src/runner-executor.js';

export interface RunnerAgentOptions {
  baseUrl: string;
  credential: string;
  version?: string;
  capabilities?: string[];
  allowedRoots?: string[];
  pollIntervalMs?: number;
  allowRootProcess?: boolean;
  allowWeakIsolationFallback?: boolean;
}

export class RunnerAgent {
  readonly version: string;
  readonly capabilities: string[];
  readonly executor: RunnerCheckExecutor;
  private stopping = false;

  constructor(readonly options: RunnerAgentOptions) {
    this.version = options.version ?? '0.1.0';
    this.capabilities = options.capabilities ?? [
      'command',
      'build',
      'test_suite',
      'browser',
      'accessibility',
      'file',
      'http',
    ];
    const roots = (options.allowedRoots?.length ? options.allowedRoots : [process.cwd()]).map(
      (root) => path.resolve(root),
    );
    this.executor = new RunnerCheckExecutor(
      new SafeCommandRunner({
        allowedRoots: roots,
        allowRootProcess: options.allowRootProcess,
        allowWeakIsolationFallback: options.allowWeakIsolationFallback,
      }),
    );
  }

  stop(): void {
    this.stopping = true;
  }

  async runLoop(): Promise<void> {
    this.stopping = false;
    await this.heartbeat();
    while (!this.stopping) {
      const worked = await this.pollOnce();
      if (!worked)
        await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs ?? 500));
    }
  }

  async heartbeat(): Promise<void> {
    await this.request('/api/v1/runner/heartbeat', {
      version: this.version,
      capabilities: this.capabilities,
    });
  }

  async pollOnce(): Promise<boolean> {
    const response = await fetch(`${this.options.baseUrl}/api/v1/runner/poll`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ version: this.version, capabilities: this.capabilities }),
    });
    if (response.status === 204) return false;
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(`Runner poll failed: ${response.status} ${JSON.stringify(body)}`);
    const job = body.job;
    if (!job) return false;
    await this.request(`/api/v1/runner/jobs/${encodeURIComponent(job.id)}/start`, {
      leaseToken: job.leaseToken,
    });
    try {
      const outcome = await this.executor.execute(job.payload as RunnerCheckPayload);
      await this.request(`/api/v1/runner/jobs/${encodeURIComponent(job.id)}/complete`, {
        leaseToken: job.leaseToken,
        result: outcome,
      });
    } catch (error) {
      await this.request(`/api/v1/runner/jobs/${encodeURIComponent(job.id)}/fail`, {
        leaseToken: job.leaseToken,
        retryable: true,
        error: {
          code: 'RUNNER_AGENT_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
    return true;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Runner ${this.options.credential}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': `madeproof-runner/${this.version}`,
    };
  }

  private async request(pathname: string, body: unknown): Promise<any> {
    const response = await fetch(`${this.options.baseUrl}${pathname}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(`Runner API request failed: ${response.status} ${JSON.stringify(payload)}`);
    return payload;
  }
}
