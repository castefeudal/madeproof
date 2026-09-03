# MADEPROOF

**Do not trust completion claims. Verify the work.**

MADEPROOF is an evidence-first verification layer for delegated AI work. It exists because AI agents, developers, contractors and automated systems can *say* that work is finished — but only independent verification can establish whether the claimed result actually satisfies the contract.

A verification platform that simply believed the claim it received would defeat its own purpose. MADEPROOF is therefore built so that the verifying components never run the code under test, never share its database credentials, and never accept evidence at face value.

## What MADEPROOF does

When work is submitted for verification — a task completed by an AI agent, a developer, or a contractor — MADEPROOF:

1. **Queues** the verification job durably in PostgreSQL (HTTP `202 Accepted` means *queued*, not *done*).
2. **Claims** the job from the durable queue with a lease. Workers coordinate through PostgreSQL; stale leases from crashed workers are reclaimable.
3. **Dispatches** executable criteria to the Runner — an isolated, outbound-only execution boundary with no database credential.
4. **Executes** each acceptance criterion inside a strong Bubblewrap sandbox: non-root user, empty environment, network disabled by default, disposable workspace, resource limits, process-tree kill on timeout.
5. **Validates** returned evidence: every artifact is hashed, provenance-typed (`MACHINE`, `BROWSER`, `COMMAND`, `SELF_REPORTED`), and cross-checked against what the check actually produced. Self-reported claims are never accepted as proof on their own.
6. **Aggregates** criterion results into a conservative verdict: a run is `VERIFIED` only when every mandatory criterion independently `PASSED`. A criterion that errored, was skipped without a legitimate reason, or could not be executed makes the run `FAILED` or `ERROR` — never `VERIFIED`.
7. **Finalizes** an immutable receipt: a hash-chained, content-addressed summary of exactly what was evaluated, which evidence proved each criterion, and what the verdict was. Receipts are pinned to the run and the contract and cannot be rewritten.

## The core distinction

MADEPROOF never conflates these five things:

| Concept | Meaning |
| --- | --- |
| **CLAIM** | What the worker, agent or developer *says* happened. |
| **EVIDENCE** | Artifacts that may *support* the claim — logs, files, digests, screenshots. |
| **CHECK** | The deterministic or browser-based examination *performed* against the criteria. |
| **RESULT** | The per-criterion outcome: `PASSED`, `FAILED`, `ERROR`, `SKIPPED`. |
| **VERDICT** | The aggregate machine conclusion over all criteria: `VERIFIED`, `FAILED`, `ERROR`, `CANCELLED`. |

Evidence existing does not mean a criterion passed. A criterion erroring does not mean the work failed. An infrastructure failure never becomes proof that the work succeeded.

## Failure semantics

Independent verification is only meaningful if it is honest about failure. MADEPROOF's guarantees are therefore deliberately conservative:

- **API crash** — queued jobs remain durable; nothing is lost.
- **Worker crash** — expired leases are reclaimable; completed criterion results are preserved.
- **Runner crash** — expired job leases are requeued until `max_attempts`, then marked `TIMED_OUT`.
- **Runner unavailable** — an executable criterion becomes an infrastructure `ERROR`, never a false `VERIFIED`.
- **Cancellation** — pending runner jobs are cancelled and the task leaves active verification states.
- **A run is `VERIFIED` only after every mandatory criterion has actually passed.** There is no code path — not a timeout, not a crash, not a missing sandbox — that turns "we could not verify" into "verified".

## Architecture

```text
        ┌──────────────────────────────────────────────────────────────┐
        │                        API / Web                             │
        │  authentication · tenancy · contracts/runs · evidence intake  │
        │  durable queue submission · receipts · runner control         │
        └───────────────┬──────────────────────────────────────────────┘
                        │
                ┌───────▼────────┐
                │   PostgreSQL   │  production source of truth
                │  (durable queue, leases, receipts, evidence metadata)  │
                └───────┬────────┘
                        │ claims jobs (FOR UPDATE SKIP LOCKED)
                ┌───────▼────────┐
                │     Worker     │  coordinates verification
                └───────┬────────┘
                        │ creates runner jobs
                ┌───────▼────────┐
                │     Runner     │  outbound-only execution boundary
                │  (no DB credential, no inbound port, never runs
                │   arbitrary target commands, Bubblewrap isolation)  │
                └───────┬────────┘
                        │ executes criteria in sandbox
                        ▼
              isolated disposable workspace → evidence → verdict → receipt
```

- **API/Web** — control plane. Never imports or invokes the command runner. Never executes target-repository commands.
- **PostgreSQL** — production source of truth. Claims use `FOR UPDATE SKIP LOCKED` for safe concurrent consumption.
- **Worker** — durable job coordinator. Can be scaled horizontally; multiple workers never corrupt receipts.
- **Runner** — the only component that executes target-project commands. Runs as a dedicated non-root user with no inbound port and no database credential. Local development escape hatches (`MADEPROOF_RUNNER_ALLOW_ROOT`, `MADEPROOF_RUNNER_ALLOW_WEAK_SANDBOX`) are not valid production configurations.
- **MCP / CLI / SDK** — clients of the same control plane. They cannot bypass tenancy or runner authorization.

## Quick start

### Requirements

- Node.js `>= 22.16.0`
- PostgreSQL `>= 15` (production) — SQLite for local/demo mode
- Chromium (browser verification) — required for the browser E2E test

### Run locally (SQLite, zero external services)

```bash
npm ci
cp .env.example .env        # SQLite mode works out of the box
npm run build
npm run start               # API + Web on http://127.0.0.1:3210
```

### Run locally with PostgreSQL

```bash
export DATABASE_KIND=postgres
export DATABASE_URL=postgresql://madeproof:madeproof@127.0.0.1:5432/madeproof
npm run build
npm run start
```

### Run the full production stack

```bash
cp .env.example .env
docker compose -f infra/docker/compose.yml up -d --build
curl http://127.0.0.1:3210/health/ready
```

The stack starts PostgreSQL, API/Web, Worker and Runner with health checks. The runner registers with the API using a one-time `mpr_...` credential and polls outbound — it needs no inbound port and never receives database credentials.

## Components

| Package | Role |
| --- | --- |
| `apps/api` | Control plane: authentication, tenancy, contracts/runs, evidence intake, receipts, runner registration. |
| `apps/web` | Product UI: onboarding, dashboards, runs, evidence, receipts, verification timeline. |
| `apps/worker` | Durable verification coordinator. |
| `apps/runner` | Outbound-only execution boundary. |
| `apps/cli` | Developer CLI: local runs, status, receipts. |
| `apps/mcp` | MCP server for AI-agent integration. |
| `packages/config` | Runtime configuration and validation. |
| `packages/core` | Domain model: contracts, criteria, verdicts, receipts. |
| `packages/db` | SQLite + PostgreSQL stores, migrations, lease claims. |
| `packages/domain` | State machines and contract generation. |
| `packages/evidence` | Evidence intake, provenance typing, hashing. |
| `packages/sdk` | Typed TypeScript client for the API. |
| `packages/security` | Sandbox policy, runner isolation, URL safety. |
| `packages/shared` | Cross-cutting types and helpers. |
| `packages/verification` | Check executors: command, HTTP, browser (CDP). |

## Verification lifecycle

```text
POST /api/v1/runs/:id/verify
  → 202 QUEUED (durable verification job in PostgreSQL)
  → Worker claims job (lease)
  → Worker creates runner job (lease)
  → Runner claims runner job (short-lived lease)
  → Runner executes criteria in isolated workspace
  → Evidence returned and validated
  → Verdict calculated (conservative aggregation)
  → Receipt finalized (immutable, hash-chained)
  → Run VERIFIED / FAILED / ERROR
```

A `202` from the API is never the end state. It is the beginning of independent verification.

## Receipts

Every completed verification produces a receipt:

- deterministic digest over the exact criterion results and evidence;
- tied to the run and the contract;
- immutable after finalization;
- human-readable in the Web UI, machine-readable via `GET /runs/:id/receipt` and the CLI (`madeproof receipt <runId>`).

If optional Ed25519 signing keys are configured, receipts are additionally signed. MADEPROOF never implies stronger cryptographic guarantees than are actually configured — hashes are labeled as hashes, signatures as signatures.

## Security model

- **Non-root runner.** The runner image runs as user `node`. Local root operation requires an explicit, non-production opt-in.
- **No Docker socket.** The runner never mounts the host Docker socket and never requests privileged mode.
- **Strong isolation.** Executable criteria run under Bubblewrap with user/mount/PID/IPC/UTS/cgroup namespaces.
- **Network denied by default.** Checks must explicitly opt in to network access.
- **Outbound-only runner.** No inbound runner port. The runner polls the API; nothing connects to the runner.
- **Workspace-bound credentials.** Runner credentials are stored only as hashes, are workspace-bound, and are single-use per lease.
- **No ambient secrets.** The runner environment is cleared at spawn; only an explicit allowlist is re-added.
- **Control plane never executes target commands.** The API can enqueue verification; it cannot run the code under test.
- **No false VERIFIED.** There is no configuration, crash, timeout, or error path that produces `VERIFIED` without all mandatory criteria actually passing.

See [docs/SECURITY.md](docs/SECURITY.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the full model.

## Surfaces

| Surface | Entry point | Notes |
| --- | --- | --- |
| Web | `http://127.0.0.1:3210` | Product UI. |
| API | `http://127.0.0.1:3210/api/v1` | REST, OpenAPI at `/api/v1/openapi.json`. |
| Health | `/health/live`, `/health/ready` | Liveness and readiness. |
| CLI | `npx madeproof --help` | Local runs, status, receipts, JSON output. |
| MCP | `madeproof mcp` | MCP server for AI agents. |
| SDK | `import { MadeProofClient } from '@madeproof/sdk'` | Typed client, polling helper. |

## Development

```bash
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:security
npm run test:worker
npm run test:postgres      # requires Docker (service container in CI)
npm run test:e2e           # requires Chromium
npm run test:browser       # browser E2E via CDP
npm run test:sandbox       # strong-sandbox smoke test
npm run verify             # lint + typecheck + all tests
```

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for production deployment, including the Docker topology, health checks, migrations, and rollback procedure.

## License

MIT
