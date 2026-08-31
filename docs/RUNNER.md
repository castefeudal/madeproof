# MADEPROOF runner boundary

The runner is the only component allowed to execute target-project commands. The API/control plane never imports or invokes the command runner.

```text
API/control plane -> PostgreSQL verification_jobs
Worker -> runner_jobs
Runner <- outbound HTTPS poll only
Runner -> short-lived single-use job lease -> isolated execution -> evidence draft
Worker -> validates/materializes evidence -> verdict + receipt
```

Runner credentials are workspace-bound and stored only as hashes. A claimed runner job receives a fresh opaque lease token; only its hash is stored. Completion consumes the lease, so replay is rejected. Capabilities are fixed at registration and protocol compatibility is constrained to `0.1.x`.

## Production isolation

Production Linux execution requires Bubblewrap and fails closed when it is unavailable. The runner:

- executes as a dedicated non-root user;
- copies the controlled repository into an ephemeral workspace;
- rejects symlinks escaping the source root;
- clears inherited environment and adds only an explicit allowlist;
- applies CPU/address-space/process/open-file limits with `prlimit`;
- uses Bubblewrap user/mount/PID/IPC/UTS/cgroup namespaces;
- exposes system runtime paths read-only and only the ephemeral workspace read-write;
- disables network by default; checks explicitly opt in to network;
- never mounts the host Docker socket and never requests privileged mode;
- deletes the ephemeral workspace after success, failure or timeout.

Development escape hatches (`MADEPROOF_RUNNER_ALLOW_ROOT`, `MADEPROOF_RUNNER_ALLOW_WEAK_SANDBOX`, `MADEPROOF_CHROMIUM_NO_SANDBOX`) are not valid production configurations.

## Durable recovery

`verification_jobs` and `runner_jobs` are PostgreSQL-backed in production. Claims have expirations and attempts. A new worker can reclaim stale verification work after a crash. Expired runner leases are requeued until `max_attempts`, then become `TIMED_OUT`. Cancellation cancels pending runner jobs and moves the task/run out of active verification states.

## Local runner

Register a runner with `POST /api/v1/runners`, copy the one-time `mpr_...` secret, then run:

```bash
export NODE_ENV=production
export MADEPROOF_BASE_URL=https://madeproof.example.com
export MADEPROOF_RUNNER_CREDENTIAL='mpr_...'
export MADEPROOF_RUNNER_ROOTS=/srv/repos/project
npm run runner
```

No inbound runner port is required.
