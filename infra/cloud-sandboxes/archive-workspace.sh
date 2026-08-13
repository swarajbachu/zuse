#!/usr/bin/env bash
set -euo pipefail

status_dir=/var/lib/zuse/workspace-archive
workspace=/home/zuse/workspace
data_dir=/home/zuse/.zuse-data
database="$data_dir/zuse.sqlite"
staging="$status_dir/staging"
mkdir -p "$status_dir"
rm -f "$status_dir/ready" "$status_dir/failed" "$status_dir/recovery.tar.gz" \
	"$status_dir/recovery.tar.gz.sha256" "$status_dir/phase" \
	"$status_dir/error-code" "$status_dir/diagnostic.log"
rm -rf "$staging"
phase=initializing
set_phase() { phase="$1"; printf '%s\n' "$phase" > "$status_dir/phase"; }
fail_archive() {
  code="archive-${phase}-failed"
  printf '%s\n' "$code" > "$status_dir/error-code"
  tail -c 8192 "$status_dir/diagnostic.log" > "$status_dir/diagnostic.tmp" 2>/dev/null || true
  mv "$status_dir/diagnostic.tmp" "$status_dir/diagnostic.log" 2>/dev/null || true
  touch "$status_dir/failed"
}
trap fail_archive ERR
: > "$status_dir/diagnostic.log"

set_phase repository-hook
cd "$workspace"
archive_command="$(bun /usr/local/lib/zuse/repository-script.ts archive)"
if [[ -n "$archive_command" ]]; then
  bash -lc "$archive_command" >> "$status_dir/diagnostic.log" 2>&1
fi

# Quiesce all writers before reading runtime state. The archive process is
# provider-owned, so stopping the runtime cannot stop this script.
set_phase quiescing
runtime_pattern='[z]use serve|[/]opt/zuse/current/bin.mjs serve'
server_pid="$(pgrep -u zuse -f "$runtime_pattern" | head -n 1 || true)"
if [[ -n "$server_pid" ]]; then
  pkill -TERM -P "$server_pid" 2>/dev/null || true
  kill -TERM "$server_pid" 2>/dev/null || true
  for _ in {1..50}; do
    kill -0 "$server_pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL "$server_pid" 2>/dev/null || true
fi
pkill -u zuse -f '(^|/)(claude|codex)( |$)' 2>/dev/null || true

set_phase checkpointing
mkdir -p "$staging/archive"
if [[ ! -f "$database" ]]; then
	printf '%s\n' 'authoritative SQLite database is missing' >> "$status_dir/diagnostic.log"
	exit 73
fi
# `.backup` invokes SQLite's supported online-backup API. Writers have already
# been quiesced, but using the API also handles any committed WAL pages without
# relying on filesystem-copy timing.
sqlite3 "$database" ".timeout 10000" ".backup '$staging/archive/zuse.sqlite'" \
	>> "$status_dir/diagnostic.log" 2>&1
integrity="$(sqlite3 "$staging/archive/zuse.sqlite" 'PRAGMA integrity_check;')"
if [[ "$integrity" != "ok" ]]; then
	printf 'sqlite integrity check failed: %s\n' "$integrity" >> "$status_dir/diagnostic.log"
	exit 74
fi
schema_version="$(sqlite3 "$staging/archive/zuse.sqlite" 'PRAGMA user_version;')"
stream_epoch="$(sqlite3 "$staging/archive/zuse.sqlite" \
	"SELECT COALESCE((SELECT value FROM app_state WHERE key='session_stream_epoch'), 'legacy');" \
	2>> "$status_dir/diagnostic.log" || printf 'legacy')"
sqlite3 -json "$staging/archive/zuse.sqlite" \
	"SELECT stream_id AS streamId, MAX(stream_version) AS headVersion FROM events WHERE stream_kind='session' GROUP BY stream_id ORDER BY stream_id;" \
	> "$staging/archive/session-heads.json"
database_checksum="$(sha256sum "$staging/archive/zuse.sqlite" | awk '{print $1}')"
database_size_bytes="$(stat -c '%s' "$staging/archive/zuse.sqlite")"
repository_head="$(git -C "$workspace" rev-parse HEAD 2>/dev/null || true)"
repository_branch="$(git -C "$workspace" branch --show-current 2>/dev/null || true)"
jq -n \
	--argjson manifestVersion 1 \
	--argjson schemaVersion "${schema_version:-0}" \
	--arg streamEpoch "$stream_epoch" \
	--arg databaseSha256 "$database_checksum" \
	--argjson databaseSizeBytes "$database_size_bytes" \
	--argjson sourceGeneration "${ZUSE_RUNTIME_GENERATION:-0}" \
	--argjson sourceGatewayEpoch "${ZUSE_GATEWAY_EPOCH:-0}" \
	--arg repositoryHead "$repository_head" \
	--arg repositoryBranch "$repository_branch" \
	--slurpfile sessionHeads "$staging/archive/session-heads.json" \
	'{manifestVersion:$manifestVersion,schemaVersion:$schemaVersion,streamEpoch:$streamEpoch,databaseSha256:$databaseSha256,databaseSizeBytes:$databaseSizeBytes,sourceGeneration:$sourceGeneration,sourceGatewayEpoch:$sourceGatewayEpoch,repository:{head:$repositoryHead,branch:$repositoryBranch},sessionHeads:($sessionHeads[0] // [])}' \
	> "$staging/archive/manifest.json"

set_phase bundling
tar -czf "$status_dir/recovery.tar.gz" \
  --exclude='.zuse-data/secrets' \
  --exclude='*.sock' --exclude='*.lock' --exclude='*.pid' \
  --exclude='workspace/.git/index.lock' \
	--exclude='.zuse-data/zuse.sqlite' \
	--exclude='.zuse-data/zuse.sqlite-wal' \
	--exclude='.zuse-data/zuse.sqlite-shm' \
	-C /home/zuse workspace .zuse-data \
	-C "$staging" archive \
  >> "$status_dir/diagnostic.log" 2>&1
chmod 0600 "$status_dir/recovery.tar.gz"

set_phase validating
tar -tzf "$status_dir/recovery.tar.gz" >/dev/null
if tar -tzf "$status_dir/recovery.tar.gz" | grep -Eq '(^|/)(secrets|credentials\.json)(/|$)'; then
  exit 71
fi
sha256sum "$status_dir/recovery.tar.gz" > "$status_dir/recovery.tar.gz.sha256"
(cd "$status_dir" && sha256sum -c recovery.tar.gz.sha256) \
	>> "$status_dir/diagnostic.log" 2>&1
archived_database_checksum="$(tar -xOzf "$status_dir/recovery.tar.gz" archive/zuse.sqlite | sha256sum | awk '{print $1}')"
if [[ "$archived_database_checksum" != "$database_checksum" ]]; then
	printf '%s\n' 'archive database checksum mismatch' >> "$status_dir/diagnostic.log"
	exit 75
fi

set_phase sanitizing
rm -rf /home/zuse/.config/gh /home/zuse/.claude /home/zuse/.codex
if [[ -d /run/zuse-secrets ]]; then
  find /run/zuse-secrets -mindepth 1 -delete
fi
rm -f /home/zuse/.git-credentials /home/zuse/.netrc \
  /home/zuse/.zuse-data/secrets/credentials.json
if [[ -d /run/zuse-secrets ]] && [[ -n "$(find /run/zuse-secrets -mindepth 1 -print -quit)" ]]; then
  exit 72
fi
rm -rf "$staging"

set_phase complete
touch "$status_dir/ready"
