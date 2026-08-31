import type { MadeProofService, Actor } from '../../../packages/core/src/service.js';
import type { RuntimeConfig } from '../../../packages/config/src/runtime.js';
import type { MadeProof } from '../../../packages/sdk/src/client.js';
import { MadeProofError, asMadeProofError } from '../../../packages/shared/src/errors.js';
import { readJson, sendJson } from '../../api/src/http-utils.js';

const PROTOCOL_VERSION = '2026-07-28';

export const toolDefinitions = [
  tool('madeproof_create_project', 'Create a MADEPROOF project.', object({ name: string(), projectType: optional(string()), repositoryUrl: optional(string()) }, ['name'])),
  tool('madeproof_create_task', 'Create a verification task from human intent.', object({ projectId: string(), title: string(), intent: string(), template: optional(string()) }, ['projectId', 'title', 'intent'])),
  tool('madeproof_generate_contract', 'Generate an observable Outcome Contract.', object({ taskId: string() }, ['taskId'])),
  tool('madeproof_get_contract', 'Get the latest Outcome Contract.', object({ taskId: string() }, ['taskId'])),
  tool('madeproof_update_contract', 'Create a new contract version from an edited contract payload.', object({ taskId: string(), contract: { type: 'object' } }, ['taskId', 'contract'])),
  tool('madeproof_start_run', 'Lock the contract and start a run.', object({ taskId: string(), metadata: optional({ type: 'object' }), artifactRef: optional(string()), agentId: optional(string()) }, ['taskId'])),
  tool('madeproof_add_evidence', 'Submit evidence. Agent evidence remains self-reported until independently observed.', object({ runId: string(), criterionId: optional(string()), type: string(), value: {}, source: optional(string()) }, ['runId', 'type', 'value'])),
  tool('madeproof_verify', 'Run independent verification for a run.', object({ runId: string() }, ['runId'])),
  tool('madeproof_get_verdict', 'Get the latest machine verdict.', object({ runId: string() }, ['runId'])),
  tool('madeproof_get_failed_checks', 'Get failed, inconclusive, or errored checks.', object({ runId: string() }, ['runId'])),
  tool('madeproof_get_required_actions', 'Get concrete next actions from unresolved checks.', object({ runId: string() }, ['runId'])),
  tool('madeproof_retry', 'Create a new immutable retry run.', object({ runId: string(), metadata: optional({ type: 'object' }), artifactRef: optional(string()) }, ['runId'])),
  tool('madeproof_get_receipt', 'Get the immutable logical verification receipt.', object({ runId: string() }, ['runId'])),
  tool('madeproof_list_attention', 'List tasks that need human attention.', object({}, [])),
  tool('madeproof_get_agent_reliability', 'Get contextual reliability only when sample size is sufficient.', object({ agentId: optional(string()) }, []))
];

function string(): any { return { type: 'string', minLength: 1 }; }
function optional(schema: any): any { return schema; }
function object(properties: Record<string, any>, required: string[]): any { return { type: 'object', properties, required, additionalProperties: false }; }
function tool(name: string, description: string, inputSchema: any): any { return { name, description, inputSchema }; }

export interface ToolBackend {
  createProject(input: any): Promise<any>;
  createTask(input: any): Promise<any>;
  generateContract(taskId: string): Promise<any>;
  getContract(taskId: string): Promise<any>;
  updateContract(taskId: string, contract: any): Promise<any>;
  startRun(taskId: string, input: any): Promise<any>;
  addEvidence(runId: string, input: any): Promise<any>;
  verify(runId: string): Promise<any>;
  getVerdict(runId: string): Promise<any>;
  getFailedChecks(runId: string): Promise<any[]>;
  retry(runId: string, input: any): Promise<any>;
  getReceipt(runId: string): Promise<any>;
  listAttention(): Promise<any[]>;
  getAgentReliability(agentId?: string): Promise<any>;
}

export function serviceBackend(service: MadeProofService, actor: Actor): ToolBackend {
  return {
    createProject: async (input) => service.createProject(actor, input),
    createTask: async (input) => service.createTask(actor, input),
    generateContract: async (taskId) => service.generateContract(actor, taskId),
    getContract: async (taskId) => service.store.getContract(actor.workspaceId, taskId),
    updateContract: async (taskId, contract) => service.updateContract(actor, taskId, contract),
    startRun: async (taskId, input) => service.startRun(actor, taskId, input),
    addEvidence: async (runId, input) => service.addEvidence(actor, runId, input),
    verify: async (runId) => service.verify(actor, runId),
    getVerdict: async (runId) => service.getVerdict(actor, runId),
    getFailedChecks: async (runId) => service.getFailedChecks(actor, runId),
    retry: async (runId, input) => service.retry(actor, runId, input),
    getReceipt: async (runId) => service.getReceiptByRun(actor, runId),
    listAttention: async () => service.store.listAttention(actor.workspaceId),
    getAgentReliability: async (agentId) => service.agentReliability(actor, agentId)
  };
}

export function clientBackend(client: MadeProof): ToolBackend {
  return {
    createProject: async (input) => client.projects.create(input),
    createTask: async (input) => client.tasks.create(input),
    generateContract: async (taskId) => client.contracts.generate(taskId),
    getContract: async (taskId) => (await client.contracts.list(taskId)).items[0],
    updateContract: async (taskId, contract) => client.contracts.update(taskId, contract),
    startRun: async (taskId, input) => client.runs.start(taskId, input),
    addEvidence: async (runId, input) => client.evidence.add(runId, input),
    verify: async (runId) => client.verification.verify(runId),
    getVerdict: async (runId) => client.verification.verdict(runId),
    getFailedChecks: async (runId) => (await client.verification.failures(runId)).items,
    retry: async (runId, input) => client.runs.retry(runId, input),
    getReceipt: async (runId) => client.receipts.byRun(runId),
    listAttention: async () => (await client.attention.list()).items,
    getAgentReliability: async (agentId) => client.agents.reliability(agentId)
  };
}

function assertArguments(name: string, args: any): void {
  const definition = toolDefinitions.find((item) => item.name === name);
  if (!definition) throw new MadeProofError('MCP_TOOL_NOT_FOUND', `Unknown MCP tool: ${name}`, 404);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new MadeProofError('MCP_INVALID_ARGUMENTS', 'Tool arguments must be an object', 422);
  const allowed = new Set(Object.keys(definition.inputSchema.properties));
  for (const required of definition.inputSchema.required) if (!(required in args)) throw new MadeProofError('MCP_INVALID_ARGUMENTS', `${required} is required`, 422);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new MadeProofError('MCP_INVALID_ARGUMENTS', `${key} is not allowed`, 422);
}

async function callTool(backend: ToolBackend, name: string, args: any): Promise<any> {
  assertArguments(name, args);
  switch (name) {
    case 'madeproof_create_project': return backend.createProject(args);
    case 'madeproof_create_task': return backend.createTask(args);
    case 'madeproof_generate_contract': return backend.generateContract(args.taskId);
    case 'madeproof_get_contract': return backend.getContract(args.taskId);
    case 'madeproof_update_contract': return backend.updateContract(args.taskId, args.contract);
    case 'madeproof_start_run': return backend.startRun(args.taskId, args);
    case 'madeproof_add_evidence': return backend.addEvidence(args.runId, args);
    case 'madeproof_verify': return backend.verify(args.runId);
    case 'madeproof_get_verdict': return backend.getVerdict(args.runId);
    case 'madeproof_get_failed_checks': return backend.getFailedChecks(args.runId);
    case 'madeproof_get_required_actions': {
      const failed = await backend.getFailedChecks(args.runId);
      return failed.map((item) => ({ criterionId: item.criterionId, criterion: item.criterion?.title, status: item.status, expected: item.criterion?.expected, observed: item.details, nextAction: item.status === 'ERROR' ? 'Restore verifier infrastructure and retry.' : item.status === 'INCONCLUSIVE' ? 'Provide stronger evidence or complete human review.' : 'Fix the observed mismatch, create a retry run, and verify again.' }));
    }
    case 'madeproof_retry': return backend.retry(args.runId, args);
    case 'madeproof_get_receipt': return backend.getReceipt(args.runId);
    case 'madeproof_list_attention': return backend.listAttention();
    case 'madeproof_get_agent_reliability': return backend.getAgentReliability(args.agentId);
    default: throw new MadeProofError('MCP_TOOL_NOT_FOUND', `Unknown MCP tool: ${name}`, 404);
  }
}

export async function handleMcpMessage(message: any, backend: ToolBackend): Promise<any | null> {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const isNotification = message.id === undefined || message.id === null;
  if (isNotification && message.method === 'notifications/cancelled') return null;
  try {
    if (message.method === 'server/discover') {
      return { jsonrpc: '2.0', id: message.id, result: { supportedVersions: [PROTOCOL_VERSION], serverInfo: { name: 'madeproof', version: '0.1.0' }, serverCapabilities: { tools: { listChanged: false }, tasks: { polling: true } } } };
    }
    if (message.method === 'initialize') {
      return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'madeproof', version: '0.1.0' } } };
    }
    if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} };
    if (message.method === 'tools/list') return { jsonrpc: '2.0', id: message.id, result: { tools: toolDefinitions } };
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      try {
        const data = await callTool(backend, name, args);
        return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false } };
      } catch (error) {
        const safe = asMadeProofError(error);
        return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: { code: safe.code, message: safe.message } }) }], structuredContent: { error: { code: safe.code, message: safe.message } }, isError: true } };
      }
    }
    return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
  } catch (error) {
    const safe = asMadeProofError(error);
    return { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: safe.message, data: { code: safe.code } } };
  }
}

function decodeHeader(value: string): string {
  if (value.startsWith('=?base64?') && value.endsWith('?=')) return Buffer.from(value.slice(9, -2), 'base64').toString('utf8');
  return value;
}

export async function handleMcpHttp(input: { request: any; response: any; service: MadeProofService; actor: Actor; requestId: string; config: RuntimeConfig }): Promise<void> {
  const origin = input.request.headers.origin;
  if (origin && origin !== new URL(input.config.publicBaseUrl).origin) {
    return sendJson(input.response, 403, { jsonrpc: '2.0', error: { code: -32001, message: 'Origin rejected' } });
  }
  const body = await readJson(input.request);
  const protocol = String(input.request.headers['mcp-protocol-version'] ?? '');
  const methodHeader = String(input.request.headers['mcp-method'] ?? '');
  const nameHeader = input.request.headers['mcp-name'] ? decodeHeader(String(input.request.headers['mcp-name'])) : undefined;
  const bodyVersion = body?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  if (protocol !== PROTOCOL_VERSION || bodyVersion !== protocol) {
    return sendJson(input.response, 400, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32020, message: 'Header mismatch: unsupported or inconsistent MCP protocol version', data: { supported: [PROTOCOL_VERSION] } } });
  }
  if (methodHeader !== body.method || (body.method === 'tools/call' && nameHeader !== body.params?.name)) {
    return sendJson(input.response, 400, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32020, message: 'Header mismatch' } });
  }
  const response = await handleMcpMessage(body, serviceBackend(input.service, input.actor));
  if (!response) {
    input.response.writeHead(202);
    input.response.end();
    return;
  }
  sendJson(input.response, response.error?.code === -32601 ? 404 : 200, response);
}
