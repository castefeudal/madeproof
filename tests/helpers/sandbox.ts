import childProcess from 'node:child_process';
import fs from 'node:fs';

/**
 * One-shot probe: can this kernel actually execute the strong Bubblewrap sandbox?
 *
 * Production hosts must support user namespaces (and ideally cgroup namespaces).
 * Some container runtimes (e.g. gVisor sandboxes) cannot mount the fresh /dev
 * tmpfs or spawn threads inside a PID namespace, so bwrap payloads fail there.
 * The product itself never downgrades isolation: it reports infrastructure
 * ERROR for executable criteria when the sandbox cannot run. Tests use this
 * probe to assert the *honest* outcome for the host they run on instead of
 * asserting behavior the host kernel cannot produce.
 */
export interface SandboxCapability {
  bubblewrap: boolean;
  executable: boolean;
  reason?: string;
}

let cached: SandboxCapability | null = null;

export function probeStrongSandbox(): SandboxCapability {
  if (cached) return cached;
  const bwrap = firstOnPath('bwrap');
  if (!bwrap) {
    cached = { bubblewrap: false, executable: false, reason: 'bubblewrap is not installed' };
    return cached;
  }
  try {
    const probe = childProcess.spawnSync(
      bwrap,
      [
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
        '--ro-bind',
        '/usr',
        '/usr',
        '--ro-bind',
        '/bin',
        '/bin',
        '--ro-bind',
        '/lib',
        '/lib',
        '--',
        'true',
      ],
      { timeout: 15_000, encoding: 'utf8' },
    );
    if (probe.status !== 0) {
      cached = {
        bubblewrap: true,
        executable: false,
        reason: (probe.stderr || `exit ${probe.status}`).trim().split('\n').pop(),
      };
      return cached;
    }
    // The base mount works; also confirm a payload can actually run inside
    // (gVisor kernels sometimes allow the mount but kill threaded payloads).
    const payload = childProcess.spawnSync(
      bwrap,
      [
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
        '--ro-bind',
        '/usr',
        '/usr',
        '--ro-bind',
        '/bin',
        '/bin',
        '--ro-bind',
        '/lib',
        '/lib',
        '--',
        'node',
        '-e',
        'process.stdout.write("ok")',
      ],
      { timeout: 30_000, encoding: 'utf8' },
    );
    cached =
      payload.status === 0 && payload.stdout?.trim() === 'ok'
        ? { bubblewrap: true, executable: true }
        : {
            bubblewrap: true,
            executable: false,
            reason: 'payload cannot execute inside the sandbox on this kernel',
          };
  } catch (error) {
    cached = { bubblewrap: true, executable: false, reason: String(error).slice(0, 200) };
  }
  return cached;
}

function firstOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(':')) {
    try {
      if (fs.existsSync(`${dir}/${name}`)) return `${dir}/${name}`;
    } catch {
      continue;
    }
  }
  return null;
}
