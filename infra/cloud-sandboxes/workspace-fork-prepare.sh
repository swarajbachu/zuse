#!/usr/bin/env bash
set -euo pipefail

# Runs only in the quarantined child after the copied runtime cgroup is stopped.
# Preserve the complete database directory, including WAL, as the import source.
# Never execute copied queues or reuse the parent's runtime identity.
source_dir="/var/lib/zuse/fork-source/${ZUSE_CLOUD_WORKSPACE_ID:?}"
user_data=/var/lib/zuse/user-data
mkdir -p "$source_dir"
trap 'touch "$source_dir/failed"' ERR
rm -f "$source_dir/failed"
if [[ ! -f "$source_dir/prepared" ]]; then
  if [[ ! -d "$source_dir/user-data" ]]; then
    [[ -f "$user_data/zuse.sqlite" ]]
    [[ ! -L "$user_data" ]]
    "${ZUSE_RUNTIME_NODE:-node}" - "$user_data/zuse.sqlite" "${ZUSE_FORK_CHAT_ID:?}" "${ZUSE_FORK_SESSION_ID:?}" "${ZUSE_FORK_MESSAGE_ID:?}" <<'JS'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
 if (Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok') throw new Error('Fork source database integrity check failed');
 if (!db.prepare('SELECT id FROM sessions WHERE id = ? AND chat_id = ?').get(process.argv[4], process.argv[3])) throw new Error('Fork source session not found');
 if (!db.prepare('SELECT id FROM messages WHERE id = ? AND session_id = ?').get(process.argv[5], process.argv[4])) throw new Error('Fork message not found');
} finally { db.close(); }
JS
    mv "$user_data" "$source_dir/user-data"
  fi
  mkdir -p "$user_data"
  chmod 700 "$source_dir" "$user_data"
  # File attachments retain their stable paths in the new runtime.
  if [[ -d "$source_dir/user-data/attachments" ]]; then
    mkdir -p "$user_data/attachments"
    cp -a "$source_dir/user-data/attachments/." "$user_data/attachments/"
  fi
  rm -rf /run/zuse-secrets/*
  if [[ "${ZUSE_SNAPSHOT_NATIVE:-}" == 1 ]]; then
    rm -f /var/lib/zuse/ssh/host_ed25519_key /var/lib/zuse/ssh/host_ed25519_key.pub /var/lib/zuse/ssh/authorized_keys /var/lib/zuse/ssh/ticket
    printf '%s\n' "$ZUSE_CLOUD_WORKSPACE_ID" >/var/lib/zuse/workspace/owner
  else
    rm -rf /home/zuse/.config/gh
    rm -f /home/zuse/.ssh/host_ed25519_key /home/zuse/.ssh/host_ed25519_key.pub /home/zuse/.ssh/authorized_keys
  fi
  touch "$source_dir/prepared"
fi
