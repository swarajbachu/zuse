#!/usr/bin/env bash
# Shared by initial bootstrap and resume. Keep the lock descriptor open across
# exec so only one process can enter runtime storage and enrollment at a time.
initialize_workspace_runtime_attempt() {
  status_dir="${ZUSE_WORKSPACE_RUNTIME_STATUS_DIR:-${status_dir:-/var/lib/zuse/workspace}}"
  mkdir -p "$status_dir/attempts"
  runtime_attempt_dir=$(mktemp -d "$status_dir/attempts/launch.XXXXXXXX")
  phase=initializing
  workspace_runtime_lock_acquired=0
  printf '%s\n' "${ZUSE_RUNTIME_GENERATION:-unknown}" >"$runtime_attempt_dir/generation"
  trap 'workspace_runtime_launch_failed "$?"' EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
}

workspace_runtime_launch_failed() {
  local code="$1"
  trap - EXIT
  if [[ "$code" != 0 ]]; then
    printf '%s\n' "$phase" >"$runtime_attempt_dir/failure-phase"
    printf '%s\n' "$code" >"$runtime_attempt_dir/exit-code"
    # A rejected contender must not poison the live owner's readiness markers.
    if [[ "${workspace_runtime_lock_acquired:-0}" == 1 ]]; then
      printf '%s\n' "$phase" >"$status_dir/failure-phase"
      touch "$status_dir/failed"
    fi
  fi
}

resolve_workspace_runtime_data() {
  phase=resolving-runtime-data
  # Aliases may point to the same persisted database. Distinct databases are
  # ambiguous; never choose a new path or delete an older workspace to launch.
  local selected="" candidate database identity selected_identity=""
  for candidate in "${ZUSE_USER_DATA:-/var/lib/zuse/user-data}" \
    /home/zuse/.zuse-data /srv/zuse/home/.zuse-data; do
    database="$candidate/zuse.sqlite"
    [[ -f "$database" ]] || continue
    identity=$(stat -Lc '%d:%i' "$database") || return 74
    if [[ -n "$selected_identity" && "$identity" != "$selected_identity" ]]; then
      phase=runtime-storage-ambiguous
      return 74
    fi
    selected="$candidate"
    selected_identity="$identity"
  done
  if [[ -z "$selected" ]]; then
    if [[ "${ZUSE_RUNTIME_EXPECT_EXISTING_DATA:-}" == 1 ]]; then
      phase=runtime-storage-missing
      return 74
    fi
    selected="${ZUSE_USER_DATA:-/var/lib/zuse/user-data}"
  fi
  export ZUSE_USER_DATA
  # Canonicalize without initializing storage; fork quarantine uses the same
  # selection before moving its source, while new workspaces may not exist yet.
  ZUSE_USER_DATA=$(readlink -m "$selected") || return 74
}

acquire_workspace_runtime_lock() {
  resolve_workspace_runtime_data || return $?
  phase=acquiring-runtime-lock
  mkdir -p "$ZUSE_USER_DATA"
  # Compile bytecode is reusable across fresh processes; workspace keys are not.
  # Current images prewarm this cache. Older/native images use private storage.
  if [[ -d /opt/zuse/node-compile-cache && -w /opt/zuse/node-compile-cache ]]; then
    export NODE_COMPILE_CACHE=/opt/zuse/node-compile-cache
  else
    export NODE_COMPILE_CACHE="$ZUSE_USER_DATA/.node-compile-cache"
  fi
  local lock_file="$ZUSE_USER_DATA/.workspace-runtime.lock"
  local inherited="${ZUSE_WORKSPACE_RUNTIME_LOCK_FD:-}"
  # The initial wrapper execs bootstrap with its lock already held. Validate the
  # inherited descriptor and reacquire on that same open file description.
  if [[ "$inherited" =~ ^[0-9]+$ ]] &&
    [[ "$(readlink -f "/proc/$$/fd/$inherited")" == "$(readlink -f "$lock_file")" ]]; then
    flock --nonblock "$inherited" || return 75
    workspace_runtime_lock_acquired=1
    return 0
  fi
  exec {workspace_runtime_lock_fd}>"$lock_file"
  flock --nonblock "$workspace_runtime_lock_fd" || return 75
  export ZUSE_WORKSPACE_RUNTIME_LOCK_FD="$workspace_runtime_lock_fd"
  workspace_runtime_lock_acquired=1
}

exec_workspace_runtime() {
  acquire_workspace_runtime_lock || return $?
  phase=starting-runtime
  exec "$@"
}
