# Build apps/server/dist-review with scripts/build-review-worker.mjs first.
# Deployment must pin the resulting image digest and pass the release gates.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/zuse /run/zuse-review-auth /run/zuse-review-work /run/zuse-review-login \
    && chown -R node:node /run/zuse-review-auth \
    && chmod 700 /run/zuse-review-auth /run/zuse-review-work \
    && chmod 711 /run/zuse-review-login
COPY dist-review/ /opt/zuse/
USER root
# Supervisor alone is root; native CLI drops to1000 and reader to1001.
WORKDIR /opt/zuse
RUN node /opt/zuse/review-worker.mjs --check
# No automatic inference/login; lifecycle starts explicitly after admission.
CMD ["sleep", "infinity"]
