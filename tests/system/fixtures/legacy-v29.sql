-- Frozen schema produced by the last v29 release. Do not regenerate this file
-- from current migration code: it is intentionally an independent upgrade input.
CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL, original_name TEXT NOT NULL, created_at TEXT NOT NULL,
  remote_url TEXT, remote_key TEXT, remote_status TEXT, abs_path TEXT
);
CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, label TEXT,
  created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, default_model TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL, name TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL,
  created_at TEXT NOT NULL, setup_status TEXT NOT NULL DEFAULT 'pending',
  setup_output TEXT NOT NULL DEFAULT '', setup_started_at TEXT, setup_finished_at TEXT,
  pokemon_number INTEGER, UNIQUE(project_id, path)
);
CREATE TABLE chats (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL, title TEXT NOT NULL,
  active_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, archived_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_worktree_json TEXT,
  last_message_at TEXT, last_read_at TEXT,
  origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
  archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cursor TEXT,
  resume_strategy TEXT NOT NULL DEFAULT 'none',
  runtime_mode TEXT NOT NULL DEFAULT 'approval-required', agents_json TEXT,
  worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
  permission_mode TEXT NOT NULL DEFAULT 'default', tool_search INTEGER NOT NULL DEFAULT 0,
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  forked_from_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  forked_from_message_id TEXT, queue_paused INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL, kind TEXT NOT NULL, content_json TEXT NOT NULL,
  created_at TEXT NOT NULL, parent_item_id TEXT, sequence INTEGER
);
CREATE TABLE permission_decisions (
  request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind_tag TEXT NOT NULL, kind_key TEXT NOT NULL, kind_json TEXT NOT NULL,
  decision TEXT NOT NULL, decided_at TEXT NOT NULL, project_id TEXT,
  scope TEXT NOT NULL DEFAULT 'session'
);
CREATE TABLE queued_messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  queue_order INTEGER NOT NULL, input_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  stream_kind TEXT NOT NULL, stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL,
  type TEXT NOT NULL, occurred_at TEXT NOT NULL, actor TEXT, payload_json TEXT NOT NULL,
  UNIQUE (stream_kind, stream_id, stream_version)
);
CREATE TABLE message_attachments (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id), PRIMARY KEY (message_id, attachment_id)
);
CREATE TABLE pokemon_unlocks (
  pokemon_number INTEGER PRIMARY KEY,
  worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL, unlocked_at TEXT NOT NULL
);
CREATE TABLE relay_config (
  environment_id TEXT PRIMARY KEY, relay_url TEXT NOT NULL, relay_issuer TEXT NOT NULL,
  environment_credential TEXT NOT NULL, updated_at TEXT NOT NULL, label TEXT,
  connector_token TEXT, tunnel_hostname TEXT, relay_mint_public_key TEXT
);
CREATE TABLE repository_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  default_provider_id TEXT, default_model TEXT, default_runtime_mode TEXT,
  auto_create_worktree INTEGER NOT NULL DEFAULT 0, worktree_base_dir TEXT,
  archive_cleanup_script TEXT, archive_remove_worktree INTEGER NOT NULL DEFAULT 0,
  setup_script TEXT, run_script TEXT, auto_run_after_setup INTEGER NOT NULL DEFAULT 0,
  environment_variables_json TEXT
);
CREATE TABLE environment_identity (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, signing_secret TEXT,
  private_key_jwk TEXT, public_key_jwk TEXT
);
CREATE TABLE effect_sql_migrations (
  migration_id INTEGER PRIMARY KEY NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  name VARCHAR(255) NOT NULL
);
CREATE INDEX idx_attachments_session ON attachments(session_id, created_at);
CREATE INDEX idx_auth_tokens_active_hash ON auth_tokens(token_hash, revoked_at);
CREATE INDEX idx_chats_project ON chats(project_id);
CREATE INDEX idx_events_stream ON events(stream_kind, stream_id, sequence);
CREATE INDEX idx_message_attachments_attachment ON message_attachments(attachment_id);
CREATE INDEX idx_messages_parent_item ON messages(session_id, parent_item_id);
CREATE INDEX idx_messages_session ON messages(session_id, created_at);
CREATE INDEX idx_messages_session_sequence ON messages(session_id, sequence);
CREATE INDEX idx_permission_decisions_project ON permission_decisions(project_id, kind_tag, kind_key);
CREATE INDEX idx_permission_decisions_session ON permission_decisions(session_id, kind_tag, kind_key);
CREATE INDEX idx_pokemon_unlocks_worktree ON pokemon_unlocks(worktree_id);
CREATE INDEX idx_queued_messages_session_position ON queued_messages(session_id, queue_order);
CREATE INDEX idx_queued_messages_session_queue_order ON queued_messages(session_id, queue_order);
CREATE INDEX idx_sessions_chat ON sessions(chat_id);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX idx_sessions_project ON sessions(project_id, archived_at, updated_at DESC);
CREATE INDEX idx_worktrees_project ON worktrees(project_id, created_at DESC);
INSERT INTO effect_sql_migrations (migration_id, created_at, name) VALUES
  (1, '2024-01-01 00:00:00', 'initial'),
  (2, '2024-01-01 00:00:00', 'permissions'),
  (3, '2024-01-01 00:00:00', 'resume_and_export'),
  (4, '2024-01-01 00:00:00', 'permission_scope'),
  (5, '2024-01-01 00:00:00', 'runtime_mode'),
  (6, '2024-01-01 00:00:00', 'attachments'),
  (7, '2024-01-01 00:00:00', 'subagents'),
  (8, '2024-01-01 00:00:00', 'worktrees_and_repo_settings'),
  (9, '2024-01-01 00:00:00', 'permission_mode_and_tool_search'),
  (10, '2024-01-01 00:00:00', 'nested_sessions'),
  (11, '2024-01-01 00:00:00', 'chats_table'),
  (12, '2024-01-01 00:00:00', 'chat_id_not_null'),
  (13, '2024-01-01 00:00:00', 'archive_cleanup'),
  (14, '2024-01-01 00:00:00', 'scripts_and_setup'),
  (15, '2024-01-01 00:00:00', 'queued_messages'),
  (16, '2024-01-01 00:00:00', 'queued_messages_queue_order_repair'),
  (17, '2024-01-01 00:00:00', 'chat_read_state'),
  (18, '2024-01-01 00:00:00', 'pokemon_worktrees'),
  (19, '2024-01-01 00:00:00', 'queue_paused'),
  (20, '2024-01-01 00:00:00', 'events'),
  (21, '2024-01-01 00:00:00', 'auth_tokens'),
  (22, '2024-01-01 00:00:00', 'attachment_abs_path'),
  (23, '2024-01-01 00:00:00', 'chat_lineage'),
  (24, '2024-01-01 00:00:00', 'remote_connect_state'),
  (25, '2024-01-01 00:00:00', 'relay_environment_keys'),
  (26, '2024-01-01 00:00:00', 'relay_connector_token'),
  (27, '2024-01-01 00:00:00', 'relay_tunnel_hostname'),
  (28, '2024-01-01 00:00:00', 'relay_mint_public_key'),
  (29, '2024-01-01 00:00:00', 'chat_lineage_repair');
