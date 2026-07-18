# Morph Cloud spike runbook

Requires `MORPH_API_KEY`. SDK: [`morphcloud` TypeScript SDK](https://github.com/morph-labs/morph-typescript-sdk)
(pre-1.0 — every method name below is from public docs and must be confirmed
against the installed version before trusting a failure).

## Lifecycle

1. **Boot** a 2 vCPU / 4 GiB / 20 GiB Ubuntu instance from a provider base
   image (`client.instances.start({ snapshotId: <ubuntu-base>, ... })` after
   listing base snapshots/images). Record boot-to-SSH time.
2. **Load the workload:** copy `invm/` up (SDK file transfer or `scp` via the
   instance's SSH surface) and run `setup-workload.sh`, then
   `capture-state.sh`. Confirm the tunnel URL from
   `/opt/spike/logs/cloudflared.log` resolves from your laptop.
3. **Snapshot + fork:** timestamp, then `instance.branch(10)` (the SDK's
   one-to-many branch from a running instance) — or
   `instance.snapshot()` followed by ten `instances.start({ snapshotId })`
   calls if branch counts are capped. Record per-descendant: time to API
   return (fork-to-command), time until `curl /health` answers
   (fork-to-healthy), time until CDP answers (fork-to-CDP).
4. **Verify:** on each descendant run `invm/verify-fork.sh morph-<n>` and
   pull the JSON verdicts.
5. **Evidence:** on one descendant run `invm/record-evidence.sh`, then ship
   `/opt/spike/evidence.mp4` off the box; note transfer path, time, and
   integrity.
6. **Source interruption:** measure how long the source instance was paused
   or degraded around the snapshot (ping the source's `/health` at 250 ms
   intervals across the snapshot call).
7. **Cleanup:** list all instances and snapshots via the API, delete
   everything, and confirm by listing again — deletion convergence is a
   protocol gate. Note lineage metadata quality while doing it.

## Morph-specific things to record

- Whether `branch` works on a *running* instance or requires pause.
- Whether the tunnel connector re-registers on all 10 descendants and where
  the pre-fork trycloudflare URL routes afterwards (fork-identity input for
  the blocked ticket "Decide: fork identity").
- Snapshot storage MCU burn for this image size.
- Rate limits or errors while creating 10 descendants concurrently.
- The public-benchmark clause: confirm before publishing numbers.
