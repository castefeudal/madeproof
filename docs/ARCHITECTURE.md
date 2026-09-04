# MADEPROOF architecture

A verification-first control plane for delegated AI work.

## Mental model

```text
  human / agent
       │  claims work is done
       ▼
  ┌─────────┐   202 QUEUED   ┌────────┐   lease   ┌────────┐
  │   API   │ ─────────────▶ │ Worker │ ────────▶ │ Runner │
  └─────────┘                └────────┘           └────────┘
       │                          │                    │
       ▼                          ▼                    ▼
  PostgreSQL ◀──────────── evidence ◀────────── isolated
  (source of truth)        (artifacts)        execution
       │
       ▼
   RECEIPT (immutable, digest-pinned)
```

## Components

| Component | Directory | Responsibility | Never does |
| --- | --- | --- | --- |
| **API** | `apps/api` | control plane: auth, tenancy, contracts, runs, evidence intake, queue submission, receipts, runner control | execute target commands |
| **Web** | `apps/web` | product UI: dashboard, runs, criteria, evidence, receipts | hold business rules |
| **Worker** | `apps/worker` | claims verification jobs, coordinates executable verification, validates evidence, computes conservative verdicts | talk to users |
| **Runner** | `apps/runner` | outbound-only execution boundary: isolated command execution, browser checks | listen inbound; hold DB credentials |
| **CLI** | `apps/cli` | terminal client: auth, submissions, status, results, receipts | duplicate server logic |
| **MCP** | `apps/mcp` | agent-facing surface over the same control plane | bypass tenancy |
| **SDK** | `packages/sdk` | typed programmatic client | log credentials |
| **Core** | `packages/core` | domain: contracts, state machine, verdicts, receipts | depend on apps |
| **Domain** | `packages/domain` | acceptance criteria, evidence model | — |
| **Evidence** | `packages/evidence` | provenance, trust tiers, hashing | claim a pass |
| **Verification** | `packages/verification` | check engines, aggregation, verdicts | trust self-reports |
| **DB** | `packages/db` | SQLite (dev) and PostgreSQL (production) stores, migrations | leak between workspaces |
| **Config** | `packages/config` | runtime configuration, validation | allow insecure production defaults |
| **Shared** | `packages/shared` | shared types and utilities | — |
| **Security** | `packages/security` | sandboxing, secret handling | weaken isolation to make tests pass |

## Data flow

1. A project, a task and a contract with acceptance criteria exist.
2. A run is started (`POST /runs`).
3. Evidence is attached — self-reported (`SELF_REPORTED`) or independently observed (`OBSERVED`).
4. The run is submitted for verification (`POST /runs/:id/verify` → **202 Accepted**).
5. The API enqueues a durable verification job in PostgreSQL.
6. A worker claims the job with a lease; expired leases are reclaimed after a crash.
7. The worker dispatches executable checks to a runner.
8. The runner executes inside Bubblewrap namespaces and returns evidence.
9. The worker validates the evidence and computes a conservative verdict.
10. A receipt is finalized — immutable, tied to the run and the criterion results.

`POST /runs/:id/verify` returns **202** — it means *verification has been queued*, never that a verdict exists.

## State machine

```
QUEUED → VERIFYING → VERIFIED
                  → FAILED
                  → ERROR
                  → CANCELLED
```

Aggregation is conservative:

- any criterion `FAILED` → verdict `FAILED`;
- any criterion `ERROR` → verdict `ERROR`;
- `VERIFIED` only when every mandatory criterion is `PASSED`;
- infrastructure errors never become proof of success.

## Stores

- **PostgreSQL** — production source of truth. Jobs claimed with `SELECT … FOR UPDATE SKIP LOCKED`. Migrations are additive, applied under an advisory lock, and recorded in `schema_migrations`.
- **SQLite** — local development and tests. Same domain semantics; not a production fallback.

See [RUNNER.md](./RUNNER.md) for the execution boundary and [SECURITY.md](./SECURITY.md) for the trust model.
