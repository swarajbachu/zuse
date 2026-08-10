#!/usr/bin/env bash
set -euo pipefail

status_dir=/var/lib/zuse/workspace
workspace=/home/zuse/workspace
mkdir -p "$status_dir"
rm -f "$status_dir/ready" "$status_dir/failed"
trap 'touch "$status_dir/failed"' ERR

# Snapshot identity must never survive a fork.
rm -rf /home/zuse/.zuse-data /home/zuse/.config/gh /home/zuse/.claude /home/zuse/.codex
mkdir -p /home/zuse/.zuse-data
chmod 700 /home/zuse/.zuse-data

# Generate a fresh environment identity while provider egress is still fully
# quarantined. Enrollment is expected to fail on this first boot; the only
# durable result we accept is a newly generated keypair in the empty runtime
# database.
export ZUSE_RUNTIME_KIND=cloud-workspace
export ZUSE_CLOUD_WORKSPACE_ID
export ZUSE_HOST=0.0.0.0
export ZUSE_PORT=47837
export ZUSE_AUTH_POLICY=protected
export ZUSE_ENABLE_PAIRING=0
export ZUSE_MACHINE_RUNTIME_ROLE=cloud-environment
export ZUSE_SERVER_READY_STDOUT=1
export ZUSE_USER_DATA=/home/zuse/.zuse-data
timeout 30 zuse serve --foreground >/dev/null 2>&1 || true
bun -e '
  import { Database } from "bun:sqlite";
  const database = new Database("/home/zuse/.zuse-data/zuse.sqlite", { readonly: true });
  const row = database.query("SELECT private_key_jwk, public_key_jwk FROM environment_identity LIMIT 1").get();
  if (!row?.private_key_jwk || !row?.public_key_jwk) process.exit(1);
'
touch "$status_dir/rekeyed"

while [[ ! -f "$status_dir/network-ready" ]]; do sleep 1; done

# Only the trusted runtime runs while egress is relay-restricted. Repository
# code and setup remain blocked until the relay has verified the fresh key.
zuse serve --foreground >"$status_dir/runtime.log" 2>&1 &
while [[ ! -f "$status_dir/credentials-ready" ]]; do sleep 1; done

cd "$workspace"
git fetch --prune origin
remote_ref="${ZUSE_BASE_REF#origin/}"
git fetch origin "$remote_ref"
git checkout -B "$ZUSE_BRANCH" FETCH_HEAD
while IFS= read -r -d '' key && IFS= read -r -d '' value; do
  if [[ -z "${!key+x}" ]]; then export "$key=$value"; fi
done < <(bun /usr/local/lib/zuse/repository-script.ts environment)
setup_command="${ZUSE_INCREMENTAL_SETUP_COMMAND:-}"
if [[ -z "$setup_command" ]]; then
  setup_command="$(bun /usr/local/lib/zuse/repository-script.ts setup)"
fi
if [[ -n "$setup_command" ]]; then
  bash -lc "$setup_command"
fi
touch "$status_dir/ready"
wait
