# Release Gate 002 — PostgreSQL worker + non-root runner boundary

Issue: GitHub #2.

Implemented:

- executable PostgreSQL store with atomic versioned migrations and advisory locking;
- durable verification and runner queues with lease, retry, recovery and cancellation semantics;
- separate worker process;
- outbound-only runner protocol with workspace-scoped hashed credentials;
- short-lived single-use job leases, version/capability enforcement and revocation;
- production fail-closed non-root runner policy;
- Bubblewrap filesystem/process/network isolation requirement;
- default-deny command network policy and environment allowlist;
- stale worker, replay, revocation, cross-workspace and cancellation regression tests;
- CI PostgreSQL clean-schema smoke and container sandbox checks.

Issue #2 may be closed only after GitHub CI independently proves:

1. quality/browser jobs green;
2. PostgreSQL clean migration and stale worker recovery green;
3. API/worker/runner container builds green;
4. runner image is non-root and executes the strong Bubblewrap sandbox smoke;
5. existing failed → retry → verified E2E remains green.
