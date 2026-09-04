# MADEPROOF quickstart

MADEPROOF verifies claims about delegated work: an agent says "done", MADEPROOF
independently runs the acceptance criteria and returns criterion-level results,
a machine verdict and a receipt.

## 1. Run locally (SQLite, zero external services)

```bash
git clone https://github.com/castefeudal/madeproof && cd madeproof
npm install
npm run dev            # API+Web on http://127.0.0.1:3210
```

Sign in with the seeded owner account (default `owner@localhost` /
`madeproof-local`, override with `MADEPROOF_ADMIN_EMAIL` / `MADEPROOF_ADMIN_PASSWORD`).
In a second terminal add a worker and a runner:

```bash
npm run worker
```

Runners are registered in the UI (**Settings → Runners**) or via the API:

```bash
curl -X POST http://127.0.0.1:3210/api/v1/runners \
  -H "Authorization: Bearer <api-key>" -H 'Content-Type: application/json' \
  -d '{"name":"local","version":"0.1.0","capabilities":["command","browser"]}'
# → {"secret":"mpr_..."} — copy it, it is shown once

MADEPROOF_RUNNER_BASE_URL=http://127.0.0.1:3210 \
MADEPROOF_RUNNER_CREDENTIAL='mpr_...' \
npm run runner
```

## 2. Try the built-in demo (30 seconds)

In the web UI: **Demo → Run failing verification**. MADEPROOF runs a real
Chromium check against the bundled demo target, the broken scenario fails
(`FAILED` verdict with per-criterion results), then **Retry with fixed
artifact** re-verifies against the fixed target and the run becomes `VERIFIED`
with an immutable receipt. Nothing is faked — the same worker/runner path a
production workload uses executes both runs.

## 3. Verify your own work

1. Create a **project** and a **task** describing the delegated work.
2. Generate a **contract**: MADEPROOF proposes acceptance criteria
   (command / HTTP / browser / file checks) that you can edit.
3. Start a **run** for the artifact version you want checked.
4. Attach **evidence** if you have it (optional — runner checks produce their own).
5. Press **Verify**. The API returns `202 Accepted`; a worker claims the job,
   the runner executes the checks in isolation, and the run page live-polls
   until results appear.
6. Inspect per-criterion results, open the **receipt** (content-hashed,
   immutable), and use **Retry** on the fixed artifact to re-verify.

## 4. PostgreSQL / Docker (production shape)

```bash
cp .env.example .env   # set DATABASE_KIND=postgres, strong SESSION_SECRET, ENCRYPTION_KEY
docker compose -f infra/docker/compose.yml up -d
```

This starts PostgreSQL, the API/Web, the worker and (optionally) a runner
container. See `docs/DEPLOYMENT.md`.

## 5. Clients

```bash
npm run cli -- login --base-url http://127.0.0.1:3210 --api-key KEY
npm run cli -- project create --name "My project"
npm run cli -- verify --run run_xxx          # exit code: 0 verified, 2 failed
```

MCP: run `npm run mcp` and point your MCP client at it (see `docs/MCP.md`).
SDK: `import { MadeProof } from './packages/sdk/src/client.js'` (see `docs/SDK.md`).

## Tests

```bash
npm run verify          # lint + format + typecheck + unit + integration + security + e2e + browser
npm run test:postgres   # needs TEST_POSTGRES_URL
npm run test:sandbox    # Bubblewrap isolation smoke (Linux)
```
