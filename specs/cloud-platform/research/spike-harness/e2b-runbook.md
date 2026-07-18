# E2B spike runbook

Requires `E2B_API_KEY`. SDK: `e2b` (TypeScript) — snapshot/persistence docs:
<https://e2b.dev/docs/sandbox/snapshots>, <https://e2b.dev/docs/sandbox/persistence>.
Method names below are from public docs; confirm against the installed SDK.

## Template first

The default sandbox template will not have Xvfb/Electron deps. Build a custom
template (Debian-derived, single-stage Dockerfile — the converter rejects
multi-stage, `VOLUME`, and `EXPOSE`) that pre-installs the apt packages from
`invm/setup-workload.sh`, or start from E2B's desktop template and add Node.
Pre-installing in the template also keeps fork descendants light.

## Lifecycle

1. **Boot** a sandbox from the template with the largest allowed
   CPU/RAM/disk toward 2 vCPU / 4 GiB / 20 GiB; set a long timeout (the
   workload must be running at snapshot time).
2. **Load the workload:** `sbx.files.write` the `invm/` tree (or git clone),
   run `setup-workload.sh` then `capture-state.sh` via `sbx.commands.run`.
   Confirm the tunnel URL and the sandbox's own public host per port.
3. **Snapshot + fork:** timestamp, create a runtime snapshot of the running
   sandbox, then start 10 sandboxes from it. Docs say WebSocket/PTY/command
   streams drop during snapshot — record exactly what dropped and whether
   reconnect-by-identity works (this is the reconnect semantics the lifecycle
   decision assumed).
4. **Verify:** run `invm/verify-fork.sh e2b-<n>` on each descendant; collect
   verdicts. Record fork-to-command / fork-to-healthy / fork-to-CDP per
   descendant.
5. **Evidence:** `invm/record-evidence.sh` on one descendant; ship
   `evidence.mp4` via the documented file download API.
6. **Source interruption:** poll the source sandbox's `/health` at 250 ms
   across the snapshot; compare against the documented ~4 s/GiB pause rate.
7. **Cleanup:** list and kill all sandboxes and delete snapshots; confirm
   convergence by listing again.

## E2B-specific things to record

- Whether local chrome-headless-shell + CDP works (their desktop example
  proves Firefox, not Chromium/CDP — this is an explicit empirical gate).
- Disk headroom: Electron + Chromium + Node inside the listed allowance.
- Whether paused/snapshot state is billed and how snapshot retention behaves.
- Per-port public host behavior across a fork: do descendants get distinct
  hosts immediately (fork-identity input for the blocked ticket "Decide:
  fork identity")?
