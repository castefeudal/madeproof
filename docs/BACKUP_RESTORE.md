# MADEPROOF backup & restore

PostgreSQL is the production source of truth. Evidence blobs live on the API/Worker
shared volume (`MADEPROOF_DATA_DIR`), so back up both.

## Backup

```bash
# Database (consistent snapshot; safe to run while the app is live)
docker compose -f infra/docker/compose.yml exec postgres \
  pg_dump -U madeproof -Fc madeproof > madeproof-$(date +%F).dump

# Evidence files
docker run --rm -v madeproof_evidence:/data -v "$PWD":/backup alpine \
  tar czf /backup/evidence-$(date +%F).tgz -C /data .
```

Automate daily with cron/systemd timers. Retain at least 7 daily + 4 weekly dumps.

## Restore

```bash
# 1. Stop writers, keep PostgreSQL up
docker compose -f infra/docker/compose.yml stop api worker

# 2. Restore the database
docker compose -f infra/docker/compose.yml exec -T postgres \
  pg_restore -U madeproof -d madeproof --clean --if-exists < madeproof-YYYY-MM-DD.dump

# 3. Restore evidence
docker run --rm -v madeproof_evidence:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/evidence-YYYY-MM-DD.tgz -C /data"

# 4. Start and verify
docker compose -f infra/docker/compose.yml up -d api worker
curl -fsS http://127.0.0.1:3210/health/ready
```

## Verification after restore

1. `GET /health/ready` returns 200 (migrations at expected version).
2. Sign in; the dashboard lists runs with their original verdicts.
3. Open a completed run — the receipt digest matches pre-backup records
   (digests are content-addressed; a mismatch means evidence or rows were lost).
4. Submit a demo verification end-to-end to prove the worker/runner path works.

## Migration compatibility

Migrations are additive and recorded in `schema_migrations`. Restoring a dump from
the same or older app version is always safe; `PostgresStore.migrate()` applies any
missing migrations on next boot. Restoring a newer dump under an older app version
is not supported — upgrade the app instead.

## Notes

- Receipts are immutable rows; they are never regenerated, only read.
- `pg_dump` does not include the evidence volume — always take both.
- Test restores quarterly into a scratch database:
  `pg_restore -U madeproof -d madeproof_restore_test --clean --if-exists`.
