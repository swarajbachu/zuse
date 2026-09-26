#!/usr/bin/env bash
# boxd-side template installation, executed as root inside a fresh boxd
# machine by boxd-publish.sh. Runs the shared provision stages, then layers on
# the boxd-specific pieces: system Node 22 in place of the stock user's NVM
# launchers, pinned agents (like the E2B image), and the unprivileged zuse user.
set -euo pipefail

provision_dir="${ZUSE_PROVISION_DIR:-/tmp/zuse-provision}"

# The stock image links node/npm and the bundled agents from the boxd user's
# home into /usr/local/bin. Those launchers are neither readable by the zuse
# user nor the runtime's Node 22 floor, so provisioning ignores them.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin

# Node 22 is the supported runtime floor and keeps the native tree-sitter
# dependency on prebuilt binaries; replace whatever the stock image ships.
for launcher in node npm npx corepack pnpm pnpx yarn yarnpkg bun bunx claude codex codex-code-mode-host opencode; do
	rm -f "/usr/local/bin/$launcher"
done
if ! command -v node >/dev/null 2>&1 || [ "$(node --version | cut -c2-3)" != "22" ]; then
	# Pin the reviewed setup script before allowing any root execution.
	curl --proto '=https' --proto-redir '=https' -fsSL --max-time 60 https://deb.nodesource.com/setup_22.x -o /tmp/zuse-nodesource-setup.sh
	printf '%s  %s\n' '575583bbac2fccc0b5edd0dbc03e222d9f9dc8d724da996d22754d6411104fd1' /tmp/zuse-nodesource-setup.sh | sha256sum --check --status
	bash /tmp/zuse-nodesource-setup.sh
	rm /tmp/zuse-nodesource-setup.sh
	apt-get install -y nodejs
fi

"$provision_dir/provision.sh" packages globals runtime layout

# Fail publication if the pinned agents cannot run as the unprivileged runtime user.
for agent in claude codex; do
	runuser -u zuse -- "$agent" --version
done

# Fail publication if native dependencies or the installed CLI cannot load.
runuser -u zuse -- /usr/local/bin/zuse --help >/dev/null

# Keep the runtime user unprivileged: no sudo or admin groups.
gpasswd -d zuse sudo 2>/dev/null || true
gpasswd -d zuse admin 2>/dev/null || true
gpasswd -d zuse docker 2>/dev/null || true
printf 'zuse ALL=(ALL) !ALL\n' >/etc/sudoers.d/zuse-deny
chmod 0440 /etc/sudoers.d/zuse-deny

echo "zuse boxd template installation complete"
