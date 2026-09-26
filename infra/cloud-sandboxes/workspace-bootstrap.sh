#!/usr/bin/env bash
set -euo pipefail

status_dir=/var/lib/zuse/workspace
workspace="${ZUSE_CLOUD_WORKSPACE_ROOT:?}"
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

# Runtime and GitHub identity must never survive a fork. Provider-owned agent
# authentication intentionally belongs to the private account image.
rm -rf /home/zuse/.zuse-data /home/zuse/.config/gh
mkdir -p /var/lib/zuse/user-data
chown zuse:zuse /var/lib/zuse/user-data
chmod 700 /var/lib/zuse/user-data

# GitHub access inside a cloud workspace is the Zuse GitHub App installation
# token, minted per call by `zuse-github-auth`: `gh` is a shim that resolves a
# fresh token and execs the real binary, and the same script backs git's
# credential helper. Nothing here ever runs `gh auth login`, and no credential
# is retained in a shell.
#
# This is repaired on every start rather than trusted from the image. A sandbox
# built before the shim shipped carries stock `gh`, which answers every push
# with the unactionable "run gh auth login"; a persisted home can shadow the
# image's global git config; and PATH is not guaranteed to resolve
# /usr/local/bin first. The API ships the current script with the project
# build, so prefer that copy over whatever the base image happens to hold.
github_auth=/var/lib/zuse/project-build/github-auth.sh
[[ -x "$github_auth" ]] || github_auth=/usr/local/bin/zuse-github-auth
if [[ -x "$github_auth" ]]; then
  export ZUSE_GITHUB_AUTH_BIN="$github_auth"
  mkdir -p /home/zuse/.local/bin
  ln -sf "$github_auth" /home/zuse/.local/bin/gh
  # The runtime inherits this, and agent drivers pass their environment
  # through, so every agent-run `gh` resolves the shim.
  export PATH="/home/zuse/.local/bin:$PATH"
  # A terminal opened over the SSH bridge starts from the shell profile
  # instead, and neither Debian rc file puts ~/.local/bin ahead of stock gh.
  for rc in /home/zuse/.profile /home/zuse/.bashrc; do
    grep -qs 'zuse-github-auth shim' "$rc" ||
      printf '\n# zuse-github-auth shim: GitHub App credentials, never gh auth login.\nPATH="$HOME/.local/bin:$PATH"\n' >>"$rc"
  done
  "$github_auth" install ||
    printf '%s\n' 'Could not install the GitHub credential helper.' >&2
else
  printf '%s\n' \
    'zuse-github-auth is missing from this sandbox, so GitHub access is unavailable. Rebuild the project image to ship it; gh auth login is never the fix.' >&2
fi

# The SSH host identity is per-workspace: never inherit it (or authorized
# keys) from the snapshot this sandbox was forked from.
mkdir -p /home/zuse/.ssh
chmod 700 /home/zuse/.ssh
rm -f /home/zuse/.ssh/host_ed25519_key /home/zuse/.ssh/host_ed25519_key.pub \
  /home/zuse/.ssh/authorized_keys
ssh-keygen -q -t ed25519 -N "" -f /home/zuse/.ssh/host_ed25519_key

# Start the real runtime once: it creates a fresh identity, enrolls, installs credentials,
# and then remains available for the desktop connection.
export ZUSE_RUNTIME_KIND=cloud-workspace
export ZUSE_CLOUD_WORKSPACE_ID
export ZUSE_HOST=127.0.0.1
export ZUSE_PORT=47837
export ZUSE_AUTH_POLICY=protected
export ZUSE_ENABLE_PAIRING=0
export ZUSE_MACHINE_RUNTIME_ROLE=cloud-environment
export ZUSE_SERVER_READY_STDOUT=1
export ZUSE_USER_DATA=/var/lib/zuse/user-data
credentials_event="$status_dir/credentials-ready-event"
rm -f "$credentials_event"
mkfifo -m 600 "$credentials_event"
runtime_command=(node /opt/zuse/current/bin.mjs serve)
[[ -f /opt/zuse/current/bin.mjs ]] || runtime_command=(zuse serve --foreground)
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

# Both initial startup and interrupted-startup recovery use the same safe setup.
bash /var/lib/zuse/project-build/workspace-repository.sh &
repository_pid=$!

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
wait "$repository_pid"
phase=ready
touch "$status_dir/ready"
touch "$status_dir/repository-ready"
wait "$runtime_pid"
