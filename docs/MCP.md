# MADEPROOF MCP

MADEPROOF ships a Model Context Protocol (MCP) server that lets AI agents drive
the full verification lifecycle.

## Running the MCP server

The MCP server speaks MCP over **stdio** and needs a base URL and API key:

```bash
MADEPROOF_BASE_URL=http://127.0.0.1:3210 \
MADEPROOF_API_KEY=<agent-api-key> \
madeproof mcp
```

From source:

```bash
MADEPROOF_BASE_URL=http://127.0.0.1:3210 \
MADEPROOF_API_KEY=<agent-api-key> \
npm run mcp
```

## Tools (15)

| Tool | Description |
| --- | --- |
| `madeproof_create_project` | Create a project (workspace) |
| `madeproof_create_task` | Create a task |
| `madeproof_generate_contract` | Generate acceptance criteria from a task |
| `madeproof_get_contract` | Read contract and criteria |
| `madeproof_update_contract` | Update criteria before the contract is locked |
| `madeproof_start_run` | Start a run for a contract/artifact |
| `madeproof_add_evidence` | Attach evidence to a run |
| `madeproof_verify` | Queue the run for independent verification |
| `madeproof_get_verdict` | Get the aggregated verdict |
| `madeproof_get_failed_checks` | List failing criteria with details |
| `madeproof_get_required_actions` | What must happen next (agent/human) |
| `madeproof_retry` | Retry a run (after fixes) |
| `madeproof_get_receipt` | Get the immutable verification receipt |
| `madeproof_list_attention` | Items needing human attention |
| `madeproof_get_agent_reliability` | Verified track record per agent |

Every tool uses a strict JSON schema (unknown args are rejected), and the
protocol is transport-agnostic: the same handlers serve stdio and HTTP MCP.

## Client registration

See [examples/mcp-agent-integration/README.md](../examples/mcp-agent-integration/README.md)
for Claude Desktop / Claude Code / Cursor / VS Code / Hermes configuration and a
full agent workflow pattern.

## Design constraints

- The MCP server is a **client of the control plane** — it cannot bypass
  tenancy or runner authorization.
- Tools that mutate state require a valid API key with write scope.
- `verify` returns `202` semantics: it queues durable verification; the verdict
  arrives after the worker/runner execute the criteria.
