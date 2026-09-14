# ADR 0035 — Box provider: in-guest quarantine as the fork network barrier

Date: 2026-08-17
Status: Accepted

## Context

ADR 0033 requires that a forked sandbox start with its network blocked **at
the host level** — provider-enforced, never a caller choice — so a clone
holding the parent's on-disk credentials cannot impersonate it before
re-key/enrollment. E2B satisfies this with `allow_internet_access: false` at
create time, verified live in
`research/quarantined-fork-verification.md`.

The Box provider (box.ascii.dev) exposes **no network policy API at all**:
no egress firewall, no create-time network flag. Taken literally, ADR 0033
would exclude Box. Two properties of Box change the risk calculus:

1. **Every Box restore is a disk-only fork with a cold process start.**
   Creates from named snapshots, forks, and resumes all boot fresh hardware
   from a filesystem image. No memory state, live connections, timers, or
   mid-stride processes survive — which is exactly the fallback ADR 0033
   itself names for providers without live-fork quarantine. The residual
   threat is inherited *disk* state: credentials in files, and any
   persistence (e.g. autostart hooks) that untrusted agent code wrote into
   the parent's filesystem.
2. **We fully control the restored guest and its handoff.** Box has no custom images, so the
   base template is built by us from a fresh VM (`infra/cloud-sandboxes/
   box-publish.sh`) and everything in it — including who can become root — is
   ours to define. Box restores template files after the guest has passed its
   normal systemd boot targets, so the adapter explicitly activates the
   firewall before it returns the sandbox or starts untrusted runtime code.

Cloud workspaces and warm pools request open egress under ADR 0034. The
quarantine capability below applies only when explicitly requested; Box applies
the requested open policy before returning workspace and pool allocations.

## Decision

For the `box` provider only, the quarantine barrier moves in-guest, with
three stacked controls replacing the host-level block:

1. **Default-deny egress before handoff, scoped by uid.**
   `zuse-firewall.service` is a root-owned systemd unit ordered before
   `network.target` for ordinary boots. Because Box snapshot restores happen
   after that target, the adapter also applies the requested policy through
   the root control channel after Box becomes usable and before handing the
   sandbox to callers. The ruleset drops all non-loopback egress for the
   `zuse` uid. Untrusted code only ever runs as `zuse`; root and the Box
   control-plane agent stay unrestricted, keeping the provider command
   channel (the only path that can lift the barrier) alive.
2. **Privilege separation.** The `zuse` user has no sudo (explicit deny-all
   sudoers entry, removed from admin groups). The root-only
   `/usr/local/sbin/zuse-firewall` script is the single policy writer; the
   API invokes it through the provider `/commands` API (reachable only
   with the API's Box API key) and always writes the complete final policy
   in one call, preserving the ADR 0033 single-call `setNetwork` contract.
   The requested policy is persisted in the guest so pause/resume restores
   the same policy; resume begins fail-closed and restores it before handoff.
3. **Fail-closed verification.** When the lifecycle requests a quarantined
   create or fork, the adapter verifies `zuse-firewall verify-quarantined`
   before returning and destroys the box when the barrier cannot be proven
   (throw-away-and-retry per ADR 0033 §3); every requested policy is applied
   once the box is usable and before it is exposed to untrusted work.
   The live suite (`test/live/box.live.test.ts`) keeps a standing canary:
   a fresh quarantined fork of an open-network parent must fail external
   fetches until `setNetwork(open)`.

Under ADR 0034, account-image warm pools and workspace creates, forks, and
resumes use open egress. Quarantine remains available to callers that explicitly
need an identity re-key boundary. The adapter enforces the requested policy
before returning the sandbox to the lifecycle.

`restricted` policies resolve allowOut hostnames to addresses at apply time;
re-apply refreshes them. DNS rotation between applies is a known caveat,
identical in kind to E2B's hostname-based allowlists.

## Accepted risk

In-guest enforcement is weaker than host-level enforcement: a kernel or
nftables escape, a root-escalation vulnerability inside the guest, or a
provider-side change that grants `zuse` privileges would defeat the barrier,
where E2B's host block would hold. We accept this for the `box` provider
because the cold-boot property removes the live-memory threat the ADR 0033
barrier chiefly guards, the remaining attacker (persisted non-root code)
faces a root-owned firewall activated before handoff, and every quarantined
fork is verified before enrollment secrets are issued.

Consequently:

- The `box` provider stays `productionReady: false` until the live
  verification record (`research/box-quarantined-fork-verification.md`) is
  complete on a published template.
- Ask ascii.dev whether host-level egress control is on their roadmap; if it
  ships, the adapter's `setNetwork` moves onto it and this ADR is superseded.

## Consequences

- ADR 0033's invariant is now provider-conditional: "network-blocked start,
  enforced below the reach of untrusted code" — at the host for providers
  that can, at the provider-gated root boundary for cold-boot providers that
  cannot. The adapter contract (explicitly quarantined forks, single-call
  `setNetwork`) is unchanged.
- The template build must never grant `zuse` sudo or install user-writable
  autostart paths that run outside the zuse uid; `box/install.sh` owns this
  guarantee.
- Hosted-port exposure (`host`) rides the provider's own tunnel. Whether
  inbound-originated traffic can carry zuse egress during quarantine must be
  answered in the verification record before production.
