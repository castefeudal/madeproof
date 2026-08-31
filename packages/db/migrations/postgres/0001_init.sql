BEGIN;

CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_members (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK(role IN ('OWNER','ADMIN','MEMBER','VIEWER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id, user_id)
);
CREATE TABLE projects (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  project_type text NOT NULL DEFAULT 'software',
  repository_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, slug)
);
CREATE TABLE tasks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  intent text NOT NULL,
  template text,
  status text NOT NULL,
  latest_contract_version integer NOT NULL DEFAULT 0,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outcome_contracts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version integer NOT NULL,
  goal text NOT NULL,
  expected_outcome text NOT NULL,
  contract_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  UNIQUE(task_id, version)
);
CREATE TABLE acceptance_criteria (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contract_id text NOT NULL REFERENCES outcome_contracts(id) ON DELETE CASCADE,
  position integer NOT NULL,
  title text NOT NULL,
  required boolean NOT NULL,
  severity text NOT NULL,
  category text NOT NULL,
  verification_type text NOT NULL,
  criterion_json jsonb NOT NULL
);
CREATE TABLE runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  contract_id text NOT NULL REFERENCES outcome_contracts(id),
  contract_version integer NOT NULL,
  status text NOT NULL,
  attempt integer NOT NULL,
  agent_id text,
  artifact_ref text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, attempt)
);
CREATE TABLE evidence (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  criterion_id text,
  type text NOT NULL,
  source text NOT NULL,
  source_actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  observed_at timestamptz NOT NULL,
  content_hash text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  storage_location text NOT NULL,
  provenance text NOT NULL,
  trust_tier integer NOT NULL,
  sanitization_state text NOT NULL,
  value_json jsonb
);
CREATE TABLE verification_checks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  criterion_id text NOT NULL,
  type text NOT NULL,
  status text NOT NULL,
  config_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, criterion_id)
);
CREATE TABLE verification_results (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  check_id text NOT NULL REFERENCES verification_checks(id) ON DELETE CASCADE UNIQUE,
  criterion_id text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL,
  summary text NOT NULL,
  details_json jsonb NOT NULL,
  evidence_ids_json jsonb NOT NULL,
  confidence double precision NOT NULL,
  error_code text,
  error_message text
);
CREATE TABLE verdicts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE UNIQUE,
  machine_verdict text NOT NULL,
  human_verdict text,
  confidence double precision NOT NULL,
  reason text NOT NULL,
  decision_json jsonb NOT NULL,
  override_reason text,
  override_actor text,
  override_timestamp timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE receipts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE UNIQUE,
  receipt_version integer NOT NULL,
  receipt_json jsonb NOT NULL,
  digest text NOT NULL UNIQUE,
  signature text,
  signing_key_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE api_keys (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes_json jsonb NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  actor_type text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  timestamp timestamptz NOT NULL DEFAULT now(),
  previous_state_digest text,
  resulting_state_digest text,
  metadata_json jsonb NOT NULL
);
CREATE TABLE idempotency_records (
  workspace_id text NOT NULL,
  key text NOT NULL,
  route text NOT NULL,
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id, key, route)
);

CREATE INDEX projects_workspace_idx ON projects(workspace_id, created_at DESC);
CREATE INDEX tasks_workspace_status_idx ON tasks(workspace_id, status, updated_at DESC);
CREATE INDEX evidence_run_idx ON evidence(run_id, created_at);
CREATE INDEX audit_workspace_idx ON audit_events(workspace_id, timestamp DESC);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY projects_workspace_isolation ON projects
  USING (workspace_id = current_setting('madeproof.workspace_id', true));
CREATE POLICY tasks_workspace_isolation ON tasks
  USING (workspace_id = current_setting('madeproof.workspace_id', true));
CREATE POLICY contracts_workspace_isolation ON outcome_contracts
  USING (workspace_id = current_setting('madeproof.workspace_id', true));
CREATE POLICY runs_workspace_isolation ON runs
  USING (workspace_id = current_setting('madeproof.workspace_id', true));
CREATE POLICY evidence_workspace_isolation ON evidence
  USING (workspace_id = current_setting('madeproof.workspace_id', true));
CREATE POLICY verdicts_workspace_isolation ON verdicts
  USING (workspace_id = current_setting('madeproof.workspace_id', true));
CREATE POLICY receipts_workspace_isolation ON receipts
  USING (workspace_id = current_setting('madeproof.workspace_id', true));

COMMIT;
