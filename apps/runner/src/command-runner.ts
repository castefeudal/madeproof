import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MadeProofError } from '../../../packages/shared/src/errors.js';

export interface CommandExecution {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  network: 'disabled' | 'enabled';
  envAllowlist?: string[];
}

export interface CommandExecutionResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  isolation: string[];
}

export class SafeCommandRunner {
  async execute(input: CommandExecution): Promise<CommandExecutionResult> {
    const source = path.resolve(input.cwd);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new MadeProofError('RUNNER_CWD_INVALID', 'Runner working directory does not exist', 422);
    if (!path.isAbsolute(source)) throw new MadeProofError('RUNNER_CWD_INVALID', 'Runner working directory must be absolute', 422);
    if (input.command.includes('/') && !path.isAbsolute(input.command)) throw new MadeProofError('RUNNER_COMMAND_INVALID', 'Relative executable paths are not allowed', 422);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'madeproof-run-'));
    const workDir = path.join(tempRoot, 'workspace');
    fs.cpSync(source, workDir, { recursive: true, dereference: false, filter: (src: string) => !src.includes(`${path.sep}.git${path.sep}`) && !src.endsWith(`${path.sep}.git`) });
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: tempRoot,
      TMPDIR: path.join(tempRoot, 'tmp'),
      CI: '1',
      NODE_ENV: 'test'
    };
    fs.mkdirSync(env.TMPDIR, { recursive: true });
    for (const key of input.envAllowlist ?? []) if (typeof process.env[key] === 'string') env[key] = process.env[key];

    const isolation: string[] = ['ephemeral-copy', 'timeout', 'environment-allowlist', 'resource-limits'];
    const command: string[] = [];
    if (process.platform === 'linux') {
      command.push('prlimit', '--as=1073741824', '--cpu=120', '--nproc=256', '--nofile=1024');
      if (input.network === 'disabled') {
        command.push('unshare', '--user', '--map-root-user', '--net');
        isolation.push('network-namespace');
      }
    }
    command.push(input.command, ...input.args);
    const started = Date.now();
    let timedOut = false;
    try {
      return await new Promise<CommandExecutionResult>((resolve, reject) => {
        const processHandle = childProcess.spawn(command[0]!, command.slice(1), {
          cwd: workDir,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          detached: process.platform !== 'win32'
        });
        let stdout = '';
        let stderr = '';
        const cap = 2 * 1024 * 1024;
        processHandle.stdout.on('data', (chunk: any) => { if (stdout.length < cap) stdout += String(chunk).slice(0, cap - stdout.length); });
        processHandle.stderr.on('data', (chunk: any) => { if (stderr.length < cap) stderr += String(chunk).slice(0, cap - stderr.length); });
        const timer = setTimeout(() => {
          timedOut = true;
          if (process.platform !== 'win32' && processHandle.pid) {
            try { process.kill(-processHandle.pid, 'SIGKILL'); } catch { processHandle.kill('SIGKILL'); }
          } else processHandle.kill('SIGKILL');
        }, Math.max(100, input.timeoutMs));
        processHandle.once('error', reject);
        processHandle.once('close', (exitCode: number | null, signal: string | null) => {
          clearTimeout(timer);
          resolve({ exitCode, signal, stdout, stderr, durationMs: Date.now() - started, timedOut, isolation });
        });
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}
