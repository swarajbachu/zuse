# Cloud sandbox template

For the surrounding control plane, lifecycle, cache, and security model, start
with the [Zuse Cloud documentation](../../docs/cloud/README.md).

The credential-free base template contains the Zuse runtime, supported developer
toolchain, and preconfigured Git and `gh` credential broker. An account-image
build adds the user's selected normal Git checkouts below
`/home/repos/<owner>/<repository>`. Broker-capable images keep reusable agent
credentials in the account authentication authority and retain only non-secret
provider status; legacy images may still contain their historical provider
authentication. Each chat forks that account image, starts the runtime from
`/home/zuse`, and selects one existing checkout without cloning, fetching,
copying, or creating a worktree. Its inert `sleep infinity` base command is
deliberate.

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
with the api change:

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
every template publication. The api forks a compatible prepared cache when
one exists and otherwise creates from the current base template and performs a
normal authenticated clone. Cache refresh failures therefore affect startup
speed, not workspace availability. Set the `E2B_API_KEY` Worker secret with
`bun --filter @zuse/api secret:e2b`, and deploy the api only after the
template can be created with the configured API key.

Adapter environment variables only determine availability. The user selects
placement in the composer; no adapter configured in the api becomes an
account default. Future adapters keep native image, snapshot, or recipe
settings under their own prefixes while sharing the workspace lifecycle.

The api injects boot values into the process, never the template environment.
Managed-server runtime manifests are intentionally not reused by cloud
workspaces. A cloud-specific signed manifest may be configured separately after
its workspace protocol has passed staging compatibility checks; otherwise the
workspace uses the runtime baked into the published template.
The explicit account-image build synchronizes every selected repository, removes
transient GitHub credentials and runtime identity, validates the result, and
creates one private snapshot. Normal workspace launch performs no Git network
operation. Repository freshness changes only through Update image.

Every derived image retains the base template's Git credential helper and `gh`
wrapper. The workspace runtime publishes only the broker address and its
renewable runtime credential during normal bootstrap. The first GitHub command
lazily requests a short-lived GitHub App token; later commands reuse the cached
token and refresh it shortly before expiry. No GitHub request is added to the
workspace or session startup path, and no installation token is stored in a
template or account snapshot.

The runtime exchanges the one-time token for a renewable workspace credential,
installs any runtime-scoped credential grant, opens the selected local branch,
and acknowledges the durable start command. Broker-capable account snapshots
contain neither provider authentication nor GitHub installation tokens, runtime
identity, shell history, or authenticated processes. Provider grants are sealed
directly to the enrolled runtime key and remain process-local; Grok's access-only
CLI cache is redirected to sandbox tmpfs.
