#!/usr/bin/env bash
# Box-side template installation, executed as root inside a fresh box by
# box-publish.sh. Runs the shared provision stages, then layers on the
# Box-specific pieces: the in-guest quarantine firewall, boot-time port
# hosting, and the no-sudo guarantee for the zuse user.
set -euo pipefail

provision_dir="${ZUSE_PROVISION_DIR:-/tmp/zuse-provision}"

# Ignore the stock command user's NVM Node/npm when installing native modules.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin

# Node 22 is the supported runtime floor and keeps the native tree-sitter
# dependency on prebuilt binaries; replace whatever the stock image ships.
if ! command -v node >/dev/null 2>&1 || [ "$(node --version | cut -c2-3)" != "22" ]; then
	# Pin the reviewed setup script before allowing any root execution.
	curl --proto '=https' --proto-redir '=https' -fsSL --max-time 60 https://deb.nodesource.com/setup_22.x -o /tmp/zuse-nodesource-setup.sh
	printf '%s  %s\n' '575583bbac2fccc0b5edd0dbc03e222d9f9dc8d724da996d22754d6411104fd1' /tmp/zuse-nodesource-setup.sh | sha256sum --check --status
	bash /tmp/zuse-nodesource-setup.sh
	rm /tmp/zuse-nodesource-setup.sh
	apt-get install -y nodejs
fi

apt-get update
apt-get install -y --no-install-recommends nftables

# Replace stock launchers with the versions installed by the shared stages.
for launcher in pnpm pnpx yarn yarnpkg corepack bun bunx claude codex; do
	rm -f "/usr/local/bin/$launcher"
done

"$provision_dir/provision.sh" packages globals runtime layout

# Fail publication if native dependencies or the installed CLI cannot load.
runuser -u zuse -- /usr/local/bin/zuse --help >/dev/null

# Quarantine firewall: root-only script + boot unit (ADR 0035).
install -m 0755 "$provision_dir/box/zuse-firewall" /usr/local/sbin/zuse-firewall
install -m 0644 "$provision_dir/box/zuse-firewall.service" /etc/systemd/system/zuse-firewall.service
install -m 0644 "$provision_dir/box/zuse-host-ports.service" /etc/systemd/system/zuse-host-ports.service
systemctl daemon-reload
systemctl enable zuse-firewall.service zuse-host-ports.service
systemctl start zuse-firewall.service

# The barrier only holds if untrusted code cannot become root: zuse gets no
# sudo, no admin groups, and an explicit deny-all sudoers entry.
gpasswd -d zuse sudo 2>/dev/null || true
gpasswd -d zuse admin 2>/dev/null || true
gpasswd -d zuse docker 2>/dev/null || true
printf 'zuse ALL=(ALL) !ALL\n' >/etc/sudoers.d/zuse-deny
chmod 0440 /etc/sudoers.d/zuse-deny

# Host the runtime port now so the publishing checks can reach it; the boot
# unit repeats this on every box created from the snapshot.
systemctl start zuse-host-ports.service || true

echo "zuse box template installation complete"
