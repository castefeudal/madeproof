# MADEPROOF security model

MADEPROOF verifies claims made about delegated work. Its security goal is that a
**false verdict cannot be produced** by any compromised component short of the
control plane itself.

## Trust boundaries

| Boundary | Rule |
|---|---|
| API (control plane) | Only surface that touches PostgreSQL. Never executes target-repo commands. |
| Worker | Claims jobs via leases. Validates evidence, computes verdicts. No public port. |
| Runner | Outbound HTTPS poll only. No DB credential, no inbound port, no Docker socket. |
| PostgreSQL | Source of truth. Only API connects. `FOR UPDATE SKIP LOCKED` for job claims. |

## Isolation guarantees

- **Runner never runs as root** (`USER node`, verified in CI).
- **Bubblewrap**: user + mount + PID + IPC + UTS namespaces, cgroup limits,
  network off by default, `/proc` and `/dev` minimal, ephemeral read-write
  workspace, read-only system roots.
- **No Docker socket** is mounted anywhere in the stack.
- **No privileged containers**; capability allowlist is explicit.
- **Control plane does not execute repo commands** — it only persists jobs and
  evidence; execution happens exclusively in the Runner process.

## Verification truth model

`CLAIM → EVIDENCE → CHECK → RESULT → VERDICT → RECEIPT`

- A claim is never evidence.
- Evidence is hashed and content-addressed.
- A check that cannot run is `ERROR`, never `PASSED`.
- Aggregation is conservative: any non-`PASSED` criterion forces `FAILED` verdict.
- Receipts are immutable rows, written once, with a content digest.

## Authentication & tenancy

- Workspace-scoped actors; every query filters by `workspace_id`.
- IDOR is prevented by scoping all reads/writes to the caller's workspace.
- Runner credentials are one-time `mpr_...` tokens, hashed at rest, consumed on
  first poll, non-replayable; leases are single-use with TTL.
- API keys carry explicit scopes; revocation is immediate.
- Sessions are signed cookies (HttpOnly, Secure, SameSite=Lax) bound to
  `ENCRYPTION_KEY`; rotating the key invalidates sessions.

## Input safety

- Filenames are sanitized (no traversal, no symlink escape; `MADEPROOF_RUNNER_ROOTS`
  is the only writable root and is path-checked).
- Server-side fetches reject loopback/link-local/metadata/private-range targets and
  non-HTTP(S) schemes.
- Environment variables are allowlisted; inherited secrets are cleared before
  spawning any process.
- Output size caps on command stdout/stderr.

## CI enforcement

GitHub Actions runs, on every push/PR: lint, format check, typecheck, unit,
integration, security, worker/runner, PostgreSQL-backed integration, E2E,
browser (Chromium via CDP), strong-sandbox smoke, and a production image build
with a non-root assertion. A red gate blocks merge.

## Reporting

Security issues: open a private GitHub security advisory rather than a public issue.
