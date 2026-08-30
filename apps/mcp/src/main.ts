import readline from 'node:readline';
import { MadeProof } from '../../../packages/sdk/src/client.js';
import { clientBackend, handleMcpMessage } from './protocol.js';

const baseUrl = process.env.MADEPROOF_BASE_URL ?? 'http://127.0.0.1:3210';
const apiKey = process.env.MADEPROOF_API_KEY;
if (!apiKey) {
  console.error('MADEPROOF_API_KEY is required for stdio MCP mode.');
  process.exit(1);
}
const backend = clientBackend(new MadeProof({ baseUrl, apiKey }));
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async (line: string) => {
  if (!line.trim()) return;
  let message: any;
  try { message = JSON.parse(line); }
  catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
    return;
  }
  const response = await handleMcpMessage(message, backend);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
});
lines.on('close', () => process.exit(0));
