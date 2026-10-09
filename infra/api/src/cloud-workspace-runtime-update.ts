import INSTALL_GROK_SOURCE from "../../cloud-sandboxes/install-grok.sh";

export const WORKSPACE_RUNTIME_UPDATE_SCRIPT = `${INSTALL_GROK_SOURCE}
# Account snapshots can lack runtime fixes without a wire-protocol change.
# First launches and explicit restarts check the signed channel before starting.
ensure_workspace_runtime() {
  local status_dir=/var/lib/zuse/workspace
  mkdir -p "$status_dir"
  export PATH="$HOME/.local/bin:$PATH"
  # Runtime publication does not refresh provider tools in saved account images.
  if ! command -v grok >/dev/null 2>&1; then
    if ! install_grok >>"$status_dir/runtime.log" 2>&1; then
      printf 'installing-agent-cli\\n' >"$status_dir/failure-phase"
      touch "$status_dir/failed"
      return 1
    fi
  fi
  [[ -n "\${ZUSE_RUNTIME_MANIFEST_URL:-}" ]] || return 0
  local metadata="\${ZUSE_CURRENT_LINK:-/opt/zuse/current}/runtime-metadata.json"
  mkdir -p "$status_dir"
  runtime_is_compatible() {
    "\${ZUSE_RUNTIME_NODE:-node}" -e '
      try {
        const metadata = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
        const expected = Number(process.env.ZUSE_RUNTIME_WIRE_PROTOCOL);
        process.exit(Number.isInteger(expected) && expected > 0 &&
          metadata.schemaVersion === 1 && metadata.wireProtocolVersion === expected &&
          (process.env.ZUSE_SNAPSHOT_NATIVE !== "1" || metadata.snapshotSupportVersion === 1) ? 0 : 1);
      } catch { process.exit(1); }
    ' "$metadata"
  }
  if [[ "\${1:-0}" != 1 ]] && runtime_is_compatible; then return 0; fi
  if [[ -f "\${ZUSE_RUNTIME_PUBLIC_KEY_FILE:-}" ]] &&
    ZUSE_RUNTIME_INSTALL_ONLY=1 ZUSE_RUNTIME_SKIP_TOOLCHAIN=1 \\
      "\${ZUSE_RUNTIME_NODE:-node}" /usr/local/lib/zuse/runtime-updater.mjs >>"$status_dir/runtime.log" 2>&1 &&
    runtime_is_compatible; then
    return 0
  fi
  printf 'updating-runtime\\n' >"$status_dir/failure-phase"
  touch "$status_dir/failed"
  return 1
}
`;
