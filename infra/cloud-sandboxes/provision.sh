#!/usr/bin/env bash
# Shared sandbox provisioning steps. The E2B Dockerfile and the Box template
# publisher (box-publish.sh) both run these stages so the two images cannot
# drift: one behavior, one source of truth.
#
# Usage: provision.sh <stage> [...]
#   packages  install the apt toolchain
#   globals   install pinned npm globals
#   runtime   install the zuse server/serve tarballs from $ZUSE_PROVISION_DIR
#   layout    create the zuse user, install scripts, and lay out directories
#
# $ZUSE_PROVISION_DIR must contain (for runtime/layout):
#   artifacts/zusehq-server.tgz  artifacts/zusehq-serve.tgz
#   artifacts/runtime-updater.mjs  project-builder.sh  workspace-bootstrap.sh
#   git-askpass.sh  github-auth.sh  repository-script.ts  sshd_config
set -euo pipefail

provision_dir="${ZUSE_PROVISION_DIR:-/tmp/zuse-provision}"

stage_packages() {
	export DEBIAN_FRONTEND=noninteractive
	apt-get update
	apt-get install -y --no-install-recommends \
		build-essential \
		ca-certificates \
		curl \
		fd-find \
		git \
		git-lfs \
		gh \
		jq \
		openssh-client \
		openssh-server \
		python3 \
		python3-pip \
		python3-venv \
		ripgrep \
		rsync \
		sqlite3 \
		tmux \
		util-linux
	rm -rf /var/lib/apt/lists/*
}

stage_globals() {
	npm install --global \
		@anthropic-ai/claude-code@2.1.224 \
		@openai/codex@0.144.5 \
		bun@1.3.10 \
		corepack@0.34.1
	npm cache clean --force
	# Pin the broker-compatible Grok CLI in both providers.
	mkdir -p /opt/grok
	# Reviewed installer digest; upstream changes fail closed until reviewed.
	curl --proto '=https' --proto-redir '=https' -fsSL --max-time 60 https://x.ai/cli/install.sh -o /tmp/install-grok.sh
	printf '%s  %s\n' '7fd6fdc75d9418b2e58356726fcbf1ae849416f773925da07d0ccc7a60d3e791' /tmp/install-grok.sh | sha256sum --check --status
	HOME=/opt/grok GROK_BIN_DIR=/usr/local/bin bash /tmp/install-grok.sh 1.0.13
	grok --version
	rm /tmp/install-grok.sh
}

stage_runtime() {
	npm install --global "$provision_dir/artifacts/zusehq-server.tgz"
	mkdir -p /usr/local/lib/zuse-serve
	tar -xzf "$provision_dir/artifacts/zusehq-serve.tgz" --strip-components=2 -C /usr/local/lib/zuse-serve package/dist
	# The serve bundle resolves runtime dependencies from the server package.
	ln -sfn /usr/local/lib/node_modules/@zusehq/server/node_modules /usr/local/lib/zuse-serve/node_modules
	ln -sf /usr/local/lib/zuse-serve/bin.mjs /usr/local/bin/zuse
	chmod 0755 /usr/local/lib/zuse-serve/bin.mjs
	npm cache clean --force
}

stage_layout() {
	if ! id zuse >/dev/null 2>&1; then
		useradd --create-home --shell /bin/bash zuse
	fi
	mkdir -p /home/zuse/.zuse-data /home/zuse/.ssh /home/repos
	chmod 700 /home/zuse/.ssh

	# Single-connection sshd config used by the runtime's WebSocket SSH bridge
	# (`sshd -i`, spawned per connection as user zuse — no listening daemon).
	install -m 0600 -o zuse -g zuse "$provision_dir/sshd_config" /home/zuse/.ssh/sshd_config
	install -D -m 0600 -o root -g root "$provision_dir/sshd_config" /usr/local/share/zuse/sshd_config

	install -m 0755 "$provision_dir/project-builder.sh" /usr/local/bin/zuse-project-builder
	install -m 0755 "$provision_dir/workspace-bootstrap.sh" /usr/local/bin/zuse-workspace-bootstrap
	install -m 0755 "$provision_dir/git-askpass.sh" /usr/local/bin/zuse-git-askpass
	install -m 0755 "$provision_dir/github-auth.sh" /usr/local/bin/zuse-github-auth
	ln -sf /usr/local/bin/zuse-github-auth /usr/local/bin/gh
	install -D -m 0644 "$provision_dir/repository-script.ts" /usr/local/lib/zuse/repository-script.ts
	install -D -m 0644 "$provision_dir/artifacts/runtime-updater.mjs" /usr/local/lib/zuse/runtime-updater.mjs

	mkdir -p /var/lib/zuse/project-build /var/lib/zuse/workspace /opt/zuse/releases
	chown -R zuse:zuse /home/zuse /home/repos /var/lib/zuse /opt/zuse
	runuser -u zuse -- /usr/local/bin/zuse-github-auth install
}

for stage in "$@"; do
	case "$stage" in
	packages) stage_packages ;;
	globals) stage_globals ;;
	runtime) stage_runtime ;;
	layout) stage_layout ;;
	*)
		echo "unknown provision stage: $stage" >&2
		exit 1
		;;
	esac
done
