#!/usr/bin/env bash
# Distributed alongside runtime-updater.mjs in zuse-snapshot-installer.tar.gz.
set -euo pipefail
runtime_user="${SUDO_USER:-$(id -un)}"
while (($#)); do
  case "$1" in
    --user) [[ $# -ge 2 ]] || { echo '--user needs a Linux username' >&2; exit 2; }; runtime_user="$2"; shift 2 ;;
    --help|-h) echo 'Usage: bash install-snapshot.sh [--user development-user]'; exit 0 ;;
    *) echo "Unknown option: $1. Repository paths are configured in Zuse." >&2; exit 2 ;;
  esac
done
[[ "$runtime_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$runtime_user" != root ]] || { echo 'Choose the existing development user with --user (not root).' >&2; exit 2; }
getent passwd "$runtime_user" >/dev/null || { echo 'The development user does not exist.' >&2; exit 2; }
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 && -d /run/systemd/system ]] || { echo 'This installer requires a Boxd Linux x86_64 machine with systemd.' >&2; exit 2; }
asset_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$asset_dir/runtime-updater.mjs" && -f "$asset_dir/snapshot-release.json" && -f "$asset_dir/SHA256SUMS" ]] || { echo 'Extract the complete zuse-snapshot-installer.tar.gz bundle first.' >&2; exit 2; }
(cd "$asset_dir" && sha256sum --check --status SHA256SUMS)
if [[ $(id -u) != 0 ]]; then exec sudo -E bash "$0" --user "$runtime_user"; fi
command -v apt-get >/dev/null || { echo 'This version supports Debian/Ubuntu Boxd images.' >&2; exit 2; }
runtime_home="$(getent passwd "$runtime_user" | cut -d: -f6)"
runtime_group="$(id -gn "$runtime_user")"
# Installing a base snapshot is distinct from updating an enrolled workspace.
[[ ! -e /var/lib/zuse/user-data/zuse.sqlite ]] || { echo 'This machine has existing Zuse chat state. Use workspace runtime updates; prepare a clean snapshot separately.' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
missing_packages=()
for package in ca-certificates curl git gh jq util-linux openssh-server rsync sqlite3 xz-utils; do
  [[ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" == 'install ok installed' ]] || missing_packages+=("$package")
done
if (( ${#missing_packages[@]} )); then
  apt-get update
  apt-get install -y --no-install-recommends "${missing_packages[@]}"
fi
install -d -m 0755 /opt/zuse/node /opt/zuse/bin /etc/zuse /usr/local/lib/zuse
install -d -m 0700 -o "$runtime_user" -g "$runtime_group" /var/lib/zuse /var/lib/zuse/workspace /var/lib/zuse/project-build /var/lib/zuse/ssh /opt/zuse/releases
chown "$runtime_user:$runtime_group" /opt/zuse
if [[ ! -x /opt/zuse/node/bin/node ]]; then
  temp_dir="$(mktemp -d)"
  trap 'rm -rf -- "$temp_dir"' EXIT
  curl --proto '=https' --proto-redir '=https' -fsSL --max-time 60 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$temp_dir/SHASUMS256.txt"
  node_archive="$(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ {print $2}' "$temp_dir/SHASUMS256.txt")"
  [[ "$node_archive" =~ ^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$ ]]
  curl --proto '=https' --proto-redir '=https' -fsSL --max-time 180 "https://nodejs.org/dist/latest-v22.x/$node_archive" -o "$temp_dir/$node_archive"
  (cd "$temp_dir" && awk -v name="$node_archive" '$2 == name' SHASUMS256.txt | sha256sum --check --status)
  tar -xJf "$temp_dir/$node_archive" --strip-components=1 -C /opt/zuse/node
fi
node_bin=/opt/zuse/node/bin/node
install -m 0644 "$asset_dir/runtime-updater.mjs" /usr/local/lib/zuse/runtime-updater.mjs
"$node_bin" --input-type=module - "$asset_dir/snapshot-release.json" "$runtime_user" "$runtime_home" <<'JS'
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const [releaseFile, runtimeUser, runtimeHome] = process.argv.slice(2);
const release = JSON.parse(readFileSync(releaseFile, 'utf8'));
if (!release.manifestUrl?.startsWith('https://') || !Number.isInteger(release.wireProtocolVersion) || !release.publicJwk) throw new Error('Invalid release configuration');
if (existsSync('/etc/zuse/snapshot.json') && JSON.parse(readFileSync('/etc/zuse/snapshot.json', 'utf8')).runtimeUser !== runtimeUser) throw new Error('Snapshot is already installed for a different user');
const quote = value => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
writeFileSync('/etc/zuse/snapshot.json', JSON.stringify({ schemaVersion: 1, runtimeUser, runtimeHome }), { mode: 0o644 });
writeFileSync('/etc/zuse/runtime-signing-public.jwk', JSON.stringify(release.publicJwk), { mode: 0o644 });
writeFileSync('/etc/zuse/snapshot.env', [
 'export PATH=/opt/zuse/bin:"$PATH"',
 'export ZUSE_RUNTIME_NODE=/opt/zuse/node/bin/node',
 'export ZUSE_RUNTIME_MANIFEST_URL=${ZUSE_RUNTIME_MANIFEST_URL:-' + quote(release.manifestUrl) + '}',
 'export ZUSE_RUNTIME_PUBLIC_KEY_FILE=${ZUSE_RUNTIME_PUBLIC_KEY_FILE:-/etc/zuse/runtime-signing-public.jwk}',
 'export ZUSE_RUNTIME_WIRE_PROTOCOL=${ZUSE_RUNTIME_WIRE_PROTOCOL:-' + quote(release.wireProtocolVersion) + '}',
].join('\n') + '\n', { mode: 0o644 });
JS
runuser -u "$runtime_user" -- bash -lc 'source /etc/zuse/snapshot.env; ZUSE_RUNTIME_INSTALL_ONLY=1 ZUSE_RUNTIME_SKIP_TOOLCHAIN=1 "$ZUSE_RUNTIME_NODE" /usr/local/lib/zuse/runtime-updater.mjs'
cat >/opt/zuse/bin/zuse <<'SH'
#!/bin/sh
exec /opt/zuse/node/bin/node /opt/zuse/current/bin.mjs "$@"
SH
chmod 0755 /opt/zuse/bin/zuse
install -D -m 0644 "$asset_dir/sshd_config" /usr/local/share/zuse/sshd_config
runuser -u "$runtime_user" -- /opt/zuse/bin/zuse --help >/dev/null
runuser -u "$runtime_user" -- bash -lc '
  available=0
  for agent in claude codex; do
    if command -v "$agent" >/dev/null; then
      timeout 15 "$agent" --version || { echo "$agent is installed but cannot run. Repair it and rerun this installer." >&2; exit 1; }
      available=1
    fi
  done
  [[ "$available" == 1 ]] || { echo "Install Claude Code or Codex for this development user, then rerun the installer. Zuse preserves your existing agent installations." >&2; exit 1; }
'

printf '\nZuse installed for %s. Create your Boxd snapshot, then enter its ID and this user in Zuse → Cloud → Provider keys → Custom snapshot.\nRepositories and authentication will be detected there; you can also enter repository paths in the UI.\n' "$runtime_user"
