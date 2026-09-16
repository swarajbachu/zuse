# Cloud sandbox template

For the surrounding control plane, lifecycle, cache, and security model, start
with the [internal Zuse Cloud documentation](../../internal-docs/cloud/README.md).

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

## User setup and provider maintenance

The user-facing destination is **Cloud**. Box is the only advertised workspace
provider. E2B stays registered for the account authentication authority and for
existing E2B workspaces; it does not appear as a new placement or checkout option.
When Box is configured it is the deployment default automatically; this does not set an account-level default. An E2B-only deployment
can service retained workspaces and authentication, but cannot create new Cloud
workspaces. Production Box availability remains gated until live validation.

Users connect each agent once in Cloud settings. Those account-level connections
serve Box workspaces through the existing credential brokers; no second login or
user-supplied Box/E2B key is needed. **Cloud image → Rebuild image** rebuilds the
configured default's account image from the selected repositories. It leaves
existing workspaces and authentication-authority connections intact. Provider
snapshots are never interchangeable.

Base templates are operator-maintained and separate from that user action:

- **Box:** run `infra/cloud-sandboxes/box-publish.sh <new-version>` with the Box
  secret available, then install its printed `BOX_TEMPLATE_SNAPSHOT` and
  `BOX_TEMPLATE_VERSION` values. Rebuild the Cloud account image afterward.
- **E2B:** follow the template publication instructions above and update
  `E2B_TEMPLATE_VERSION`. Keep `E2B_ADAPTER_ENABLED=true` while the authentication
  authority or retained workspaces depend on it. Users do not rebuild or select
  that infrastructure separately.

Before deploying the Box-only placement policy to production, publish and verify
its template, a fresh account image, a real model response, a shell tool call,
and billing ingestion, then configure and enable Box in the production Worker.
Do not deploy that policy into an E2B-only production configuration: new Cloud
placements and checkout would be unavailable by design. Existing workspace
lifecycle operations continue to use their recorded provider.

## Box template

Box (box.ascii.dev) has no custom-image API; its template is a **named
snapshot** built by provisioning a fresh box and freezing it. All shared
installation behavior lives in `provision.sh` — the same stages the
Dockerfile runs — so the two templates cannot drift. The Box-specific layer
(`box/`) adds what the provider shape requires:

- `zuse-firewall` + `zuse-firewall.service` — the in-guest egress quarantine
  (ADR 0035). The systemd unit handles ordinary boots; because Box restores
  template files after boot targets have passed, the adapter also applies
  policy explicitly before handing a restored box to untrusted code. Only
  the api's root-only provider command can change it, and the zuse user has
  no sudo.
- `zuse-host-ports.service` — re-hosts the runtime port on the box's stable
  public HTTPS URL on ordinary boots. The adapter registers requested ports
  during endpoint resolution, after the listener exists, because restored
  units do not exist during initial systemd boot and Box's tunnel binding is
  listener-sensitive.
- `install.sh` — root-side installer that pins system Node 22, excludes the
  stock user's NVM from provisioning, installs nftables, runs the shared stages,
  and strips sudo from the zuse user. Global packages use `/usr/local` explicitly;
  a CLI startup check rejects templates with missing native dependencies.

Tagged Box processes run in transient systemd services created by the adapter.
Replacement stops the complete service control group, cleans up older detached
runtimes, and launches the new process in one provider command. These services
are not enabled at boot and do not automatically restart: the API must authorize
a fresh runtime generation and boot token before each launch. Account environment
variables, the target user, and command arguments are preserved. Untagged build
commands retain detached execution. The current Box base uses systemd 255; the
launcher requires systemd 254 or newer for literal argument forwarding.

Publish with:

```sh
BOX_API_KEY=... infra/cloud-sandboxes/box-publish.sh <version>
```

After updating this branch, publish a fresh version before deployment: the
historical version-3 Box snapshot does not contain the current GitHub broker
wrapper and pinned Grok CLI. Rebuild account images too so their broker delivery
markers match the enabled API enrollment gates. A successful runtime connection
alone does not validate agent authentication; verify an actual model response
and shell tool call in the fresh workspace.

Copy the printed `BOX_TEMPLATE_SNAPSHOT` / `BOX_TEMPLATE_VERSION` values into
the api wrangler configuration and set the Worker secret with
`bun --filter @zuse/api secret:box`. Named snapshots are account-capped
(10 by default), and that budget is shared by the base template, every Zuse
account's image, and any transient auth snapshots — one snapshot per active
account makes this cap the scaling gate for Box. Raise the limit with
ascii.dev before production and keep superseded base versions and images
deleted. Run the live adapter suite against a freshly published template
(`BOX_API_KEY=... BOX_TEMPLATE_SNAPSHOT=zuse-base-v<N> bun --filter
@zuse/sandbox-providers test:live`) before pointing staging at it.

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


### Installer integrity

Both template paths verify the Grok installer against a repository-pinned SHA-256
before root execution. Box does the same for the NodeSource 22 setup script.
The digests were reviewed against the HTTPS upstream scripts on 2026-09-14.
An upstream script change intentionally fails the build: inspect the new script
and update its pinned digest in code rather than bypassing the check.

Restricted Box policies resolve hostnames to IPs when applied and enforce
explicit denies before allows. They grant no blanket external DNS access.
Use literal IPs or preconfigured local name resolution; this is not a
domain-filtering resolver. Reapply policies to refresh DNS-derived IPs.
