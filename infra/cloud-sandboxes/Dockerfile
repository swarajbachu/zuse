FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
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
        util-linux \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global \
		@anthropic-ai/claude-code@2.1.224 \
		@openai/codex@0.144.5 \
		bun@1.3.10 \
		corepack@0.34.1 \
	&& npm cache clean --force

# These tarballs are built from this checkout. The current server/serve release
# is intentionally not fetched from npm: the sandbox external-bind behavior
# must ship atomically with the relay that depends on it.
COPY artifacts/zusehq-server-0.1.2.tgz /tmp/zusehq-server.tgz
COPY artifacts/zusehq-serve-0.1.3.tgz /tmp/zusehq-serve.tgz
RUN npm install --global /tmp/zusehq-server.tgz \
	&& mkdir -p /usr/local/lib/zuse-serve \
	&& tar -xzf /tmp/zusehq-serve.tgz --strip-components=2 -C /usr/local/lib/zuse-serve package/dist \
	&& ln -s /usr/local/lib/zuse-serve/bin.mjs /usr/local/bin/zuse \
	&& chmod 0755 /usr/local/lib/zuse-serve/bin.mjs \
	&& rm /tmp/zusehq-server.tgz /tmp/zusehq-serve.tgz \
	&& npm cache clean --force

RUN useradd --create-home --shell /bin/bash zuse \
    && mkdir -p /home/zuse/.zuse-data /home/zuse/.ssh /var/cache/zuse/repositories \
    && chmod 700 /home/zuse/.ssh \
    && chown -R zuse:zuse /home/zuse /var/cache/zuse

# Single-connection sshd config used by the runtime's WebSocket SSH bridge
# (`sshd -i`, spawned per connection as user zuse — no listening daemon).
COPY --chown=zuse:zuse --chmod=0600 sshd_config /home/zuse/.ssh/sshd_config

COPY --chmod=0755 project-builder.sh /usr/local/bin/zuse-project-builder
COPY --chmod=0755 workspace-bootstrap.sh /usr/local/bin/zuse-workspace-bootstrap
COPY --chmod=0755 git-askpass.sh /usr/local/bin/zuse-git-askpass
COPY repository-script.ts /usr/local/lib/zuse/repository-script.ts
COPY artifacts/runtime-updater.mjs /usr/local/lib/zuse/runtime-updater.mjs

RUN mkdir -p /var/lib/zuse/project-build /var/lib/zuse/workspace \
	&& mkdir -p /opt/zuse/releases \
	&& chown -R zuse:zuse /var/lib/zuse /opt/zuse

USER zuse
WORKDIR /home/zuse

# The relay starts Zuse through envd after Sandbox.create. Create-time env vars
# are intentionally not consumed by an image start command.
CMD ["sleep", "infinity"]
