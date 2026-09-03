import { loadConfig } from '../../../packages/config/src/runtime.js';
import { PostgresStore } from '../../../packages/db/src/postgres-store.js';
import { SqliteStore } from '../../../packages/db/src/sqlite-store.js';

const config = loadConfig();
const store =
  config.databaseKind === 'postgres'
    ? new PostgresStore(config.databaseUrl!)
    : new SqliteStore(config.dataDir);
try {
  await store.migrate();
  console.log(`database migration PASS (${config.databaseKind})`);
} finally {
  await store.close();
}
