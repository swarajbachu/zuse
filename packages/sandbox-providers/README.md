# Sandbox provider adapters

This package owns the ephemeral-sandbox provider seam and registry. It is the
sibling of `@zuse/machine-providers`: that package holds the persistent-machine
lifecycle contract, while `SandboxProviderAdapter` models second-scale
microVM sandboxes (fast create, pause/resume, snapshot-and-fork, short
timeouts). The two contracts share `@zuse/provider-registry` and must not be
merged — ephemeral lifecycle guarantees would weaken the persistent contract
with optional operations.

Each adapter must:

- use a stable, unique `providerId`;
- declare whether resume preserves runtime processes; disk-only providers use
  the shared fenced restart path;
- make creation recoverable by deterministic provider label;
- normalize vendor failures to `SandboxProviderError`;
- treat kill and snapshot deletion as idempotent;
- keep credentials and raw provider payloads inside the adapter;
- apply the caller's complete network policy at creation and expose a
  single-call `setNetwork` that replaces that policy. Cloud workspace callers
  use unrestricted egress; live-identity forks may still require the
  quarantine-first re-key boundary from ADR 0033.

`SandboxProviderAdapter.resolveEndpoint` returns provider-neutral HTTPS and
WebSocket URLs — sandbox providers supply reachability directly, unlike
persistent machines, which dial out through a managed tunnel.

`SandboxProviderRegistration.aliases` maps retired persisted provider IDs to
the same adapter implementation, but aliases are never advertised as new
placement choices. Registrations marked `advertised: false` remain internal.

The Cloud Sandbox offer is provider-neutral. The public placement contract
accepts only an advertised provider ID, and checkout metadata preserves that
choice until its signed webhook provisions the sandbox. Native templates,
images, snapshots, credentials, and endpoints remain inside each adapter.
The api additionally filters placement choices through per-provider
operational readiness; offer-level checkout readiness is never used as a proxy
for every registered adapter.

## Adding a provider

1. Add one provider adapter module and export it from `package.json`.
2. Test the complete `SandboxProviderAdapter` interface using a fake HTTP
   client, including timeout recovery, idempotent deletion, and preservation
   of the caller-selected network policy.
3. Add api configuration following the pattern in
   `infra/api/src/machine-provider-modules`.

## E2B

`@zuse/sandbox-providers/e2b` provides the `e2b` adapter. It talks to the
E2B REST API directly over `fetch` (no vendor SDK, so it runs in workerd) and
authenticates with the `x-api-key` header. Forks are created from a snapshot
ID and apply the requested network policy at creation. Cloud workspace pools
pass `allow_internet_access: true` and assert the open policy again when a
workspace claims an allocation. Snapshot deletion goes through the provider's
template store. The optional quarantine capability used by live-identity
forks was verified in
`specs/cloud-platform/research/quarantined-fork-verification.md`.

## Box

`@zuse/sandbox-providers/box` provides the `box` adapter for
[Box](https://box.ascii.dev) (ascii.dev). It talks to the Box public API v1
over `fetch` with bearer auth. Boxes are full Ubuntu VMs restored from disk
snapshots: create, fork, and resume are all cold boots — no memory state
survives, which is ADR 0033's named fallback for providers without live-fork
quarantine.

Provider-shape differences the adapter absorbs:

- **Templates are named snapshots.** There is no custom-image API; the base
  template is a named snapshot published by `infra/cloud-sandboxes`
  (`box-publish.sh`), and `snapshot`/`fork` round-trip through the
  named-snapshot store. Named snapshots are account-capped (10 by default),
  and under the account-image architecture every Zuse account's image
  consumes one — the cap is the scaling gate for Box and must be raised
  with ascii.dev before production; superseded images must be deleted
  eagerly.
- **Network policy is in-guest.** Box has no host-level egress API. The base
  template bakes in a root-only `zuse-firewall` unit. Box installs restored
  template files after the normal systemd boot targets, so the adapter runs
  that script through the provider command channel after the box is usable
  and before returning it or starting untrusted runtime code. The agent user
  has no sudo. Quarantined creates and forks are verified before return and
  destroyed when the barrier cannot be proven. Requested policy is persisted
  so pause/resume restores it before handoff.
- **Processes ride the command API.** `/commands` has no env/user/tag
  parameters, so the adapter wraps commands in `sudo -u … setsid bash -c`
  with shell-quoted env exports and records the process-group leader in a
  per-tag pid file for `replaceProcess`. Box restores the `zuse` account but
  not its secondary-user home directory when the base environment is enabled,
  so the adapter recreates the root-owned runtime layout before handoff.
- **Labels are box names.** Creation PATCHes the label onto the box before
  waiting for readiness; recovery lists boxes and matches names exactly.
  Unlabeled orphans die by TTL, which always archives (never deletes) — an
  archived box costs nothing, and the reconciler's kill path is the real
  terminator.
- **Box account environment inheritance remains enabled.** The adapter never
  passes `noEnv`, which would scrub inherited environment on resume. Process
  launch preserves that environment across the privilege drop to `zuse`, with
  `HOME=/home/zuse`. Only intentionally shared material belongs in the Box
  account environment because every sandbox receives it. Current account images
  use the control plane's credential brokers for per-account agent credentials;
  legacy images retain their existing authentication mode.
- **Hosted ports are listener-sensitive.** The adapter invokes `host <port>
  --public` from `resolveEndpoint`, after the runtime listener exists, and then
  returns the stable subdomain URL. Registering during cold restore can leave
  a stale pre-listener route.
