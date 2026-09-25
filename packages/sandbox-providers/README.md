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

## Boat

`@zuse/sandbox-providers/box` provides the `box` adapter for
[Boat](https://boat.dev) (ascii.dev). It talks to the Boat public API v1
over `fetch` with bearer auth. Boat sandboxes are full Ubuntu VMs restored from disk
snapshots: create, fork, and resume are all cold boots — no memory state
survives, which is ADR 0033's named fallback for providers without live-fork
quarantine.

Provider-shape differences the adapter absorbs:

- **Templates are named snapshots.** There is no custom-image API; the base
  template is a named snapshot published by `infra/cloud-sandboxes`
  (`box-publish.sh`), and `snapshot`/`fork` round-trip through the
  named-snapshot store. Named snapshots are account-capped (10 by default),
  and under the account-image architecture every Zuse account's image
  consumes one — the cap is the scaling gate for Boat and must be raised
  with ascii.dev before production; superseded images must be deleted
  eagerly.
- **Networking is open.** Boat has no Zuse firewall or network-policy command.
  Open policy requests are local no-ops. Restricted/quarantined policies are
  rejected before create/fork allocates a machine; E2B retains its own policy
  support. See `internal-docs/cloud/box-open-networking.md` for deployment order.
- **Processes ride the command API.** `/commands` has no env/user/tag
  parameters, so the adapter wraps commands in `sudo -u … setsid bash -c`
  with shell-quoted env exports and records the process-group leader in a
  per-tag pid file for `replaceProcess`. Boat restores the `zuse` account but
  not its secondary-user home directory when the base environment is enabled,
  so the adapter recreates the root-owned runtime layout before handoff.
- **Labels are box names.** Creation PATCHes the label onto the box before
  waiting for readiness; recovery lists boxes and matches names exactly.
  Unlabeled orphans die by TTL, which always archives (never deletes) — an
  archived box costs nothing, and the reconciler's kill path is the real
  terminator.
- **Boat account environment inheritance remains enabled.** The adapter never
  passes `noEnv`, which would scrub inherited environment on resume. Process
  launch preserves that environment across the privilege drop to `zuse`, with
  `HOME=/home/zuse`. Only intentionally shared material belongs in the Boat
  account environment because every sandbox receives it. Current account images
  use the control plane's credential brokers for per-account agent credentials;
  legacy images retain their existing authentication mode.
- **Hosted ports are listener-sensitive.** The adapter invokes `host <port>
  --public` from `resolveEndpoint`, after the runtime listener exists, and then
  returns the stable subdomain URL. Registering during cold restore can leave
  a stale pre-listener route.

## boxd

`@zuse/sandbox-providers/boxd` provides the `boxd` adapter for
[boxd](https://boxd.sh). It uses the `@boxd-sh/sdk/web` entry (grpc-web over
`fetch`, so it runs in workerd) with an API key; the SDK exchanges the key for
a session token, and one client is shared per credential because the api
builds its registry per request. boxd machines are KVM microVMs that keep
their memory across a pause: a hibernated workspace wakes in milliseconds with
its runtime still running, so `preservesProcessesOnResume` is true and resume
takes the same warm path as E2B.

Provider-shape differences the adapter absorbs:

- **Templates are snapshots.** The base template is a snapshot published by
  `infra/cloud-sandboxes/boxd-publish.sh`; `snapshot` and `fork` use the same
  store. A restore replays the captured machine, so `create` and `fork` are
  both `machines.create({ fromSnapshot })` and must not pass environment
  variables (the api passes none; a non-empty map is rejected rather than
  silently dropped). Re-saving a snapshot name adds a version, so a retried
  save is idempotent.
- **Every machine is `isolated`.** No peers, no metadata endpoint, no in-VM
  boxd CLI or integrations, and the flag is inherited by every fork and
  restore. Egress is open; restricted and quarantined policies are rejected
  before a machine is allocated, like Boat.
- **Sizes are provider-wide.** `small` (1 vCPU / 4 GiB), `default`
  (2 / 8) and `large` (4 / 16). A restore keeps its snapshot's size, so a
  different placement is applied afterwards as a cold `resize` reboot; publish
  the template at the deployment's default size (`BOXD_MACHINE_SIZE`) to make
  that a no-op.
- **Pause is an idle timer, terminate a wall clock.** `onTimeout: "pause"`
  arms `autoHibernateTimeout` right after creation (before waiting for
  readiness, so a machine that never answers is not left on the org default)
  and `extendTimeout` re-arms it; `"terminate"` sets `autoDestroyTimeout` at
  creation, which boxd counts from the machine's (re)start regardless of
  activity and resets on a restart or wake, matching the reconciler's build
  deadline. The idle clock counts packets on
  established connections too, so the runtime's outbound gateway session keeps
  a working agent awake with the desktop closed (verified: a machine with a
  60 s timer and only outbound requests stayed running for 150 s), and the
  clock restarts on wake, so re-arming right after `resume` does not park the
  machine again. Auto-suspend stays off. `pause` hibernates a
  running machine (memory to disk, effectively free while parked) and confirms
  it parked; a machine that is still booting is retried later rather than
  recorded as paused. `resume` wakes, starts a stopped machine, and waits for
  systemd before handing over. Only the wake and hibernate paths preserve
  processes: a machine stopped outside the adapter boots cold, and a resize
  reboots, so those resumes fall through to the reconciler's fenced restart.
- **Fresh machines are primed before hand-over.** The reconciler gives an
  allocated machine ten seconds to enroll, and a restored VM pages for its
  first seconds: measured on the workspace image, the runtime listened after
  2.7 s on a fresh restore (3.8 s with cold caches, 1.4 s warm) and the first
  transient unit took 0.6 s (16 ms warm); real starts under load missed the
  window by under a second. `allocate`, and the cold-boot resumes above, load
  the runtime CLI once and start one throwaway unit as the runtime user, so
  that cost lands before the window opens. Priming is best effort.
- **Labels are machine names**, which are DNS labels (lowercase, digits,
  hyphens, 63 characters). Labels that already qualify pass through; others
  are lowercased with a digest suffix, and the same mapping drives
  `recoverByLabel`, which resolves by name (API keys are fenced to one
  organization). Names are unique, so a `failed` machine is deleted when it
  is found and a machine that never becomes usable is deleted after the
  readiness deadline; both keep the label free for the replacement.
- **Processes reuse the Boat launcher.** Tagged processes run in transient
  systemd units through the shared `box-process` helpers; untagged commands
  run detached under `setsid`. Commands run as the `boxd` user with `sudo -n`.
- **Routes are named proxies.** `p<port>.<machine>.boxd.sh` is created on
  demand and the runtime port's route is captured in the template snapshot so
  its DNS exists before the first connection. Proxies target the VM interface
  while the runtime binds loopback, so `resolveEndpoint` starts the shared
  port forwarder each time it is called; a restore or fork receives a fresh
  interface address, and the forwarder rebinds it. WebSockets pass through.
- **No billing evidence yet.** boxd has no lifecycle webhook, no event log
  to replay, and its machine records carry only `createdAt` and
  `hibernatedAt`, so there is no `BillingUsageSourceModule` for it: the
  reconciler reserves boxd compute at the price schedule while a run lasts,
  but nothing finalizes those reservations into the ledger. Metering boxd
  needs provider-side execution events (see `internal-docs/cloud/billing.md`).
