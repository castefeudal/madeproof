# MADEPROOF architecture

MADEPROOF uses a modular control plane with separate worker and execution boundaries.

- **API/Web** — authentication, tenancy, contracts/runs, evidence intake, durable queue submission, receipts and runner control endpoints. It never executes target-repository commands.
- **PostgreSQL** — production source of truth. Verification and runner jobs are durable and claimed with leases; PostgreSQL claims use `FOR UPDATE SKIP LOCKED`.
- **Worker** — claims verification jobs, creates runner jobs, validates returned evidence, calculates conservative verdicts and creates immutable receipts.
- **Runner** — outbound-only client with no database credential. It executes only workspace/capability-compatible jobs and returns evidence under a short-lived lease.
- **MCP/CLI/SDK** — clients of the same control-plane invariants.

`POST /runs/:id/verify` means **enqueue independent verification** and returns HTTP 202. A verdict appears only after worker/runner processing.

Production migrations live in `packages/db/migrations/postgres`. `PostgresStore.migrate()` serializes migration runners with a PostgreSQL advisory lock and commits each migration plus its `schema_migrations` record atomically.

Failure semantics:

- API crash: queued jobs remain durable.
- Worker crash: expired worker lease is reclaimable; completed criterion results are preserved.
- Runner crash: expired job lease is requeued or times out after max attempts.
- Runner unavailable: executable criterion becomes infrastructure `ERROR`, never false `VERIFIED`.
- Cancellation: queue/runner work is cancelled and task/run leave active verification states.
