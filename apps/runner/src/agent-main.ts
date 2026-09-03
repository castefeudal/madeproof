import { RunnerAgent } from './agent.js';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name];
}

const config = {
  baseUrl: env('MADEPROOF_BASE_URL'),
  credential: env('MADEPROOF_RUNNER_CREDENTIAL'),
  version: optionalEnv('MADEPROOF_VERSION') ?? '0.1.0',
  capabilities: optionalEnv('MADEPROOF_RUNNER_CAPABILITIES')
    ? optionalEnv('MADEPROOF_RUNNER_CAPABILITIES')!.split(',').map((c) => c.trim())
    : undefined,
  allowedRoots: optionalEnv('MADEPROOF_RUNNER_ROOTS')
    ? optionalEnv('MADEPROOF_RUNNER_ROOTS')!.split(':').map((r) => r.trim())
    : undefined,
  pollIntervalMs: optionalEnv('MADEPROOF_RUNNER_POLL_INTERVAL_MS')
    ? Number(optionalEnv('MADEPROOF_RUNNER_POLL_INTERVAL_MS'))
    : undefined,
  allowRootProcess: optionalEnv('MADEPROOF_RUNNER_ALLOW_ROOT') === '1',
  allowWeakIsolationFallback: optionalEnv('MADEPROOF_RUNNER_ALLOW_WEAK_SANDBOX') === '1',
};

const agent = new RunnerAgent({
  baseUrl: config.baseUrl,
  credential: config.credential,
  version: config.version,
  capabilities: config.capabilities,
  allowedRoots: config.allowedRoots,
  pollIntervalMs: config.pollIntervalMs,
  allowRootProcess: config.allowRootProcess,
  allowWeakIsolationFallback: config.allowWeakIsolationFallback,
});

const shutdown = () => {
  agent.stop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.error(
  JSON.stringify({
    component: 'madeproof-runner',
    baseUrl: config.baseUrl,
    version: config.version,
    capabilities: agent.capabilities,
  }),
);

try {
  await agent.runLoop();
} finally {
  process.exit(0);
}
