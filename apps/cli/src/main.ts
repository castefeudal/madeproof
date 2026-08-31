import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MadeProof, MadeProofApiError } from '../../../packages/sdk/src/client.js';

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const filtered = args.filter((arg: string) => arg !== '--json');
const group = filtered[0];
const action = ['project', 'task', 'contract', 'run', 'evidence'].includes(group ?? '') ? filtered[1] : undefined;

function flag(name: string): string | undefined {
  const index = filtered.indexOf(`--${name}`);
  const value = index >= 0 ? filtered[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function requiredFlag(name: string): string {
  const value = flag(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const configPath = process.env.MADEPROOF_CLI_CONFIG ?? path.join(os.homedir(), '.config', 'madeproof', 'config.json');
function readConfig(): { baseUrl: string; apiKey: string } {
  if (process.env.MADEPROOF_API_KEY) return { baseUrl: process.env.MADEPROOF_BASE_URL ?? 'http://127.0.0.1:3210', apiKey: process.env.MADEPROOF_API_KEY };
  if (!fs.existsSync(configPath)) throw new Error('Not logged in. Run: madeproof login --base-url URL --api-key KEY');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}
function output(value: any): void {
  if (jsonMode) console.log(JSON.stringify(value));
  else console.log(JSON.stringify(value, null, 2));
}
function exit(code: number): never {
  process.exit(code);
  throw new Error('Process exit failed');
}

function help(): never {
  console.error(`MADEPROOF CLI

madeproof login --base-url URL --api-key KEY
madeproof project create --name NAME [--type web]
madeproof project list
madeproof task create --project ID --title TITLE --intent TEXT [--template frontend-bug-fix-demo]
madeproof task show --id ID
madeproof contract generate --task ID
madeproof contract show --task ID
madeproof run start --task ID [--metadata JSON]
madeproof evidence add --run ID --type TYPE --value JSON
madeproof verify --run ID
madeproof status --run ID
madeproof failures --run ID
madeproof retry --run ID [--metadata JSON]
madeproof receipt --run ID

Use --json for machine-readable output.`);
  return exit(1);
}

try {
  if (group === 'login') {
    const baseUrl = requiredFlag('base-url').replace(/\/$/, '');
    const apiKey = requiredFlag('api-key');
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(configPath, JSON.stringify({ baseUrl, apiKey }, null, 2), { mode: 0o600 });
    output({ ok: true, baseUrl, configPath });
    exit(0);
  }
  const client = new MadeProof(readConfig());
  let result: any;
  if (group === 'project' && action === 'create') result = await client.projects.create({ name: requiredFlag('name'), projectType: flag('type'), repositoryUrl: flag('repository') });
  else if (group === 'project' && action === 'list') result = await client.projects.list();
  else if (group === 'task' && action === 'create') result = await client.tasks.create({ projectId: requiredFlag('project'), title: requiredFlag('title'), intent: requiredFlag('intent'), template: flag('template') });
  else if (group === 'task' && action === 'show') result = await client.tasks.get(requiredFlag('id'));
  else if (group === 'contract' && action === 'generate') result = await client.contracts.generate(requiredFlag('task'));
  else if (group === 'contract' && action === 'show') result = await client.contracts.list(requiredFlag('task'));
  else if (group === 'run' && action === 'start') result = await client.runs.start(requiredFlag('task'), { metadata: flag('metadata') ? JSON.parse(flag('metadata')!) : undefined, artifactRef: flag('artifact') });
  else if (group === 'evidence' && action === 'add') result = await client.evidence.add(requiredFlag('run'), { type: requiredFlag('type'), value: JSON.parse(requiredFlag('value')), criterionId: flag('criterion') });
  else if (group === 'verify') {
    result = await client.verification.verify(requiredFlag('run'));
    output(result);
    const verdict = result.decision?.verdict;
    exit(verdict === 'VERIFIED' ? 0 : verdict === 'FAILED' ? 2 : verdict === 'REVIEW_REQUIRED' ? 3 : 4);
  } else if (group === 'status') result = await client.verification.get(requiredFlag('run'));
  else if (group === 'failures') result = await client.verification.failures(requiredFlag('run'));
  else if (group === 'retry') result = await client.runs.retry(requiredFlag('run'), { metadata: flag('metadata') ? JSON.parse(flag('metadata')!) : undefined, artifactRef: flag('artifact') });
  else if (group === 'receipt') result = await client.receipts.byRun(requiredFlag('run'));
  else help();
  output(result);
} catch (error) {
  const payload = error instanceof MadeProofApiError
    ? { error: { code: error.code, message: error.message, status: error.status, requestId: error.requestId } }
    : { error: { code: 'CLI_ERROR', message: error instanceof Error ? error.message : String(error) } };
  if (jsonMode) console.log(JSON.stringify(payload)); else console.error(JSON.stringify(payload, null, 2));
  exit(4);
}
