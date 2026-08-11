#!/usr/bin/env bash
set -euo pipefail

status_dir=/var/lib/zuse/workspace-archive
workspace=/home/zuse/workspace
mkdir -p "$status_dir"
rm -f "$status_dir/ready" "$status_dir/failed" "$status_dir/recovery.tar.gz" \
  "$status_dir/phase" "$status_dir/error-code" "$status_dir/diagnostic.log"
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
server_pid="$(pgrep -u zuse -f 'zuse serve' | head -n 1 || true)"
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

set_phase bundling
tar -czf "$status_dir/recovery.tar.gz" \
  --exclude='.zuse-data/secrets' \
  --exclude='*.sock' --exclude='*.lock' --exclude='*.pid' \
  --exclude='workspace/.git/index.lock' \
  -C /home/zuse workspace .zuse-data \
  >> "$status_dir/diagnostic.log" 2>&1
chmod 0600 "$status_dir/recovery.tar.gz"

set_phase validating
tar -tzf "$status_dir/recovery.tar.gz" >/dev/null
if tar -tzf "$status_dir/recovery.tar.gz" | grep -Eq '(^|/)(secrets|credentials\.json)(/|$)'; then
  exit 71
fi

set_phase sanitizing
rm -rf /home/zuse/.config/gh /home/zuse/.claude /home/zuse/.codex /run/zuse-secrets
rm -f /home/zuse/.git-credentials /home/zuse/.netrc \
  /home/zuse/.zuse-data/secrets/credentials.json

set_phase complete
touch "$status_dir/ready"
