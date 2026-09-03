import path from 'node:path';
import { RunnerAgent } from './agent.js';
import { MadeProofError } from '../../../packages/shared/src/errors.js';

const baseUrl = process.env.MADEPROOF_BASE_URL ?? process.env.PUBLIC_BASE_URL;
const credential = process.env.MADEPROOF_RUNNER_CREDENTIAL;
if (!baseUrl || !credential) throw new MadeProofError('RUNNER_CONFIG_INVALID', 'MADEPROOF_BASE_URL and MADEPROOF_RUNNER_CREDENTIAL are required', 500);
const allowedRoots = (process.env.MADEPROOF_RUNNER_ROOTS ?? process.cwd()).split(path.delimiter).filter(Boolean);
const agent = new RunnerAgent({
  baseUrl,
  credential,
  version: process.env.MADEPROOF_RUNNER_VERSION ?? '0.1.0',
  capabilities: ['command', 'build', 'test_suite', 'browser', 'accessibility', 'file', 'http'],
  allowedRoots,
  pollIntervalMs: Number(process.env.MADEPROOF_RUNNER_POLL_MS ?? 500),
  allowRootProcess: process.env.MADEPROOF_RUNNER_ALLOW_ROOT === '1',
  allowWeakIsolationFallback: process.env.MADEPROOF_RUNNER_ALLOW_WEAK_SANDBOX === '1'
});
let stopping = false;
const shutdown = () => { if (stopping) return; stopping = true; agent.stop(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
console.error(JSON.stringify({ component: 'madeproof-runner', version: agent.version, capabilities: agent.capabilities, roots: allowedRoots }));
await agent.runLoop();
