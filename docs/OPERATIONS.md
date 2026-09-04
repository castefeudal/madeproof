# MADEPROOF operations

Daily procedures for a running MADEPROOF installation.

## Startup / shutdown / restart

```bash
docker compose -f infra/docker/compose.yml up -d            # start
docker compose -f infra/docker/compose.yml down             # stop (keeps data)
docker compose -f infra/docker/compose.yml restart api      # restart one process
docker compose -f infra/docker/compose.yml up -d --scale worker=3   # scale workers
```

Bare-metal: `npm start` (API), `npm run worker` (Worker), `npm run runner` (Runner).

## Migrations

Migrations run automatically on API boot, serialized by a PostgreSQL advisory lock.
Run manually with:

```bash
npm run db:migrate                     # applies pending migrations
npm run db:seed                        # creates the admin workspace (dev only)
```

Applied versions live in `schema_migrations`; re-running is a no-op.

## Worker scaling and stuck jobs

- Claims use `FOR UPDATE SKIP LOCKED` leases with expiry; a crashed worker's jobs
  become reclaimable after the lease TTL (default 60 s).
- Diagnose a stuck job:

  ```sql
  SELECT id, kind, status, attempts, lease_expires_at
  FROM verification_jobs WHERE status IN ('RUNNING','QUEUED')
  ORDER BY created_at DESC LIMIT 20;
  ```

  A `RUNNING` row whose lease expired will be picked up by any healthy worker.
- Force-requeue a wedged job: `UPDATE verification_jobs SET status='QUEUED',
  lease_expires_at=NULL WHERE id='<id>';`

## Logs

- Containers log JSON to stdout: `docker compose logs -f api worker runner`.
- Structured fields: `ts`, `level`, `component`, `workerId`, `runnerId`, `runId`,
  `jobId`, `requestId`. Secrets (`credential`, `SESSION_SECRET`, `ENCRYPTION_KEY`)
  are never logged.

## Database health

```bash
curl -fsS http://127.0.0.1:3210/health/ready       # migrations applied, DB reachable
docker compose exec postgres pg_isready -U madeproof
```

## Emergency runner revocation

```bash
# Revoke a runner credential immediately (revoked runners stop receiving jobs):
curl -X DELETE https://madeproof.example.com/api/v1/runners/<runnerId> \
  -H "Authorization: Bearer <api-key>"
# Outstanding leases are single-use; they expire at their TTL and cannot be replayed.
```

## API key revocation

```bash
curl -X DELETE https://madeproof.example.com/api/v1/keys/<keyId> \
  -H "Authorization: Bearer <api-key>"      # key stops working at once
```

## Rollback

1. Stop app containers, keep PostgreSQL: `compose stop api worker`.
2. Deploy the previous release tag (see DEPLOYMENT.md → Rollback).
3. Migrations are additive — no schema downgrade is normally required. Only if a
   rollback crosses a schema change, restore from backup (BACKUP_RESTORE.md).

## Backup schedule

Nightly `pg_dump -Fc` + evidence tar (see BACKUP_RESTORE.md). Retain 7 daily,
4 weekly. Restore drill once per quarter into a scratch database.
