import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { MadeProofError } from '../../shared/src/errors.js';

/**
 * Locate the SQL migration directory for the given database kind.
 *
 * Resolution works both from a repository checkout (source or `dist/` build)
 * and from container images where the working directory is the app root.
 */
export function findMigrationsDir(kind: 'sqlite' | 'postgres'): string {
  const moduleDir = path.dirname(url.fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'packages', 'db', 'migrations', kind),
    path.resolve(moduleDir, '../../../../packages/db/migrations', kind),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }
  throw new MadeProofError(
    'MIGRATIONS_NOT_FOUND',
    `Could not locate ${kind} migration files. Run from the repository root or install the package layout.`,
    500,
  );
}
