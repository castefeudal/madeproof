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
  /** Project roots this runner is allowed to execute against. Defaults to the current directory. */
  allowedRoots?: string[];
  /** Development escape hatch: permit running the runner process as root. Never valid in production. */
  allowRootProcess?: boolean;
  /** Development escape hatch: fall back to weak (non-Bubblewrap) isolation when bwrap is unavailable. */
  allowWeakIsolationFallback?: boolean;
}

const BWRAP_PATHS = ['/usr/bin/bwrap', '/bin/bwrap'];
const OUTPUT_CAP_BYTES = 2 * 1024 * 1024;
const SYSTEM_READ_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'];

function firstExisting(paths: string[]): string | null {
  for (const candidate of paths) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore probe errors
    }
  }
  return null;
}

/**
 * Detect (once per process) whether the kernel supports cgroup namespaces so the
 * isolation report only ever claims isolation that was actually applied.
 */
let cgroupNamespaceSupport: boolean | null = null;
function supportsCgroupNamespace(bwrap: string): boolean {
  if (cgroupNamespaceSupport !== null) return cgroupNamespaceSupport;
  try {
    const probe = childProcess.spawnSync(
      bwrap,
      [
        '--unshare-cgroup',
        '--ro-bind',
        '/',
        '/',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--',
        'true',
      ],
      { timeout: 5000, encoding: 'utf8' },
    );
    cgroupNamespaceSupport = probe.status === 0;
  } catch {
    cgroupNamespaceSupport = false;
  }
  return cgroupNamespaceSupport;
}

function assertSafeTree(sourceRoot: string): void {
  const stack: string[] = [sourceRoot];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = path.resolve(path.dirname(full), fs.readlinkSync(full));
        if (target !== sourceRoot && !target.startsWith(`${sourceRoot}${path.sep}`))
          throw new MadeProofError(
            'RUNNER_SYMLINK_ESCAPE',
            `Symbolic link ${path.relative(sourceRoot, full)} escapes the project root`,
            422,
          );
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) stack.push(full);
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFIFO() || entry.isSocket() || entry.isCharacterDevice() || entry.isBlockDevice())
        throw new MadeProofError(
          'RUNNER_UNSAFE_FILE_TYPE',
          `Unsupported special file ${path.relative(sourceRoot, full)}`,
          422,
        );
    }
  }
}

export class SafeCommandRunner {
  private readonly allowedRoots: string[];
  private readonly allowRootProcess: boolean;
  private readonly allowWeakIsolationFallback: boolean;

  constructor(options: SafeCommandRunnerOptions = {}) {
    this.allowedRoots = (options.allowedRoots?.length ? options.allowedRoots : [process.cwd()]).map(
      (root) => path.resolve(root),
    );
    this.allowRootProcess = options.allowRootProcess ?? process.env.MADEPROOF_RUNNER_ALLOW_ROOT === '1';
    this.allowWeakIsolationFallback =
      options.allowWeakIsolationFallback ?? process.env.MADEPROOF_RUNNER_ALLOW_WEAK_SANDBOX === '1';
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0 &&
      !this.allowRootProcess
    )
      throw new MadeProofError(
        'RUNNER_ROOT_FORBIDDEN',
        'The runner must not execute as root. Run it as a dedicated non-root user.',
        403,
      );
  }

  async execute(input: CommandExecution): Promise<CommandExecutionResult> {
    const source = path.resolve(input.cwd);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory())
      throw new MadeProofError('RUNNER_CWD_INVALID', 'Runner working directory does not exist', 422);
    if (!this.allowedRoots.some((root) => source === root || source.startsWith(`${root}${path.sep}`)))
      throw new MadeProofError(
        'RUNNER_CWD_FORBIDDEN',
        'Runner working directory is outside the registered project roots',
        403,
      );
    if (input.command.includes('/') && !path.isAbsolute(input.command))
      throw new MadeProofError(
        'RUNNER_COMMAND_INVALID',
        'Relative executable paths are not allowed',
        422,
      );
    assertSafeTree(source);

    const bwrap = firstExisting(BWRAP_PATHS);
    if (!bwrap && !this.allowWeakIsolationFallback)
      throw new MadeProofError(
        'RUNNER_SANDBOX_UNAVAILABLE',
        'Strong Bubblewrap isolation is required but bwrap is not installed. Install bubblewrap or explicitly enable the weak-isolation development fallback.',
        500,
      );

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'madeproof-run-'));
    const workDir = path.join(tempRoot, 'workspace');
    const tmpDir = path.join(tempRoot, 'tmp');
    try {
      fs.cpSync(source, workDir, {
        recursive: true,
        dereference: false,
        filter: (src: string) =>
          !src.includes(`${path.sep}.git${path.sep}`) && !src.endsWith(`${path.sep}.git`),
      });
      fs.mkdirSync(tmpDir, { recursive: true });

      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: tempRoot,
        TMPDIR: tmpDir,
        CI: '1',
        NODE_ENV: 'test',
      };
      for (const key of input.envAllowlist ?? [])
        if (typeof process.env[key] === 'string') env[key] = process.env[key]!;

      const inner = [input.command, ...input.args];
      const useNetworkNamespace = input.network === 'disabled' && process.platform === 'linux';
      let command: string[];
      let isolation: string[];
      if (bwrap) {
        isolation = [
          'ephemeral-copy',
          'timeout',
          'environment-allowlist',
          'resource-limits',
          'bubblewrap-user-mount-pid-ipc-uts-namespaces',
        ];
        const bwrapArgs = [
          '--die-with-parent',
          '--new-session',
          '--unshare-user',
          '--unshare-pid',
          '--unshare-ipc',
          '--unshare-uts',
          '--dev',
          '/dev',
          '--proc',
          '/proc',
          '--tmpfs',
          '/dev/shm',
          '--tmpfs',
          '/tmp',
          '--clearenv',
        ];
        if (supportsCgroupNamespace(bwrap)) {
          bwrapArgs.push('--unshare-cgroup');
          isolation.push('cgroup-namespace');
        } else if (process.env.MADEPROOF_SANDBOX_REQUIRE_CGROUP === '1') {
          throw new MadeProofError(
            'RUNNER_SANDBOX_UNAVAILABLE',
            'The production runner requires cgroup namespace isolation, which this kernel does not support.',
            500,
          );
        }
        for (const systemPath of SYSTEM_READ_PATHS)
          if (fs.existsSync(systemPath))
            bwrapArgs.push(fs.statSync(systemPath).isDirectory() ? '--ro-bind' : '--ro-bind-try', systemPath, systemPath);
        bwrapArgs.push('--bind', tempRoot, tempRoot);
        for (const [key, value] of Object.entries(env)) bwrapArgs.push('--setenv', key, value);
        command = [bwrap, ...bwrapArgs];
        if (useNetworkNamespace) {
          command.push('unshare', '--user', '--map-root-user', '--net');
          isolation.push('network-namespace');
        }
        command.push('prlimit', '--as=1073741824', '--cpu=120', '--nproc=256', '--nofile=1024');
        command.push(...inner);
      } else {
        isolation = [
          'ephemeral-copy',
          'timeout',
          'environment-allowlist',
          'resource-limits',
          'weak-isolation-fallback',
        ];
        command = [];
        if (process.platform === 'linux') {
          command.push('prlimit', '--as=1073741824', '--cpu=120', '--nproc=256', '--nofile=1024');
          if (useNetworkNamespace) {
            command.push('unshare', '--user', '--map-root-user', '--net');
            isolation.push('network-namespace');
          }
        }
        command.push(...inner);
      }

      const started = Date.now();
      let timedOut = false;
      return await new Promise<CommandExecutionResult>((resolve, reject) => {
        const processHandle = childProcess.spawn(command[0]!, command.slice(1), {
          cwd: workDir,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          detached: process.platform !== 'win32',
        });
        let stdout = '';
        let stderr = '';
        processHandle.stdout.on('data', (chunk: any) => {
          if (stdout.length < OUTPUT_CAP_BYTES)
            stdout += String(chunk).slice(0, OUTPUT_CAP_BYTES - stdout.length);
        });
        processHandle.stderr.on('data', (chunk: any) => {
          if (stderr.length < OUTPUT_CAP_BYTES)
            stderr += String(chunk).slice(0, OUTPUT_CAP_BYTES - stderr.length);
        });
        const timer = setTimeout(
          () => {
            timedOut = true;
            if (process.platform !== 'win32' && processHandle.pid) {
              try {
                process.kill(-processHandle.pid, 'SIGKILL');
              } catch {
                processHandle.kill('SIGKILL');
              }
            } else processHandle.kill('SIGKILL');
          },
          Math.max(100, input.timeoutMs),
        );
        processHandle.once('error', reject);
        processHandle.once('close', (exitCode: number | null, signal: string | null) => {
          clearTimeout(timer);
          resolve({
            exitCode,
            signal,
            stdout,
            stderr,
            durationMs: Date.now() - started,
            timedOut,
            isolation,
          });
        });
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }
}
