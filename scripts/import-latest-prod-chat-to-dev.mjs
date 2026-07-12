#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const appSupport = join(homedir(), "Library", "Application Support");
const prodDb =
  process.env.ZUSE_PROD_SQLITE ?? join(appSupport, "Zuse Alpha", "zuse.sqlite");
const devDb =
  process.env.ZUSE_DEV_SQLITE ??
  join(appSupport, "Zuse Alpha (Dev)", "zuse.sqlite");

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = join(dirname(devDb), `debug-import-backup-${timestamp}`);

function runSql(dbPath, sql) {
  return execFileSync("sqlite3", ["-batch", dbPath, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function quoteSql(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function requireFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} does not exist: ${path}`);
  }
}

function backupDevDatabase() {
  mkdirSync(backupDir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = `${devDb}${suffix}`;
    if (!existsSync(from)) continue;
    copyFileSync(from, join(backupDir, `zuse.sqlite${suffix}`));
  }
}

function tableCount(dbPath, table, where) {
  return runSql(dbPath, `SELECT count(*) FROM ${table} WHERE ${where};`);
}

requireFile(prodDb, "Production SQLite database");
requireFile(devDb, "Dev SQLite database");

const chatId = runSql(
  prodDb,
  `
  SELECT c.id
  FROM chats c
  JOIN sessions s ON s.chat_id = c.id
  GROUP BY c.id
  HAVING
    SUM(CASE WHEN s.provider_id = 'codex' THEN 1 ELSE 0 END) > 0
    AND SUM(CASE WHEN s.provider_id = 'claude' OR s.model LIKE '%fable%' THEN 1 ELSE 0 END) > 0
  ORDER BY c.updated_at DESC
  LIMIT 1;
  `,
);

if (!chatId) {
  throw new Error(
    "Could not find a production chat with codex and fable sessions.",
  );
}

const sessionIds = runSql(
  prodDb,
  `SELECT group_concat(id, ',') FROM sessions WHERE chat_id = ${quoteSql(chatId)};`,
)
  .split(",")
  .filter(Boolean);

if (sessionIds.length === 0) {
  throw new Error(`Selected chat has no sessions: ${chatId}`);
}

backupDevDatabase();

const prodDbSql = quoteSql(prodDb);
const chatIdSql = quoteSql(chatId);
const importSql = `
PRAGMA foreign_keys = ON;
ATTACH DATABASE ${prodDbSql} AS prod;

BEGIN IMMEDIATE;

CREATE TEMP TABLE selected_sessions(id TEXT PRIMARY KEY);
INSERT INTO selected_sessions(id)
SELECT id FROM prod.sessions WHERE chat_id = ${chatIdSql};

CREATE TEMP TABLE selected_messages(id TEXT PRIMARY KEY);
INSERT INTO selected_messages(id)
SELECT id FROM prod.messages WHERE session_id IN (SELECT id FROM selected_sessions);

CREATE TEMP TABLE selected_attachments(id TEXT PRIMARY KEY);
INSERT INTO selected_attachments(id)
SELECT id FROM prod.attachments WHERE session_id IN (SELECT id FROM selected_sessions)
UNION
SELECT attachment_id
FROM prod.message_attachments
WHERE message_id IN (SELECT id FROM selected_messages);

INSERT OR REPLACE INTO projects
SELECT p.*
FROM prod.projects p
JOIN prod.chats c ON c.project_id = p.id
WHERE c.id = ${chatIdSql};

INSERT OR REPLACE INTO worktrees
SELECT DISTINCT w.*
FROM prod.worktrees w
WHERE w.id IN (
  SELECT worktree_id FROM prod.chats WHERE id = ${chatIdSql} AND worktree_id IS NOT NULL
  UNION
  SELECT worktree_id FROM prod.sessions WHERE id IN (SELECT id FROM selected_sessions) AND worktree_id IS NOT NULL
);

INSERT OR REPLACE INTO chats (
  id,
  project_id,
  worktree_id,
  title,
  active_session_id,
  archived_at,
  created_at,
  updated_at,
  archived_worktree_json,
  last_message_at,
  last_read_at,
  origin_session_id
)
SELECT
  id,
  project_id,
  worktree_id,
  title,
  NULL,
  archived_at,
  created_at,
  updated_at,
  archived_worktree_json,
  last_message_at,
  last_read_at,
  NULL
FROM prod.chats
WHERE id = ${chatIdSql};

INSERT OR REPLACE INTO sessions (
  id,
  project_id,
  title,
  provider_id,
  model,
  status,
  archived_at,
  created_at,
  updated_at,
  cursor,
  resume_strategy,
  runtime_mode,
  agents_json,
  worktree_id,
  permission_mode,
  tool_search,
  parent_session_id,
  chat_id,
  forked_from_session_id,
  forked_from_message_id,
  queue_paused
)
SELECT
  id,
  project_id,
  title,
  provider_id,
  model,
  status,
  archived_at,
  created_at,
  updated_at,
  cursor,
  resume_strategy,
  runtime_mode,
  agents_json,
  worktree_id,
  permission_mode,
  tool_search,
  NULL,
  chat_id,
  NULL,
  forked_from_message_id,
  queue_paused
FROM prod.sessions
WHERE id IN (SELECT id FROM selected_sessions);

UPDATE sessions
SET
  parent_session_id = (
    SELECT parent_session_id FROM prod.sessions ps WHERE ps.id = sessions.id
  ),
  forked_from_session_id = (
    SELECT forked_from_session_id FROM prod.sessions ps WHERE ps.id = sessions.id
  )
WHERE id IN (SELECT id FROM selected_sessions);

INSERT OR REPLACE INTO attachments
SELECT *
FROM prod.attachments
WHERE id IN (SELECT id FROM selected_attachments);

INSERT OR REPLACE INTO messages
SELECT *
FROM prod.messages
WHERE id IN (SELECT id FROM selected_messages);

INSERT OR REPLACE INTO message_attachments
SELECT *
FROM prod.message_attachments
WHERE message_id IN (SELECT id FROM selected_messages)
  AND attachment_id IN (SELECT id FROM selected_attachments);

INSERT OR REPLACE INTO permission_decisions
SELECT *
FROM prod.permission_decisions
WHERE session_id IN (SELECT id FROM selected_sessions);

INSERT OR REPLACE INTO queued_messages
SELECT *
FROM prod.queued_messages
WHERE session_id IN (SELECT id FROM selected_sessions);

DELETE FROM events
WHERE stream_kind = 'session'
  AND stream_id IN (SELECT id FROM selected_sessions);

INSERT INTO events (
  event_id,
  stream_kind,
  stream_id,
  stream_version,
  type,
  occurred_at,
  actor,
  payload_json
)
SELECT
  event_id,
  stream_kind,
  stream_id,
  stream_version,
  type,
  occurred_at,
  actor,
  payload_json
FROM prod.events
WHERE stream_kind = 'session'
  AND stream_id IN (SELECT id FROM selected_sessions)
ORDER BY sequence;

UPDATE chats
SET
  active_session_id = (
    SELECT active_session_id FROM prod.chats pc WHERE pc.id = chats.id
  ),
  origin_session_id = (
    SELECT origin_session_id FROM prod.chats pc WHERE pc.id = chats.id
  )
WHERE id = ${chatIdSql};

COMMIT;
DETACH DATABASE prod;
`;

runSql(devDb, importSql);

const sessionWhere = `chat_id = ${quoteSql(chatId)}`;
const importedSessions = Number(tableCount(devDb, "sessions", sessionWhere));
const importedMessages = Number(
  runSql(
    devDb,
    `SELECT count(*) FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE chat_id = ${chatIdSql});`,
  ),
);
const importedEvents = Number(
  runSql(
    devDb,
    `SELECT count(*) FROM events WHERE stream_kind = 'session' AND stream_id IN (SELECT id FROM sessions WHERE chat_id = ${chatIdSql});`,
  ),
);

console.log(`Imported production chat ${chatId}`);
console.log(`Dev database backup: ${backupDir}`);
console.log(`Sessions: ${importedSessions}`);
console.log(`Messages: ${importedMessages}`);
console.log(`Events: ${importedEvents}`);
console.log(`Dev database size: ${statSync(devDb).size} bytes`);
