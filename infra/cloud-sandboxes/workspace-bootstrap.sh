#!/usr/bin/env bash
set -euo pipefail

status_dir=/var/lib/zuse/workspace
workspace=/home/zuse/workspace
mirror="/var/cache/zuse/repositories/${ZUSE_PROJECT_CACHE_ID:?}.git"
mkdir -p "$status_dir"
rm -f \
  "$status_dir/ready" \
  "$status_dir/failed" \
  "$status_dir/credentials-ready" \
  "$status_dir/repository-ready" \
  "$status_dir/rekeyed" \
  "$status_dir/failure-phase"
phase=initializing
fail() {
  code=$?
  trap - ERR
  printf '%s\n' "$phase" >"$status_dir/failure-phase"
  touch "$status_dir/failed"
  exit "$code"
}
trap fail ERR

# Snapshot identity must never survive a fork.
rm -rf /home/zuse/.zuse-data /home/zuse/.config/gh /home/zuse/.claude /home/zuse/.codex
mkdir -p /home/zuse/.zuse-data
chmod 700 /home/zuse/.zuse-data

# The SSH host identity is per-workspace: never inherit it (or authorized
# keys) from the snapshot this sandbox was forked from.
mkdir -p /home/zuse/.ssh
chmod 700 /home/zuse/.ssh
rm -f /home/zuse/.ssh/host_ed25519_key /home/zuse/.ssh/host_ed25519_key.pub \
  /home/zuse/.ssh/authorized_keys
ssh-keygen -q -t ed25519 -N "" -f /home/zuse/.ssh/host_ed25519_key

# The relay restricts egress to itself before launching this process. Start the
# real runtime once: it creates a fresh identity, enrolls, installs credentials,
# and then remains available for the desktop connection.
export ZUSE_RUNTIME_KIND=cloud-workspace
export ZUSE_CLOUD_WORKSPACE_ID
export ZUSE_HOST=127.0.0.1
export ZUSE_PORT=47837
export ZUSE_AUTH_POLICY=protected
export ZUSE_ENABLE_PAIRING=0
export ZUSE_MACHINE_RUNTIME_ROLE=cloud-environment
export ZUSE_SERVER_READY_STDOUT=1
export ZUSE_USER_DATA=/home/zuse/.zuse-data
credentials_event="$status_dir/credentials-ready-event"
rm -f "$credentials_event"
mkfifo -m 600 "$credentials_event"
runtime_command=(zuse serve --foreground)
if [[ -n "${ZUSE_RUNTIME_MANIFEST_URL:-}" && -f "${ZUSE_RUNTIME_PUBLIC_KEY_FILE:-}" ]]; then
  phase=updating-runtime
  ZUSE_RUNTIME_INSTALL_ONLY=1 \
    ZUSE_RUNTIME_SKIP_TOOLCHAIN=1 \
    ZUSE_RUNTIME_WIRE_PROTOCOL="${ZUSE_RUNTIME_WIRE_PROTOCOL:?}" \
    node /usr/local/lib/zuse/runtime-updater.mjs \
    >"$status_dir/runtime-update.log" 2>&1
  runtime_command=(node /opt/zuse/current/bin.mjs serve)
fi
phase=starting-runtime
(
  set +e
  "${runtime_command[@]}" >"$status_dir/runtime.log" 2>&1
  code=$?
  if [[ ! -f "$status_dir/credentials-ready" ]]; then
    printf '%s\n' "$phase" >"$status_dir/failure-phase"
    touch "$status_dir/failed"
  fi
  exit "$code"
) &
runtime_pid=$!
(IFS= read -r _ <"$credentials_event") &
credentials_wait_pid=$!
set +e
wait -n "$runtime_pid" "$credentials_wait_pid"
set -e
if [[ ! -f "$status_dir/credentials-ready" ]]; then
  kill "$credentials_wait_pid" 2>/dev/null || true
  false
fi
[[ ! -f "$status_dir/failed" ]]
rm -f "$credentials_event"

phase=syncing-repository
rm -rf "$workspace"
if [[ -d "$mirror" ]]; then
  git clone --no-hardlinks "$mirror" "$workspace"
else
  git clone "${ZUSE_REPOSITORY_URL:?}" "$workspace"
fi
cd "$workspace"
git remote set-url origin "${ZUSE_REPOSITORY_URL:?}"
remote_ref="${ZUSE_BASE_REF#origin/}"
git fetch --prune origin "$remote_ref"
git checkout -B "$ZUSE_BRANCH" FETCH_HEAD
phase=ready
touch "$status_dir/ready"
touch "$status_dir/repository-ready"
wait "$runtime_pid"
