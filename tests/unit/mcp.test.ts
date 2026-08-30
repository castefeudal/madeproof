import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpMessage, toolDefinitions, type ToolBackend } from '../../apps/mcp/src/protocol.js';

function backend(): ToolBackend {
  return {
    createProject: async (input) => ({ id: 'prj', ...input }),
    createTask: async (input) => ({ id: 'tsk', ...input }),
    generateContract: async (taskId) => ({ id: 'contract', taskId }),
    getContract: async (taskId) => ({ id: 'contract', taskId }),
    updateContract: async (taskId, contract) => ({ ...contract, taskId }),
    startRun: async (taskId, input) => ({ id: 'run', taskId, ...input }),
    addEvidence: async (runId, input) => ({ id: 'evidence', runId, ...input }),
    verify: async (runId) => ({ runId, decision: { verdict: 'VERIFIED' } }),
    getVerdict: async (runId) => ({ runId, machine_verdict: 'VERIFIED' }),
    getFailedChecks: async () => [],
    retry: async (runId) => ({ id: 'retry', previousRunId: runId }),
    getReceipt: async (runId) => ({ id: 'receipt', runId }),
    listAttention: async () => [],
    getAgentReliability: async () => ({ status: 'INSUFFICIENT_SAMPLE' })
  };
}

test('MCP exposes strict structured schemas for every tool', () => {
  assert.equal(toolDefinitions.length, 15);
  for (const definition of toolDefinitions) {
    assert.equal(definition.inputSchema.type, 'object');
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.ok(!('input' in definition.inputSchema.properties) || Object.keys(definition.inputSchema.properties).length > 1);
  }
});

test('MCP initialize, list, and call work with structured content', async () => {
  const initialize = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28' } }, backend());
  assert.equal(initialize.result.serverInfo.name, 'madeproof');
  const list = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, backend());
  assert.equal(list.result.tools.length, 15);
  const call = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'madeproof_create_project', arguments: { name: 'MCP project' } } }, backend());
  assert.equal(call.result.structuredContent.name, 'MCP project');
  assert.equal(call.result.isError, false);
});

test('MCP rejects unknown arguments and unknown tools without executing them', async () => {
  const extra = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'madeproof_create_project', arguments: { name: 'x', secretOverride: true } } }, backend());
  assert.equal(extra.result.isError, true);
  assert.equal(extra.result.structuredContent.error.code, 'MCP_INVALID_ARGUMENTS');
  const unknown = await handleMcpMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'madeproof_make_it_green', arguments: {} } }, backend());
  assert.equal(unknown.result.isError, true);
  assert.equal(unknown.result.structuredContent.error.code, 'MCP_TOOL_NOT_FOUND');
});
