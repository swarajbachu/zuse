# ADR 0033 — Fork identity: fresh identity, quarantine-first re-key, plain log divergence

Date: 2026-07-22
Status: Accepted

## Context

The fork spike (zuse #338) proved live-process snapshot/fork of a running cloud
machine works on both shortlisted providers — and that a fork is a bit-for-bit
copy. The clone wakes up holding everything the parent held: the per-environment
Ed25519 private key (private key never leaves the machine; relay holds only the
public key — Relay-PR2, migration 0025), the persistent `zenv_` credential
(stored hashed at the relay), the managed-tunnel connector credentials on disk,
and the full append-only SQLite event log (global monotonic `sequence`, clients
resume via a per-environment `sinceSequence` cursor).

Until we intervene, a clone can impersonate its parent. The lifecycle decision
(zuse #339) already established that each Environment Attempt gets a fresh
environment identity, tunnel registration, and short-lived credentials, and
that the hosted `CloudMachineService` is the sole lifecycle authority. This ADR
decides *how* that fresh identity is issued and how the copied event log
diverges.

## Decision

### 1. Identity is never inherited; lineage is metadata

Every fork gets a brand-new environment ID at provision time, whether it serves
the same Cloud Run (recovery / replace-attempt) or starts a new one (task from
template, branch of an in-flight run). One issuance path for all cases. The
source snapshot ID, parent attempt ID, and parent run ID are recorded on the
new attempt as lineage metadata only — never as shared identity.

### 2. Quarantine-first re-key, machine-side keygen

A clone of a *running* machine does not boot — its processes resume mid-stride
with the parent's secrets in memory and possibly live connections. In-guest
cleanup alone is therefore not a security barrier. The barrier is external:

1. **Network-blocked start.** The provider starts the clone with its network
   blocked at the host level. The clone physically cannot reach the relay,
   tunnel, or anything else as the parent. (Provider capability requirement —
   see Verification below.)
2. **Inside the quarantine:** shred the inherited private key, `zenv_`
   credential, and tunnel connector credentials (hygiene, not the barrier);
   restart the Zuse server process fresh rather than letting the copied one
   continue mid-flight (kills inherited timers, half-finished sends, and open
   sessions); generate a fresh Ed25519 keypair on the machine.
3. **Enrollment.** `CloudMachineService` mints the new environment ID and a
   short-lived, single-use enrollment token bound to that ID *and to this
   specific fork operation*, delivered via the provider exec/env channel —
   never baked into the snapshot, never reusable across forks. The clone
   presents token + new public key to the relay's existing link endpoint as a
   new grant path (alternative link proof). Private keys still never travel.
4. **Open the network** only after enrollment completes, onto the clone's new
   tunnel and credentials only.

The rejected alternative — the hosted service generating the keypair and
pushing the private key in — is simpler to orchestrate but breaks the
asymmetric-trust property (relay can never impersonate a machine).

### 3. Fail closed; parent untouched

A clone performs no agent work, no tunnel traffic, and no relay traffic until
enrollment completes. Any failure (wipe, keygen, expired token, quarantine
window exceeded) destroys the machine and re-forks from the snapshot — forks
are ~1 s, so throw-away-and-retry beats any repair path. A fork never affects
the parent's identity: parent credentials revoke only when the parent attempt
is destroyed (per the lifecycle decision's idempotent destroy).

### 4. Fresh tunnel per fork; preview URLs never migrate

After enrollment, `CloudMachineService` provisions a brand-new tunnel — new
address, new preview URLs. The parent's URLs keep pointing at the parent; the
clone's URLs only ever point at the clone. Even for same-run recovery, a
preview link never silently switches machines — the run's UI surfaces the
replacement attempt's new links. Links die honestly rather than migrate.

### 5. Event log: keep history, fork marker, plain continuation

- **Inherited history is kept.** Branching exists so the clone's threads stay
  readable from the beginning; the diary is not blanked.
- **The first new entry is a fork-marker event** recording the parent
  environment ID and the sequence at the fork point. Provenance lives in the
  log itself. The marker is written during the quarantine window, after the
  server restart and before any other writer runs, so no resumed process can
  append ahead of it (WAL recovery completes first).
- **Numbering continues plainly; safety comes from identity.** No renumbering
  or offset scheme. Parent and clone will both write a (different) entry
  N+1 — that is fine because `sinceSequence` cursors are scoped to one
  environment ID, and the clone's ID is new, so a device connecting to it
  starts a fresh cursor and replays from the top. Each event's `event_id` is
  already globally unique, so copied history keeps its original event IDs;
  origin is derivable from the fork marker rather than rewritten per event.

### Derived and in-flight state

Only processes proven secret-free may survive the live snapshot (per the
lifecycle decision); the Zuse server restart within quarantine is the
mechanism that invalidates copied in-flight state (pending outbound work,
leases, idempotency timers). Anything that must not fire twice is re-driven by
the hosted service's versioned commands, which already deduplicate and fence
stale actors.

## Verification required before Phase 2 build

The spike measured fork speed, not quarantine: **confirm both shortlisted
providers can start a forked machine with networking blocked at the host level
and open it on command.** If a provider cannot, the fallback is discarding
inherited memory (disk-only fork with cold process start), which sacrifices
warm-state resume and must be costed before acceptance. Tracked as a map task
on wayfinder map #336.

## Consequences

- One identity-issuance path covers recovery forks and branch forks; no
  special-cased "keep the parent's ID" branch exists to get wrong.
- Credential shredding is demoted to hygiene; the security control is the
  provider-enforced network quarantine plus single-use, fork-bound enrollment.
- Preview-link continuity across recovery is deliberately sacrificed for
  trust: a URL is pinned to one machine for its lifetime.
- Client sync code needs no fork awareness: new environment ID ⇒ new cursor,
  full replay, no gap/dupe cases across the divergence point.
- Relay gains one new grant path (enrollment-token link proof) instead of a
  parallel identity scheme.
