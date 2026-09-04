import readline from 'node:readline';
import { SafeCommandRunner } from './command-runner.js';

const runner = new SafeCommandRunner();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
console.error(
  JSON.stringify({
    runner: 'madeproof-local',
    version: '0.1.0',
    capabilities: [
      'command',
      'network-disabled-linux-namespace',
      'resource-limits',
      'ephemeral-copy',
    ],
  }),
);
input.on('line', async (line: string) => {
  if (!line.trim()) return;
  try {
    const job = JSON.parse(line);
    const result = await runner.execute(job);
    process.stdout.write(`${JSON.stringify({ id: job.id ?? null, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } })}\n`,
    );
  }
});
