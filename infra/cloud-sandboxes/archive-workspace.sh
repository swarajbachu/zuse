#!/usr/bin/env bash
set -euo pipefail

status_dir=/var/lib/zuse/workspace-archive
workspace=/home/zuse/workspace
mkdir -p "$status_dir"
rm -f "$status_dir/ready" "$status_dir/failed" "$status_dir/recovery.tar.gz"
trap 'touch "$status_dir/failed"' ERR

cd "$workspace"
archive_command="$(bun /usr/local/lib/zuse/repository-script.ts archive)"
if [[ -n "$archive_command" ]]; then bash -lc "$archive_command"; fi

# Stop agent/terminal children before capturing runtime state, then remove all
# credential stores. The Zuse server itself remains alive long enough to report
# cleanup and let the provider pause the sandbox.
server_pid="$(pgrep -u zuse -f 'zuse serve' | head -n 1 || true)"
if [[ -n "$server_pid" ]]; then
  pkill -TERM -P "$server_pid" 2>/dev/null || true
fi
pkill -u zuse -f '(^|/)(claude|codex)( |$)' 2>/dev/null || true
rm -rf /home/zuse/.config/gh /home/zuse/.claude /home/zuse/.codex /run/zuse-secrets
rm -f /home/zuse/.git-credentials /home/zuse/.netrc \
  /home/zuse/.zuse-data/secrets/credentials.json

for forbidden in \
  /home/zuse/.config/gh \
  /home/zuse/.claude \
  /home/zuse/.codex \
  /home/zuse/.git-credentials \
  /home/zuse/.netrc \
  /home/zuse/.zuse-data/secrets/credentials.json \
  /run/zuse-secrets; do
  [[ ! -e "$forbidden" ]] || exit 70
done

tar -czf "$status_dir/recovery.tar.gz" \
  -C /home/zuse workspace .zuse-data
chmod 0600 "$status_dir/recovery.tar.gz"
touch "$status_dir/ready"
