#!/usr/bin/env bash
# Shared pinned installation for base templates and older account images.
# Installs only the CLI; existing runtime databases and credentials are untouched.
# Artifact generations and SHA-256 digests are pinned from upstream HTTPS downloads,
# not upstream-signed checksums. See internal-docs/cloud/grok-cli-installation.md.
install_grok() (
  set -euo pipefail
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64|Linux:amd64)
      arch=x86_64
      generation=1787956692848119
      digest=edf79521581bb5e6b95abef848491a6a742e860da3e237ebe86a280d30dce4c1
      ;;
    Linux:aarch64|Linux:arm64)
      arch=aarch64
      generation=1787956595467474
      digest=b926fc5308374396e260e7efbd6107231a8dae13c084ddaf0fe89b7ebb3edd25
      ;;
    *) echo "Unsupported platform for cloud Grok installation" >&2; return 1 ;;
  esac
  bin_dir="${GROK_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$bin_dir" || return
  artifact="$(mktemp "$bin_dir/.grok-install.XXXXXX")" || return
  trap 'rm -f "$artifact"' EXIT
  curl --proto '=https' --proto-redir '=https' -fsSL --max-time 180 \
    "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-1.0.13-linux-${arch}?generation=${generation}" \
    -o "$artifact" || return
  printf '%s  %s\n' "$digest" "$artifact" | sha256sum --check --status || return
  chmod 755 "$artifact" || return
  timeout 10 "$artifact" --version || return
  mv -f "$artifact" "$bin_dir/grok" || return
)
