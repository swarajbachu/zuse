# boxd integration operations

Engineering and deployment reference for boxd in Zuse. For setup and everyday
workspace behavior, see [boxd in Zuse](boxd.md).

## Operator setup

The adapter is registered beside Boat and E2B. Its enable flag defaults off
when absent; the checked-in production configuration explicitly enables it.
The [September 28 deployment record](deployments/2026-09-28-boxd-production.md)
captures the original rollout and its verification limits. The implementation
lives in the [adapter](../../packages/sandbox-providers/src/boxd.ts) and
[API provider module](../../infra/api/src/sandbox-provider-modules/boxd.ts).


1. Publish a base template: `BOXD_API_KEY=... BOXD_ORG=<org>
   infra/cloud-sandboxes/boxd-publish.sh <version>` (see the
   [template README](../../infra/cloud-sandboxes/README.md#boxd-template)).
2. Set the `BOXD_API_KEY` Worker secret (`bun --filter @zuse/api secret:boxd`,
   `secret:boxd:production` for production). Mint the key with
   `boxd auth keys create zuse-api --org <org>`; keys are fenced to one
   organization, and every machine and snapshot lands there.
3. Set `BOXD_TEMPLATE_SNAPSHOT`, `BOXD_TEMPLATE_VERSION`, `BOXD_MACHINE_SIZE`
   (`small` | `default` | `large`) and, for an org-fenced key, `BOXD_ORG` in the
   wrangler configuration, then `BOXD_ADAPTER_ENABLED=true`. Optional:
   `BOXD_BASE_URL` for a self-hosted cluster (HTTPS, gRPC-web port).
   A deployment without E2B must also set `CLOUD_AUTH_PROVIDER_ID=boxd`: the
   account login authority defaults to E2B, and every agent connection in
   Cloud settings runs there. The value must name an enabled adapter; the
   worker refuses to boot and the production deploy guard refuses to deploy
   otherwise. It applies to authorities created from then on: an account's
   existing authority stays on the provider that hosts it, and if that
   provider is no longer registered, Cloud authentication reports
   `cloud_auth_provider_unavailable` for the account until it is registered
   again or the account reconnects on the new provider. On boxd the authority
   is an ordinary isolated machine from the base template; account images
   are never seeded from its snapshot, so credentials reach workspaces
   through the brokers.
4. Rebuild account images for boxd from Cloud settings; provider snapshots are
   never interchangeable.

The production deploy script refuses to deploy with the adapter enabled and
the snapshot, version, or `BOXD_API_KEY` secret missing, or cloud billing
enforcement enabled without the estimated-balance opt-in. Runtime placement uses
the same eligibility policy.

When `BOXD_ORG` is set, the publisher creates a shared organization template so
another identity in that organization can restore it. Without an explicit org,
publish with the same API key owner used by the Worker.

## Behaviour that differs from Boat and E2B

- Pause hibernates the machine (memory written to disk) and resume wakes it
  with the runtime and agent processes intact, so workspaces
  take the warm reconnect path like E2B. A machine woken by inbound traffic
  before the api asks is treated as resumed; a pause that does not park the
  machine (traffic woke it straight back, or it was still booting) is reported
  as retryable rather than recorded. A machine stopped from the boxd console
  boots cold on resume and reaches the runtime through the fenced restart
  after the warm reconnect window.
- Workspaces get an idle timer: hibernate after `keepAliveTimeoutSeconds`
  without inbound network activity. That includes incoming packets on the
  runtime's outbound gateway connection. Active Zuse agent turns also have a
  shared keepalive path, independent of whether the desktop is open, and the
  provider's idle clock restarts on wake. Arbitrary network-silent background
  processes are not an always-on guarantee; CPU activity alone does not reset
  boxd's timer. The reconciler's own
  idle pause still runs first. Zuse refreshes that deadline for explicit user
  actions and active agent turns, not RPC heartbeats, read polling, or passive
  subscription responses. Leaving an idle chat connected therefore does not
  count as continued work. Build sandboxes get boxd's destroy timer
  instead, which counts `createTimeoutSeconds` from the machine's start
  regardless of activity: a build that outlives the deadline is destroyed.
- Every machine is isolated (no in-VM boxd CLI, integrations, or peers). Egress
  is open; restricted policies are rejected like Boat.
- A restore keeps its snapshot's size. Choosing another placement in the
  composer costs one cold reboot at creation (about 3 s); resuming never
  resizes unless the placement changed.
- Enrollment has a ten-second budget after allocation, and a machine restored
  from the image snapshot is slow for its first seconds. The adapter primes
  the runtime (`zuse --version` as `zuse` plus one transient unit) inside
  `allocate` and cold-boot resumes, ahead of that budget; the first real starts
  without it missed the window by under a second and only succeeded through
  the reconciler's automatic restart.
- Preview and SSH endpoints use named proxies. The adapter constructs URLs from
  the machine's active `access.domain`, for example
  `https://p3000.<machine>.boxd.zuse.sh`, rather than trusting a stale
  cluster-domain value in proxy listings.
  The runtime port's route is part of the template so DNS exists before the
  first connection; a new preview port resolves immediately under the
  machine's wildcard. Traffic to a proxy reaches the VM interface, so the
  adapter runs the shared loopback forwarder on every endpoint resolution.
  The renderer discovers listening ports while a ready Boxd chat or its
  browser preview is active, publishes verified HTTP ports 1024 and above only after the user enables auto-creation,
  and shows their URLs in the browser's server list and the
  dedicated Ports and previews menu in the top bar. Both menus support copying preview URLs. The toolbar's server
  button returns to that list to switch ports or copy a link. Opening a Boxd
  preview uses its HTTPS URL when auto-creation is enabled; otherwise it opens
  a local SSH forward. Other
  providers retain their existing SSH preview behavior. Chat and browser
  share one poller per workspace; successful routes are reused, failures
  retry independently, and discovery backs off while disconnected. Polling
  stops when neither surface is active or the workspace is no longer ready.
  These are public URLs: anyone with a link can reach the server. Pausing
  does not revoke a Boxd link, because inbound proxy traffic can wake the VM.
- There is no attributable actual-cost settlement feed wired into Zuse. Machine
  records carry only `createdAt` and `hibernatedAt`, so no actual-cost settlement
  source exists for boxd. The optional estimated balance policy durably deducts
  sampled allocated CPU/RAM costs and enforces the balance cap until attributable
  provider costs can replace them. Estimates are not confirmed invoice charges.
  Runtime observations are independently
  exported to Polar as `zuse_cloud_runtime_observed_ms` when
  `CLOUD_USAGE_EXPORT_ENABLED=true`; they are sampled activity, not exact costs.
  See [usage operations](billing.md#usage-visibility-independent-of-invoices); billing-enforced placement requires the
  [estimated balance policy](billing.md#interim-boxd-balance-deductions), including
  `CLOUD_BOXD_ESTIMATES_CUTOVER_AT` and an installed USD estimate price schedule.
- The 50 concurrent machine cap per organization counts hibernated machines
  and forks. Deleted workspaces free their slot; snapshots do not count.

## How conversation forks work

Boxd workspaces expose **Fork in new tab** (same machine) and **Fork in
new machine** (new chat and machine). Other cloud providers do not expose
these actions. Local tab/worktree behavior is unchanged.

The desktop uses a dedicated `cloud.workspaces.fork` RPC and
`POST /v1/cloud/workspaces/fork` endpoint. Older desktop servers and hosted
APIs reject this operation instead of dropping fork metadata and creating an
empty image restore. Deploy the API and compatible runtime before enabling
the action in a desktop build.

A local preview of the selected conversation is staged before opening the new
chat and persisted in the existing timeline cache. It contains no inherited
running turn, queue, or interaction state; the authoritative child checkpoint
replaces it when available.

Machine forks use the native SDK `machines.fork`, preserving the machine's
disk and memory rather than restoring the project image. The SDK documents
that native forks inherit the source egress allowlist. The lifecycle owner
leases the source and persists a network-recovery intent, briefly applies a
host-enforced quarantine, forks, and restores the parent's networking.
A reconciler restores it if the worker disappears. Snapshot restores cannot
use this mechanism because they do not inherit the allowlist. The parent can
briefly lose outbound connectivity during quarantine; its identity and files
remain unchanged.

boxd's advertised fork time measures the platform operation. Zuse additionally
waits for quarantine propagation (currently 1.1 seconds), prepares the child,
imports the conversation, and reconnects. Do not promise a sub-200 ms Zuse fork
or that a managed agent continues its copied in-flight turn in the child.

Within the quarantined child, the copied Zuse runtime and its managed agent
processes are stopped and restarted with a fresh workspace identity. Other
machine processes retain their cloned memory. The complete stopped database
directory (including WAL) is verified and retained under
`/var/lib/zuse/fork-source/<new-workspace-id>/user-data`; copied queues are
never attached as the child's live database. The selected conversation through
the fork point is imported using the shared transcript-fork behavior, including
native provider continuation where supported. Stable import IDs make retries
idempotent. Provider session files, attachments, local commits, staged changes,
and untracked files remain available. The new branch starts at captured HEAD.

The source runtime must advertise `machine-fork-v1`; older runtimes need an
update before machine forking. Enrollment uses the existing bootstrap flow
with a fresh token, transcript key, gateway fence, and SSH identity.
This implements the identity isolation described in
[fork identity ADR 0033](../../specs/cloud-platform/decisions/0033-fork-identity.md),
with the current storage behavior described in its implementation note.
See the installed SDK README or
[SDK documentation](https://www.npmjs.com/package/@boxd-sh/sdk).

## Implementation and test references

| Area | Source and regression coverage |
| --- | --- |
| VM allocation, hibernate/wake, proxies, native forks | [Adapter](../../packages/sandbox-providers/src/boxd.ts), [unit tests](../../packages/sandbox-providers/test/unit/boxd.test.ts), [live lifecycle test](../../packages/sandbox-providers/test/live/boxd.live.test.ts) |
| Fork ownership, isolation, and recovery | [Lifecycle coordination](../../infra/api/src/cloud-workspace-fork.ts), [ownership tests](../../infra/api/test/unit/cloud-workspace-fork.test.ts), [fork preparation tests](../../infra/api/test/unit/cloud-workspace-fork-prepare.test.ts) |
| Preview discovery and revocation | [Discovery](../../apps/renderer/src/lib/preview-discovery.ts), [publication lifecycle](../../apps/renderer/src/lib/preview-publication.ts), [regression tests](../../apps/renderer/test/unit/preview-publication.test.ts) |
| Idle policy | [Activity classifier](../../apps/server/src/api/cloud-workspace-activity.ts), [tests](../../apps/server/test/unit/cloud-workspace-activity.test.ts) |
| Usage reporting | [Usage service](../../infra/api/src/cloud-usage.ts), [runtime usage tests](../../infra/api/test/unit/cloud-runtime-usage.test.ts), [billing operations](billing.md) |

## Provider verification

- Unit: `bun --filter @zuse/sandbox-providers test:unit` (fake SDK client) and
  `bun --filter @zuse/api test:unit`.
- Live: `BOXD_API_KEY=... BOXD_ORG=<org> BOXD_TEMPLATE_SNAPSHOT=zuse-base-v<N>
  bun --filter @zuse/sandbox-providers test:live` creates a machine from the
  template, runs the installed CLI as `zuse`, serves HTTP and a WebSocket echo
  through a named proxy, round-trips a file, hibernates and wakes with the
  tagged process intact, replaces it through the fenced restart path,
  snapshots, forks from the snapshot, and deletes everything it made.

## Incident investigation

Use the [shared incident debugging runbook](incident-debugging.md), including its
Boxd-specific access and lifecycle notes. The memory/recovery checks are shared;
Boat API endpoints and snapshot-file procedures are not interchangeable with Boxd.

Preview auto-publication requires `isWebServer: true` from the runtime. Discovery excludes the runtime process’s own Linux sockets and probes HTTP with bounded HEAD requests, so SSH and other non-HTTP services are not published. Older runtimes without this verification field do not auto-publish; update the cloud runtime to enable discovery.

The Ports and previews menu independently enables public URL auto-creation and local forwarding. Both default off and are remembered per workspace across renderer restarts. Users can explicitly add a port (for example 3001) even when older runtimes cannot verify it; unverified ports are never auto-selected. Turning local forwarding off releases only preview-owned tunnels, including pending opens; tunnels borrowed by another feature remain open. Turning URL auto-creation off revokes issued provider routes and verifies their removal. Publication and cleanup are serialized so an in-flight response cannot escape revocation. The last discovery consumer also triggers cleanup. A durable journal is written before publication and reconciled after renderer restart. Failed revocation remains visibly pending and retries; it must not be presented as a successful switch-off. Cleanup includes legacy `p<port>` routes and pinned default preview routes, but preserves the runtime route. Named routes managed outside Zuse are not adopted for new previews. Provider failures or abrupt app termination can delay deletion; URLs are not time-limited leases, and pending removal means previously shared links may still be public.

Preview bridges use `--preview`: they refuse to bind before the loopback app starts and exit when that app stops (checked every 500 ms with a bounded probe). This releases the VM interface port for the next wildcard-bound dev server. The runtime bridge on 47837 remains persistent so bootstrap and reconnect behavior are unchanged. Existing bridges created by older API builds must be removed after verifying their process identity; deploying the adapter change governs future bridges.

Deploy the API revocation handler before releasing the renderer/native changes.
An older API or a provider that refuses deletion must produce pending cleanup,
not a successful off state. Default-route deletion support is provider-dependent;
the adapter verifies that the hostname is absent after deletion and never falls
back to auto-detection or a different port to simulate revocation.
