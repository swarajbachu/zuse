# boxd sandbox provider

boxd (boxd.sh) is registered as the `boxd` sandbox provider beside Boat and
E2B. It is disabled by default (`BOXD_ADAPTER_ENABLED=false`) and shares the
workspace lifecycle, billing ledger, account-image build, and provider picker
with the other adapters. The adapter lives in
`packages/sandbox-providers/src/boxd.ts`; its api module is
`infra/api/src/sandbox-provider-modules/boxd.ts`.

## Deployment

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
   Cloud settings runs there. On boxd the authority is an ordinary isolated
   machine from the base template; account images are never seeded from its
   snapshot, so credentials reach workspaces through the brokers.
4. Rebuild account images for boxd from Cloud settings; provider snapshots are
   never interchangeable.

The production deploy script refuses to deploy with the adapter enabled and
the snapshot, version, or `BOXD_API_KEY` secret missing.

## Behaviour that differs from Boat and E2B

- Pause hibernates the machine (memory written to disk) and resume wakes it
  in about 85 ms with the runtime and agent processes intact, so workspaces
  take the warm reconnect path like E2B. A machine woken by inbound traffic
  before the api asks is treated as resumed; a pause that does not park the
  machine (traffic woke it straight back, or it was still booting) is reported
  as retryable rather than recorded. A machine stopped from the boxd console
  boots cold on resume and reaches the runtime through the fenced restart
  after the warm reconnect window.
- The caller's timeout becomes an idle timer: hibernate after
  `keepAliveTimeoutSeconds` without network activity for workspaces, destroy
  after `createTimeoutSeconds` for build sandboxes. Activity includes packets
  on the runtime's own outbound gateway connection, so an agent working with
  the desktop closed is not hibernated mid-run, and the clock restarts on
  wake. The reconciler's own idle pause still runs first.
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
- Preview and SSH endpoints are named proxies (`p<port>.<machine>.boxd.sh`).
  The runtime port's route is part of the template so DNS exists before the
  first connection; a new preview port resolves immediately under the
  machine's wildcard. Traffic to a proxy reaches the VM interface, so the
  adapter runs the shared loopback forwarder on every endpoint resolution.
- There is no usage endpoint or lifecycle webhook. Billing uses the price
  schedule for the `boxd` provider, as for E2B; add price windows before
  enabling billing enforcement for boxd placements.
- The 50 concurrent machine cap per organization counts hibernated machines
  and forks. Deleted workspaces free their slot; snapshots do not count.

## Verification

- Unit: `bun --filter @zuse/sandbox-providers test:unit` (fake SDK client) and
  `bun --filter @zuse/api test:unit`.
- Live: `BOXD_API_KEY=... BOXD_ORG=<org> BOXD_TEMPLATE_SNAPSHOT=zuse-base-v<N>
  bun --filter @zuse/sandbox-providers test:live` creates a machine from the
  template, runs the installed CLI as `zuse`, serves HTTP and a WebSocket echo
  through a named proxy, round-trips a file, hibernates and wakes with the
  tagged process intact, replaces it through the fenced restart path,
  snapshots, forks from the snapshot, and deletes everything it made.
