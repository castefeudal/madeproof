import path from 'node:path';
import { MadeProofError } from '../../shared/src/errors.js';

export interface RuntimeConfig {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  dataDir: string;
  publicBaseUrl: string;
  adminEmail: string;
  adminPassword: string;
  sessionSecret: string;
  encryptionKey: string;
  databaseKind: 'sqlite' | 'postgres';
  databaseUrl?: string;
}

export function loadConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const env = (overrides.env ?? process.env.NODE_ENV ?? 'development') as RuntimeConfig['env'];
  const port = overrides.port ?? Number(process.env.PORT ?? 3210);
  const host = overrides.host ?? process.env.HOST ?? '127.0.0.1';
  const databaseKind = (overrides.databaseKind ??
    process.env.DATABASE_KIND ??
    'sqlite') as RuntimeConfig['databaseKind'];
  const config: RuntimeConfig = {
    env,
    host,
    port,
    dataDir: path.resolve(overrides.dataDir ?? process.env.MADEPROOF_DATA_DIR ?? '.madeproof-data'),
    publicBaseUrl:
      overrides.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? `http://${host}:${port}`,
    adminEmail: overrides.adminEmail ?? process.env.MADEPROOF_ADMIN_EMAIL ?? 'owner@localhost',
    adminPassword:
      overrides.adminPassword ?? process.env.MADEPROOF_ADMIN_PASSWORD ?? 'madeproof-local',
    sessionSecret:
      overrides.sessionSecret ??
      process.env.SESSION_SECRET ??
      'development-only-session-secret-change-me',
    encryptionKey:
      overrides.encryptionKey ??
      process.env.ENCRYPTION_KEY ??
      'development-only-encryption-key-change-me',
    databaseKind,
    databaseUrl: overrides.databaseUrl ?? process.env.DATABASE_URL,
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new MadeProofError('CONFIG_INVALID', 'PORT must be a valid TCP port', 500);
  if (config.env === 'production') {
    if (config.adminPassword === 'madeproof-local' || config.adminPassword.length < 14)
      throw new MadeProofError(
        'CONFIG_INVALID',
        'Production admin password must be explicitly configured and at least 14 characters',
        500,
      );
    if (config.sessionSecret.length < 32)
      throw new MadeProofError(
        'CONFIG_INVALID',
        'SESSION_SECRET must be at least 32 characters',
        500,
      );
    if (config.encryptionKey.length < 32)
      throw new MadeProofError(
        'CONFIG_INVALID',
        'ENCRYPTION_KEY must be at least 32 characters',
        500,
      );
    if (databaseKind !== 'postgres')
      throw new MadeProofError(
        'CONFIG_INVALID',
        'Production mode requires DATABASE_KIND=postgres',
        500,
      );
    if (!config.databaseUrl)
      throw new MadeProofError('CONFIG_INVALID', 'DATABASE_URL is required in production', 500);
  }
  return config;
}
