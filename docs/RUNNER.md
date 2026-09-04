# MADEPROOF runner

The Runner is the only component allowed to execute target-project commands. It is a security boundary: the control plane (API/Web) never executes repository code.

## Trust position

```text
API / control plane
        │  (durable verification_jobs + runner_jobs, leases)
        ▼
     Worker
        │  (claims jobs, validates evidence, finalizes receipts)
        ▼
     Runner  ◀── outbound HTTPS polling only
        │     (no DB credential, no inbound port)
        ▼
 isolated disposable workspace → criterion checks → evidence → verdict
```

The Runner has:

- **no database credential** — it cannot read or write PostgreSQL directly;
- **no inbound listening port** — nothing can connect to it; it only polls outward;
- **outbound-only connectivity** — it registers with the API, claims jobs by lease, and returns evidence;
- **a workspace-bound identity** — its credential is scoped to one workspace and stored only as a hash;
- **fixed capabilities** — set at registration and negotiated with the protocol version.

## Production execution

Production Linux execution requires Bubblewrap and **fails closed** when it is unavailable. The runner:

1. executes as a dedicated non-root user;
2. copies the controlled repository into an ephemeral workspace;
3. rejects symlinks escaping the source root;
4. clears inherited environment and applies an explicit allowlist;
5. applies CPU, address-space, process and open-file limits with `prlimit`;
6. uses Bubblewrap user, mount, PID, IPC, UTS and (where available) cgroup namespaces;
7. disables network by default — criteria must explicitly opt in;
8. never mounts the host Docker socket and never requests privileged mode;
9. deletes the ephemeral workspace after success, failure, timeout or crash.

If strong isolation is unavailable, production execution is **refused** — it is never silently downgraded to a weaker sandbox.

## Environment policy

The Runner inherits **no** environment variables from its parent process. The environment is empty except for an explicit allowlist, which is configurable and deliberately conservative.

Development escape hatches that weaken isolation are recognized but are **not valid production configurations**:

- `MADEPROOF_RUNNER_ALLOW_ROOT`
- `MADEPROOF_RUNNER_ALLOW_WEAK_SANDBOX`
- `MADEPROOF_CHROMIUM_NO_SANDBOX`

In production these are ignored; attempting to use them logs a warning and the request fails closed.

## Leases and job lifecycle

```text
register → lease issued (single-use, non-replayable, hashed at rest)
   → claim job → execute criterion in sandbox
   → return evidence → lease consumed → result recorded
   → lease expires (if unused) → job requeued or TIMED_OUT after max_attempts
```

- A lease token is single-use; replay is rejected.
- Credentials are workspace-bound.
- Capabilities are fixed at registration.
- Protocol version is validated: a runner that reports an incompatible version cannot register or receive jobs.
- Expired leases are requeued until `max_attempts`, then the job becomes `TIMED_OUT`.
- Cancellation cancels pending runner jobs and moves the task/run out of active verification states.

## Local development runner

For local development the runner can be started with the API:

```bash
export NODE_ENV=production
export MADEPROOF_BASE_URL=http://127.0.0.1:3210
export MADEPROOF_RUNNER_CREDENTIAL='mpr_...'
export MADEPROOF_RUNNER_ROOTS=/srv/repos/project
npm run runner
```

No inbound runner port is required.

## What the runner must never do

- never run as root in production;
- never mount the Docker socket;
- never request privileged containers;
- never expose host filesystem beyond the required read-only runtime pieces;
- never inherit ambient secrets;
- never enable network for executable checks unless the contract explicitly allows it;
- never claim a job outside its workspace;
- never report an incompatible protocol version as compatible.

## Registration

Register a runner with `POST /api/v1/runners`. The response contains a one-time `mpr_...` secret. Store it only as a hash; use it once to obtain a lease.
