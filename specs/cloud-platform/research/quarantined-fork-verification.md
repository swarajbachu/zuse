# Verification: network-quarantined fork start (map task zuse #372)

Date: 2026-07-22 · Follows ADR 0033 (fork identity), which requires a forked
machine to start with networking **blocked at the provider/host level** and
open only after re-key/enrollment completes. The fork spike (zuse #338)
measured speed, not quarantine; this task verifies the quarantine capability
on both shortlisted providers.

## Verdict

| Provider | Blocked-network fork start | Open on command | Meets ADR 0033 |
| --- | --- | --- | --- |
| E2B | ✅ verified live | ✅ verified live (~0.3 s) | **Yes** |
| Morph | ❌ no API surface exists | ❌ | **No** — fallback costed below |

## E2B — verified empirically

Method: live test against production E2B (SDK 2.35.0), scripted as
`quarantine-fork-test.mjs` + `quarantine-liveness-test.mjs` in this directory.
Create a `base` sandbox, start a stateful counter loop, take a **live**
snapshot (no pause), then `Sandbox.create(snapshotId, { allowInternetAccess:
false })`.

Observed (single run each; timings consistent with the #338 spike):

- **Quarantine is honored on the fork path.** The create-from-snapshot fork
  came up with egress fully dead: `curl https://1.1.1.1/` (raw IP, no DNS) and
  `curl https://example.com/` both fail (`000`) from inside, while the same
  probes return `301`/`200` on the source and on a control fork created
  without the flag. The block is provider-side (sandbox firewall), not
  in-guest.
- **Warm state survives inside the quarantine.** The inherited process resumed
  with identical PID and `/proc` start tick, and its counter kept advancing
  (15 → 22 over 2.5 s) while egress was blocked — so re-key/enrollment work
  can run against a fully warm machine, exactly the ADR's model.
- **Open on command:** `sandbox.updateNetwork({ allowInternetAccess: true })`
  returned in **262 ms** and egress worked on the next probe. Re-closing with
  `allowInternetAccess: false` also works on a running fork (usable as an
  incident lever).
- Timings: live snapshot 487 ms, quarantined fork create 507 ms — the flag
  adds no measurable cost over the spike's unquarantined forks.

Caveats to carry into the Phase 2 build:

- **Default is open.** Quarantine exists only if every fork create passes
  `allowInternetAccess: false`; make it non-optional in the provider driver,
  not a caller choice.
- `updateNetwork()` **replaces** the whole egress config (documented
  behavior) — the enrollment "open" step must write the fork's final intended
  policy in one call, never "clear then add".
- E2B's docs note blocked TCP connects can appear locally successful in some
  firewall modes; our probes hard-failed, but enrollment success must be
  judged by the relay seeing the clone, not by in-guest connectivity checks.
- Finer policy is available if wanted: `network: { denyOut/allowOut }` with
  CIDRs/domains supports a "relay-only" quarantine instead of all-closed
  (domain rules on 80/443 only; default nameserver 8.8.8.8 allowed when
  domain filtering is active — treat DNS as reachable in threat modeling).

## Morph — no host-level egress control exists

Checked the full public OpenAPI spec (`cloud.morph.so/api/openapi.json`,
fetched 2026-07-22) rather than docs alone: zero occurrences of
internet/egress/firewall/deny concepts. `StartInstanceRequest` accepts only
metadata + TTL; branch (`POST /instance/{id}/branch`) accepts only count,
digest, and metadata; `InstanceNetworking` models only exposed
`http_services` + `internal_ip` (ingress). There is no way to start a branch
with networking blocked, and no way to toggle networking on a running
instance. A branched clone wakes network-open, holding the parent's secrets
and live sockets.

### Fallback costing (required by the task)

1. **In-guest pre-block (rejected as the barrier).** Apply an nftables
   full-egress block on the parent just before `branch()`; clones wake
   blocked and lift the rules in-guest after re-key. Preserves warm state and
   fork speed, but the barrier is in-guest: root inside the machine — which
   is the agent itself — can lift it. Fails ADR 0033's provider-enforced
   requirement. Worth keeping as defense-in-depth only.
2. **Disk-only fork with cold process start (the ADR's named fallback).**
   Morph has no disk-only snapshot: snapshots are full memory+process images.
   Approximating it means quiescing the parent before snapshot (stop agent
   processes, shred secrets, then snapshot) or rebooting each clone
   immediately after branch. The quiesce path costs parent downtime per fork
   and reduces fork to roughly a cold template start; the reboot path leaves
   a seconds-long network-open impersonation window before the reboot lands.
   Either way, warm-state resume — the property that made forking valuable
   (sub-second fork-to-healthy) — is lost, and the reboot variant still
   violates the quarantine requirement during its window.

**Consequence:** Morph stays on the scale card as a ~40%-cheaper alternate
*conditional on them shipping host-level egress control* (worth a feature
request — pause/resume and branch already exist, so a network toggle is a
plausible ask). It is not eligible as a fork provider under ADR 0033 today.
No Morph timings were measured in this task (their terms restrict publishing
benchmarks; capability absence is an API fact, not a measurement).

## Residual follow-ups

- Re-run the quarantine probe as a standing gate in the Phase 2 provider
  driver's integration tests (the capability is a moving target on both
  sides).
- If "relay-only quarantine" is chosen over all-closed, model the allowed
  8.8.8.8 DNS path explicitly in the enrollment threat model.
