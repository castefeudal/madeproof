# MADEPROOF deployment

MADEPROOF ships as four process boundaries. Deploy them separately; never collapse
the Runner into the API process.

```text
PostgreSQL <---- API/Web <---- Worker
     ^              ^             |
     |              |             v (creates runner jobs)
     +-- migrations +        Runner (outbound poll only;
                             no DB credential, no docker socket)
```

## Requirements

- Docker Engine 24+ with Compose v2, **or**
- Node.js >= 22.16 and PostgreSQL 15+ for bare-metal deployment.
- A Linux host for the Runner (Bubblewrap requires user namespaces).

## One-command production stack

```bash
cp .env.example .env
# Edit .env:
#   DATABASE_KIND=postgres
#   POSTGRES_PASSWORD=<strong>
#   SESSION_SECRET=$(openssl rand -hex 32)
#   ENCRYPTION_KEY=$(openssl rand -base64 32)
#   MADEPROOF_ADMIN_EMAIL=you@example.com
#   MADEPROOF_ADMIN_PASSWORD=<strong>
#   PUBLIC_BASE_URL=https://madeproof.example.com
docker compose -f infra/docker/compose.yml up -d --build
```

This starts PostgreSQL, runs migrations on boot (serialized by a PostgreSQL advisory
lock, so scaling API replicas is safe), the API/Web control plane on port 3210, and
the Worker. Health:

- `GET /health/live` — process is up.
- `GET /health/ready` — database reachable and migrated.

## Registering a Runner

Runners are outbound-only. Register one per execution host:

```bash
curl -X POST https://madeproof.example.com/api/v1/runners \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"name":"runner-1","version":"0.1.0","capabilities":["command","browser"]}'
```

The response contains a **one-time** `mpr_...` secret. On the execution host:

```bash
export NODE_ENV=production
export MADEPROOF_RUNNER_BASE_URL=https://madeproof.example.com
export MADEPROOF_RUNNER_CREDENTIAL='mpr_...'   # consumed on first poll
export MADEPROOF_RUNNER_ROOTS=/srv/repos
npm run runner        # or: docker run madeproof-runner:ci
```

The Runner has no `DATABASE_URL`, no inbound port, no Docker socket. It polls
`POST /api/v1/runner/poll`, executes each job inside Bubblewrap (user/mount/PID/IPC/
UTS namespaces, network off by default, resource limits via `prlimit`), and reports
evidence back under a short-lived single-use lease.

## Bare-metal (non-Docker)

```bash
npm ci
npm run build
NODE_ENV=production DATABASE_KIND=postgres DATABASE_URL=postgresql://... npm run db:migrate
NODE_ENV=production ... npm start            # API/Web
NODE_ENV=production ... npm run worker       # Worker (scale N)
NODE_ENV=production ... npm run runner       # per execution host
```

## Rollback

1. `docker compose -f infra/docker/compose.yml down api worker` (keep PostgreSQL up).
2. Check out the previous release tag, rebuild images, `up -d`.
3. Migrations are additive; rolling back the app does not require schema downgrade.
   If a rollback across a schema change is required, restore from backup
   (see [BACKUP_RESTORE.md](BACKUP_RESTORE.md)).

## Scaling notes

- **API** is stateless besides evidence on disk; run N replicas behind a load balancer
  with sticky-free routing (sessions are signed cookies; `ENCRYPTION_KEY` must match).
- **Worker** scale with `docker compose up -d --scale worker=3`; job claims use
  `FOR UPDATE SKIP LOCKED` leases so workers never double-process.
- **Runner** scale per host based on queue depth; revoke and re-register credentials
  when rotating hosts.
