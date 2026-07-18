# Live-process fork spike harness

Harness for the go/no-go spike (`zuse` issue #338): prove that a running Zuse
machine — open `node:sqlite` handles, file watchers, headless Chromium over
CDP, Electron under Xvfb, and a tunnel — survives a memory snapshot/fork on
the shortlisted providers (Morph Cloud and E2B), and that video evidence can
be recorded and shipped off the box.

The provider comparison and the full spike protocol live in
[`../microvm-provider-landscape.md`](../microvm-provider-landscape.md). This
harness implements the ticket's four legs plus the 10-descendant functional
pass. The 100-machine saturation run, four-hour pause/billing audit, and
failure-injection matrix are follow-on phases of the same protocol; run them
with this same workload once the functional pass holds.

## Layout

- `invm/` — provider-agnostic scripts that run **inside** the Ubuntu/Debian
  machine. They are the workload, the state capture, the post-fork
  verification, and the evidence recording.
- `morph-runbook.md`, `e2b-runbook.md` — per-provider driver runbooks: exact
  lifecycle steps with SDK snippets. Snippets are written from public SDK
  docs and are **unverified until run**; treat API names as hypotheses to
  confirm against the installed SDK.
- `result-sheet-template.md` — one copy per provider; the provider decision
  requires a completed sheet for both.

## Prerequisites (human)

1. A Morph Cloud account and API key, exported as `MORPH_API_KEY`.
2. An E2B account and API key, exported as `E2B_API_KEY`. The functional pass
   fits a low tier; the 100-sandbox saturation phase needs Pro ($150/mo
   listed) — defer that spend until the functional pass holds.
3. Morph's terms include a public-benchmark restriction — before publishing
   measured latency numbers outside the repo, confirm whether written
   permission is needed. Recording them in the private result sheet is the
   spike's need.

## Run order (per provider)

1. Boot the closest 2 vCPU / 4 GiB / 20 GiB Ubuntu machine (see runbook).
2. Copy `invm/` to the machine and run `invm/setup-workload.sh`.
3. Run `invm/capture-state.sh` → `/opt/spike/state-before.json`.
4. Snapshot the running machine; launch 10 descendants (see runbook).
5. On each descendant run `invm/verify-fork.sh <descendant-id>`; collect the
   JSON verdicts.
6. On one descendant run `invm/record-evidence.sh` and ship
   `/opt/spike/evidence.mp4` off the box via the provider's file API.
7. Fill in the result sheet; measure fork-to-command / fork-to-healthy /
   fork-to-CDP latencies from the driver-side timestamps.

## Gates (from the protocol)

All four legs work; no SQLite corruption; descendant state diverges
independently; fork-to-command p95 ≤ 5 s; fork-to-healthy p95 ≤ 15 s; source
interruption p95 ≤ 5 s. A failed leg is not an automatic kill — record the
fallback (volume snapshot + cold boot; browser-only without Electron) and its
UX cost on the ticket.
