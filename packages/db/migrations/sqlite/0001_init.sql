PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('OWNER','ADMIN','MEMBER','VIEWER')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  project_type TEXT NOT NULL DEFAULT 'software',
  repository_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, slug)
);
CREATE INDEX IF NOT EXISTS projects_workspace_idx ON projects(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  template TEXT,
  status TEXT NOT NULL,
  latest_contract_version INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_workspace_status_idx ON tasks(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS outcome_contracts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  goal TEXT NOT NULL,
  expected_outcome TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  locked_at TEXT,
  UNIQUE(task_id, version)
);
CREATE INDEX IF NOT EXISTS contracts_task_idx ON outcome_contracts(task_id, version DESC);

CREATE TABLE IF NOT EXISTS acceptance_criteria (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contract_id TEXT NOT NULL REFERENCES outcome_contracts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  required INTEGER NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  verification_type TEXT NOT NULL,
  criterion_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS criteria_contract_idx ON acceptance_criteria(contract_id, position);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  contract_id TEXT NOT NULL REFERENCES outcome_contracts(id),
  contract_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  agent_id TEXT,
  artifact_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, attempt)
);
CREATE INDEX IF NOT EXISTS runs_task_idx ON runs(task_id, attempt DESC);
CREATE INDEX IF NOT EXISTS runs_workspace_status_idx ON runs(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  criterion_id TEXT,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  source_actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_location TEXT NOT NULL,
  provenance TEXT NOT NULL,
  trust_tier INTEGER NOT NULL,
  sanitization_state TEXT NOT NULL,
  value_json TEXT
);
CREATE INDEX IF NOT EXISTS evidence_run_idx ON evidence(run_id, created_at);
CREATE INDEX IF NOT EXISTS evidence_hash_idx ON evidence(content_hash);

CREATE TABLE IF NOT EXISTS verification_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  plan_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_checks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, criterion_id)
);
CREATE INDEX IF NOT EXISTS checks_run_idx ON verification_checks(run_id);

CREATE TABLE IF NOT EXISTS verification_results (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  check_id TEXT NOT NULL REFERENCES verification_checks(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  summary TEXT NOT NULL,
  details_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  error_code TEXT,
  error_message TEXT,
  UNIQUE(check_id)
);
CREATE INDEX IF NOT EXISTS results_run_idx ON verification_results(run_id);

CREATE TABLE IF NOT EXISTS verdicts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE UNIQUE,
  machine_verdict TEXT NOT NULL,
  human_verdict TEXT,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  override_reason TEXT,
  override_actor TEXT,
  override_timestamp TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE UNIQUE,
  receipt_version INTEGER NOT NULL,
  receipt_json TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  signature TEXT,
  signing_key_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_keys_workspace_idx ON api_keys(workspace_id);

CREATE TABLE IF NOT EXISTS runner_registrations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  last_heartbeat_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  external_id TEXT,
  config_encrypted TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, kind, external_id)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  provider TEXT NOT NULL,
  external_delivery_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE(provider, external_delivery_id)
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key, route)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  previous_state_digest TEXT,
  resulting_state_digest TEXT,
  metadata_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_workspace_idx ON audit_events(workspace_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  actor_id TEXT,
  resource_id TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_workspace_idx ON usage_events(workspace_id, created_at DESC);
