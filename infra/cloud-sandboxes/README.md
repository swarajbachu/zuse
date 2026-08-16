# Cloud sandbox template

This credential-free image contains the Zuse runtime and supported developer
toolchain. Its inert `sleep infinity` command is deliberate. Project builders
start `zuse-project-builder`; workspace forks start `zuse-workspace-bootstrap`
with a one-time workspace boot token. The runtime binds only to loopback and
opens an authenticated outbound connection to the workspace gateway, so no
provider endpoint is exposed to clients.

SSH access does not run a listening daemon. The runtime's `/ssh` WebSocket
route (ticket-gated, cloud-environment role only) spawns `sshd -i` per
connection with `/home/zuse/.ssh/sshd_config`; `workspace-bootstrap.sh`
generates a per-workspace host key and clears inherited authorized keys, so
neither survives a fork. `openssh-server` and `rsync` in the image exist for
this bridge and the desktop's cloud-to-local file sync.

Node 22 is intentional. It satisfies the server's runtime floor and remains
compatible with the native tree-sitter dependency; Node 24 currently forces an
incompatible source rebuild of that dependency on Linux.

## Build and configure staging

Build the server tarballs from this exact checkout first. This avoids depending
on a separately published runtime and keeps the external-bind behavior atomic
with the relay change:

```sh
infra/cloud-sandboxes/prepare-artifacts.sh
```

Authenticate the provider CLI with a team access token, then create the current
Dockerfile-based template:

```sh
npx --yes @e2b/cli@latest template create zuse-cloud-sandbox \
  --path infra/cloud-sandboxes \
  --cmd "sleep infinity" \
  --ready-cmd "true" \
  --cpu-count 2 \
  --memory-mb 4096
```

The current CLI's `template create` command is used instead of the legacy
`e2b.toml` workflow. This provider's template ID stays inside its adapter
configuration; it is not part of the provider-neutral Cloud Sandbox offer.
Keep the stable template alias in `E2B_TEMPLATE_ID` and copy the immutable build
identifier printed by the CLI to `E2B_TEMPLATE_VERSION`. Change that version on
every template publication. The relay forks a compatible prepared cache when
one exists and otherwise creates from the current base template and performs a
normal authenticated clone. Cache refresh failures therefore affect startup
speed, not workspace availability. Set the `E2B_API_KEY` Worker secret with
`bun --filter @zuse/relay secret:e2b`, and deploy the relay only after the
template can be created with the configured API key.

Adapter environment variables only determine availability. The user selects
placement in the composer; no adapter configured in the relay becomes an
account default. Future adapters keep native image, snapshot, or recipe
settings under their own prefixes while sharing the workspace lifecycle.

The relay injects boot values into the process, never the template environment.
Managed-server runtime manifests are intentionally not reused by cloud
workspaces. A cloud-specific signed manifest may be configured separately after
its workspace protocol has passed staging compatibility checks; otherwise the
workspace uses the runtime baked into the published template.
The optional fast-start cache clones the selected repository as a bare mirror,
removes credentials and runtime identity, validates the result, and creates a
snapshot. It does
not evaluate repository environment configuration, install dependencies, or run
the project setup command. Install dependencies later from the workspace terminal
or through the agent when the task requires them.

The runtime exchanges the one-time token for a renewable workspace credential,
installs account credentials, removes the boot token, fetches the latest base,
checks out the task branch, and acknowledges the durable start command. The
prepared snapshot contains no repository token, agent credential, runtime
identity, shell history, or authenticated process.
