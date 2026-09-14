FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV ZUSE_PROVISION_DIR=/tmp/zuse-provision

# All installation behavior lives in provision.sh, shared with the Box
# template publisher (box-publish.sh) so the two images cannot drift.
COPY --chmod=0755 provision.sh /tmp/zuse-provision/provision.sh

RUN /tmp/zuse-provision/provision.sh packages

RUN /tmp/zuse-provision/provision.sh globals

# These tarballs are built from this checkout. The current server/serve release
# is intentionally not fetched from npm: the sandbox external-bind behavior
# must ship atomically with the api that depends on it.
COPY artifacts /tmp/zuse-provision/artifacts
COPY sshd_config project-builder.sh workspace-bootstrap.sh git-askpass.sh github-auth.sh repository-script.ts /tmp/zuse-provision/

RUN /tmp/zuse-provision/provision.sh runtime layout \
	&& rm -rf /tmp/zuse-provision

USER zuse
WORKDIR /home/zuse

# The api starts Zuse through envd after Sandbox.create. Create-time env vars
# are intentionally not consumed by an image start command.
CMD ["sleep", "infinity"]
