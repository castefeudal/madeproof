# MADEPROOF SDK

The typed SDK lets you drive MADEPROOF from TypeScript/JavaScript without raw
HTTP calls.

## Install

```bash
npm install madeproof
```

## Usage

```ts
import { MadeProof, MadeProofApiError } from 'madeproof';

const mp = new MadeProof({ baseUrl: 'http://127.0.0.1:3210', apiKey: '...' });

// Projects
const project = await mp.projects.create({ name: 'my-app' });

// Tasks
const task = await mp.tasks.create({
  projectId: project.id,
  title: 'Add login',
  intent: 'Implement email+password auth',
});

// Contract (acceptance criteria)
const contract = await mp.contracts.generate(task.id);

// Run + verification
const run = await mp.runs.start(task.id, { artifactRef: '1.0.0' });
await mp.verification.verify(run.id);          // 202 — queued, not done
const verdict = await mp.verification.verdict(run.id); // VERIFIED / FAILED / ERROR
const failures = await mp.verification.failures(run.id); // per-criterion results

// Immutable receipt
const receipt = await mp.receipts.byRun(run.id);
```

## API surface

The client mirrors the REST API 1:1 as nested namespaces. Every call returns a
typed payload; non-2xx responses throw `MadeProofApiError` with `.code`,
`.message`, `.status` and `.requestId`.

| Namespace | Methods |
| --- | --- |
| `projects` | `create({name, projectType?, repositoryUrl?})`, `list()`, `get(id)` |
| `tasks` | `create({projectId, title, intent, template?})`, `list(query?)`, `get(id)` |
| `contracts` | `generate(taskId)`, `update(taskId, input)`, `list(taskId)` |
| `runs` | `start(taskId, {metadata?, artifactRef?, agentId?})`, `get(id)`, `retry(id)` |
| `evidence` | `add(runId, {criterionId?, type, value, source?})`, `list(runId)` |
| `verification` | `verify(runId)`, `get(runId)`, `verdict(runId)`, `failures(runId)` |
| `receipts` | `byRun(runId)`, `get(receiptId)` |
| `attention` | `list()` |
| `agents` | `reliability(agentId?)` |

All mutating methods accept an optional trailing `idempotencyKey` for safe
retries.

## Notes

- This package is a thin, typed client of the same control plane the Web UI and
  CLI use. It cannot bypass tenancy or runner authorization.
- For agent integration prefer the MCP server (see [MCP.md](MCP.md)) — it gives
  the agent structured tools instead of code.
