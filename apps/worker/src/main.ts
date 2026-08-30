import path from 'node:path';
import { loadConfig } from '../../../packages/config/src/runtime.js';
import { SqliteDistributedStore } from '../../../packages/db/src/sqlite-distributed-store.js';
import { PostgresStore } from '../../../packages/db/src/postgres-store.js';
import type { MadeProofStore } from '../../../packages/db/src/store.js';
import { EvidenceService } from '../../../packages/evidence/src/evidence-service.js';
import { VerificationWorker } from './worker.js';

const config = loadConfig();
const store: MadeProofStore = config.databaseKind === 'postgres' ? new PostgresStore(config.databaseUrl!) : new SqliteDistributedStore(config.dataDir);
await store.migrate();
const worker = new VerificationWorker(store, new EvidenceService(config.dataDir), {
  baseUrl: config.publicBaseUrl,
  projectRoot: path.resolve(process.env.MADEPROOF_PROJECT_ROOT ?? process.cwd())
});
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  worker.stop();
  console.error(JSON.stringify({ component: 'madeproof-worker', workerId: worker.workerId, event: 'shutdown-requested' }));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
console.error(JSON.stringify({ component: 'madeproof-worker', workerId: worker.workerId, database: config.databaseKind }));
try { await worker.runLoop(); } finally { await store.close(); }
