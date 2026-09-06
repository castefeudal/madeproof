# MADEPROOF + AI Agent (MCP) — integration example

This example shows how to connect MADEPROOF to an AI agent over MCP
(Model Context Protocol). Works with **Claude Desktop**, **Claude Code**,
**Cursor**, **VS Code Copilot**, **Hermes** and any MCP-compatible host.

## 1. Run MADEPROOF

```bash
# local mode (SQLite, zero services)
npm install -g madeproof
madeproof init
madeproof start          # API on http://127.0.0.1:3210
```

In a second terminal:

```bash
madeproof worker         # durable verification worker
```

Register a runner via the API (or in the Web UI → Settings → Runners):

```bash
curl -X POST http://127.0.0.1:3210/api/v1/runners \
  -H "Authorization: Bearer <owner-api-key>" -H 'Content-Type: application/json' \
  -d '{"name":"local","version":"0.1.0","capabilities":["command","browser"]}'
# → {"secret":"mpr_..."} — copy it, shown once
```

Run the runner (outbound-only, polls the API):

```bash
MADEPROOF_BASE_URL=http://127.0.0.1:3210 \
MADEPROOF_RUNNER_CREDENTIAL=mpr_... \
madeproof runner
```

## 2. Create an API key for the agent

In the Web UI (Settings → API keys) create a key, or via API:

```bash
curl -X POST http://127.0.0.1:3210/api/v1/api-keys \
  -H "Authorization: Bearer <owner-api-key>" -H 'Content-Type: application/json' \
  -d '{"name":"my-agent"}'
```

## 3. Register the MCP server

Claude Desktop / Claude Code (`claude mcp add`) / Cursor — point your client at
the `madeproof` binary:

```json
{
  "mcpServers": {
    "madeproof": {
      "command": "madeproof",
      "args": ["mcp"],
      "env": {
        "MADEPROOF_BASE_URL": "http://127.0.0.1:3210",
        "MADEPROOF_API_KEY": "<agent-api-key>"
      }
    }
  }
}
```

Hermes (config.yaml → mcp.servers):

```yaml
mcp:
  servers:
    madeproof:
      command: madeproof
      args: ["mcp"]
      env:
        MADEPROOF_BASE_URL: "http://127.0.0.1:3210"
        MADEPROOF_API_KEY: "<agent-api-key>"
```

## 4. Available tools (15)

| Tool | Purpose |
| --- | --- |
| `madeproof_create_project` | Create a project (workspace) |
| `madeproof_create_task` | Create a task under a project |
| `madeproof_generate_contract` | Generate acceptance contract from task |
| `madeproof_get_contract` | Read contract & criteria |
| `madeproof_update_contract` | Update criteria before lock |
| `madeproof_start_run` | Start a verification run |
| `madeproof_add_evidence` | Attach evidence to a run |
| `madeproof_verify` | Submit run for independent verification |
| `madeproof_get_verdict` | Poll verdict (VERIFIED/FAILED/ERROR) |
| `madeproof_get_failed_checks` | Which criteria failed |
| `madeproof_get_required_actions` | What the agent must do next |
| `madeproof_retry` | Retry a run |
| `madeproof_get_receipt` | Immutable verification receipt |
| `madeproof_list_attention` | Items needing human attention |
| `madeproof_get_agent_reliability` | Agent's verified-track record |

## 5. Agent workflow (prompt pattern)

```
When you finish a task:
1. madeproof_create_project (if needed)
2. madeproof_create_task
3. madeproof_generate_contract
4. Do the work.
5. madeproof_start_run + madeproof_verify
6. Poll madeproof_get_verdict until VERIFIED/FAILED.
7. If FAILED: madeproof_get_failed_checks → fix → madeproof_retry.
8. Report the receipt id as proof.
```

## 6. Try it end-to-end (demo target)

```bash
cd examples/demo-target
npm install
node build.mjs          # builds a small artifact
node test.mjs           # runs tests that MADEPROOF will verify
```

Then create a contract whose criteria run `node test.mjs` in the sandbox —
MADEPROOF executes it independently and returns a verdict.
