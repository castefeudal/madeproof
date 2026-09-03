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

export interface SafeCommandRunnerOptions {
  allowedRoots?: string[];
  allowRootProcess?: boolean;
  allowWeakIsolationFallback?: boolean;
}

function commandExists(command: string): boolean {
  const paths: string[] = String(process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(path.delimiter);
  return paths.some((entry: string) => fs.existsSync(path.join(entry, command)));
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertNoSymlinkEscape(root: string): void {
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(candidate);
        if (!isWithin(root, resolved)) throw new MadeProofError('RUNNER_SYMLINK_ESCAPE', 'Runner source contains a symlink that escapes the allowed root', 422);
        continue;
      }
      if (stat.isDirectory()) visit(candidate);
    }
  };
  visit(root);
}

export class SafeCommandRunner {
  private readonly allowedRoots: string[];
  private readonly allowRootProcess: boolean;
  private readonly allowWeakIsolationFallback: boolean;

  constructor(options: SafeCommandRunnerOptions = {}) {
    this.allowedRoots = (options.allowedRoots?.length ? options.allowedRoots : [process.cwd()]).map((root) => fs.realpathSync(path.resolve(root)));
    this.allowRootProcess = options.allowRootProcess ?? process.env.MADEPROOF_RUNNER_ALLOW_ROOT === '1';
    this.allowWeakIsolationFallback = options.allowWeakIsolationFallback ?? process.env.MADEPROOF_RUNNER_ALLOW_WEAK_SANDBOX === '1';
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0 && !this.allowRootProcess) {
      throw new MadeProofError('RUNNER_ROOT_FORBIDDEN', 'The verification runner must not execute as root', 500);
    }
  }

  async execute(input: CommandExecution): Promise<CommandExecutionResult> {
    const requested = path.resolve(input.cwd);
    if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) throw new MadeProofError('RUNNER_CWD_INVALID', 'Runner working directory does not exist', 422);
    const source = fs.realpathSync(requested);
    if (!this.allowedRoots.some((root) => isWithin(root, source))) throw new MadeProofError('RUNNER_CWD_FORBIDDEN', 'Runner working directory is outside the configured allowed roots', 403);
    if (input.command.includes('/') && !path.isAbsolute(input.command)) throw new MadeProofError('RUNNER_COMMAND_INVALID', 'Relative executable paths are not allowed', 422);
    assertNoSymlinkEscape(source);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'madeproof-run-'));
    const workDir = path.join(tempRoot, 'workspace');
    const tmpDir = path.join(tempRoot, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.cpSync(source, workDir, { recursive: true, dereference: false, filter: (src: string) => !src.includes(`${path.sep}.git${path.sep}`) && !src.endsWith(`${path.sep}.git`) });

    const env: Record<string, string> = { PATH: String(process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'), HOME: '/tmp', TMPDIR: '/tmp', CI: '1', NODE_ENV: 'test' };
    for (const key of input.envAllowlist ?? []) if (typeof process.env[key] === 'string') env[key] = process.env[key]!;

    const isolation = ['ephemeral-copy', 'timeout', 'environment-allowlist', 'resource-limits'];
    let argv: string[];
    if (process.platform === 'linux' && commandExists('bwrap') && !this.allowWeakIsolationFallback) {
      argv = ['prlimit','--as=1073741824','--cpu=120','--nproc=256','--nofile=1024','--','bwrap','--die-with-parent','--new-session','--unshare-user','--unshare-pid','--unshare-ipc','--unshare-uts','--unshare-cgroup',...(input.network === 'disabled' ? ['--unshare-net'] : []),'--ro-bind','/usr','/usr','--ro-bind','/bin','/bin',...(fs.existsSync('/lib') ? ['--ro-bind','/lib','/lib'] : []),...(fs.existsSync('/lib64') ? ['--ro-bind','/lib64','/lib64'] : []),...(fs.existsSync('/etc/ssl') ? ['--ro-bind','/etc/ssl','/etc/ssl'] : []),'--proc','/proc','--dev','/dev','--tmpfs','/tmp','--bind',workDir,'/workspace','--chdir','/workspace','--',input.command,...input.args];
      isolation.push('bubblewrap-user-mount-pid-ipc-uts-cgroup-namespaces', 'filesystem-allowlist');
      if (input.network === 'disabled') isolation.push('network-namespace');
    } else {
      if (process.platform === 'linux' && !this.allowWeakIsolationFallback) throw new MadeProofError('RUNNER_SANDBOX_UNAVAILABLE', 'Bubblewrap is required for production runner isolation', 500);
      argv = process.platform === 'linux' && commandExists('prlimit') ? ['prlimit','--as=1073741824','--cpu=120','--nproc=256','--nofile=1024','--',input.command,...input.args] : [input.command,...input.args];
      isolation.push('weak-isolation-fallback');
    }

    const started = Date.now();
    let timedOut = false;
    try {
      return await new Promise<CommandExecutionResult>((resolve, reject) => {
        const processHandle = childProcess.spawn(argv[0]!, argv.slice(1), { cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
        let stdout = '';
        let stderr = '';
        const cap = 2 * 1024 * 1024;
        processHandle.stdout.on('data', (chunk: any) => { if (stdout.length < cap) stdout += String(chunk).slice(0, cap - stdout.length); });
        processHandle.stderr.on('data', (chunk: any) => { if (stderr.length < cap) stderr += String(chunk).slice(0, cap - stderr.length); });
        const timer = setTimeout(() => { timedOut = true; if (process.platform !== 'win32' && processHandle.pid) { try { process.kill(-processHandle.pid, 'SIGKILL'); } catch { processHandle.kill('SIGKILL'); } } else processHandle.kill('SIGKILL'); }, Math.max(100, input.timeoutMs));
        processHandle.once('error', (error: Error) => { clearTimeout(timer); reject(error); });
        processHandle.once('close', (exitCode: number | null, signal: string | null) => { clearTimeout(timer); resolve({ exitCode, signal, stdout, stderr, durationMs: Date.now() - started, timedOut, isolation }); });
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  }
}
