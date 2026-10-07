#!/usr/bin/env bash
# Shared pinned installation for base templates and older account images.
# Installs only the CLI; existing runtime databases and credentials are untouched.
install_grok() (
  set -euo pipefail
  bin_dir="${GROK_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$bin_dir" || return
  installer="$(mktemp)" || return
  trap 'rm -f "$installer"' EXIT
  curl --proto '=https' --proto-redir '=https' -fsSL --max-time 60 \
    https://x.ai/cli/install.sh -o "$installer" || return
  printf '%s  %s\n' '7fd6fdc75d9418b2e58356726fcbf1ae849416f773925da07d0ccc7a60d3e791' "$installer" | sha256sum --check --status || return
  GROK_BIN_DIR="$bin_dir" timeout 180 bash "$installer" 1.0.13 || return
  "$bin_dir/grok" --version
)
