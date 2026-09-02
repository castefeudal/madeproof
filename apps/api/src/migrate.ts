import { loadConfig } from '../../../packages/config/src/runtime.js';
import { SqliteStore } from '../../../packages/db/src/sqlite-store.js';

const config = loadConfig();
if (config.databaseKind !== 'sqlite')
  throw new Error(
    'PostgreSQL migrations are SQL files under packages/db/migrations/postgres and must be applied by the deployment migration job.',
  );
const store = new SqliteStore(config.dataDir);
store.migrate();
store.close();
console.log('database migration PASS');
