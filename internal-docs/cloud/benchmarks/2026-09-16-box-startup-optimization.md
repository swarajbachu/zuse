# Box startup optimization — 2026-09-16

## Changes

- `005a1aa7f`: Run request-triggered workspace reconciliation in a per-workspace
  Durable Object alarm. The alarm awaits the existing reconciler; Postgres remains
  the lifecycle/lease authority. This applies to public API, desktop mailbox, and
  Slack response effects. Requests persist an alarm rather than depending on a
  long HTTP `waitUntil`. No chat payload or credential is stored in this object.
- `ab089b0be`: Overlap network preparation with signing-key installation and
  repository-marker preparation. Every operation must succeed before runtime
  launch. Start the runtime connection deadline after preparation; retain the
  original running timestamp for billing.

The startup object has its own alarm because mailbox alarms own command lease
expiry and retention, not provider execution. Requests arriving during an alarm
are preserved for a subsequent pass. Failed alarms retain pending work for
Cloudflare retries. The existing scheduled reconciler remains the recovery sweep.
This does not make every provider operation transactional or change the existing
Postgres lease duration.

Both staging and production configuration declare the new `WorkspaceStartup`
binding/migration. Only staging is deployed for this experiment.

Cloudflare documents [at-least-once alarm execution and automatic retries](https://developers.cloudflare.com/durable-objects/api/alarms/).
The previous [fully archived control](2026-09-16-box-staging-timestamps.md)
stalled during HTTP background execution. A fresh staging workspace creation
under the durable alarm completed a 97.651-second invocation with outcome `ok`.
That is a durability check, not a resume latency sample.

## Method and failed control

All tests used a small Box and signed runtime
`dc7d4d93bc5d86f0b5a03a075bfe3b0cbf605618` (app 0.21.0, wire 5).
Each cycle waited for API pause and an independent Box GET reporting `archived`
before submitting a public API message. The metric is API message creation to
recorded delivery acknowledgement: session acceptance, not a completed model
answer. The selected agent/model was Codex / `gpt-5.4`.

The attempted serial baseline used workspace `workspace_fIOGwd5OYjzu-z8b`,
Box `bx_7rz4t4eq`. It failed on its first fully archived resume. Provider resume
and layout restoration took 15.061 s; signing-key installation took 1.481 s;
network preparation failed after 21.051 s. A read-only check found the firewall
unit became active at 09:54:33 UTC, roughly nine seconds after the network wait
expired. No replacement runtime was launched. The controller was interrupted
and cleaned up after approximately three minutes without delivery.

Consequently this is **not a matched successful before/after speed comparison**.
The later successful series used a fresh workspace. Do not subtract the old
short-pause numbers or server-health-only benchmarks from these cold-resume
results.

Serial staging Worker: `4246bb31-2b46-462a-a313-cca434be58d7`, source `005a1aa7f`.


Additional changes:

- `d2fc06441`: Allow 60 seconds for the naturally restored firewall unit, checking
  locally every 250 ms inside a provider command with a 70-second timeout. Keep
  the firewall barrier; do not manually start it to bypass disk restoration.
- `c0cdd3726`: Route only providers that do not preserve processes through the
  durable alarm. E2B retains immediate request-owned startup observation.

## Completed cold Box series

Staging source `d2fc06441`, Worker `abe5d7cf-86ab-4c48-92d7-17f94dfd776c`.
Workspace `workspace_0qJIrp3-Fyp3fz2-`, Box `bx_n57g2azj`.
Three successful deliveries: **84.724, 30.957, 32.692 seconds**, median **32.692 s**.

Durations in seconds; nested provider phases must not be added to `provider.resume`.

| Operation | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| Provider usable-state wait | 35.239 | 4.568 | 4.574 |
| Filesystem layout restoration | 14.836 | 6.562 | 8.804 |
| Persisted firewall restoration | 2.743 | 2.627 | 1.648 |
| Entire provider resume | 53.359 | 14.280 | 15.576 |
| Signing-key installation, overlapping network | 2.867 | 0.741 | 1.015 |
| Network preparation | 8.619 | 7.439 | 6.285 |
| Runtime replacement | 1.990 | 0.369 | 0.394 |

Cumulative seconds from API message creation; API/VM clocks may have small skew.

| Boundary | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| Runtime shell starts | 65.998 | 24.051 | 24.258 |
| Runtime exec | 66.832 | 24.336 | 24.545 |
| Bootstrap response | 74.415 | 25.413 | 25.667 |
| Credentials ready | 77.838 | 28.769 | 29.720 |
| Runtime receives message | 79.167 | 30.495 | 32.218 |
| Session accepts message | 83.621 | 30.864 | 32.588 |
| Delivery recorded | 84.724 | 30.957 | 32.692 |

The application now overlaps 0.7–2.9 seconds of signing-key preparation with
network readiness. This removes serialized work, but is not proof of that much
wall-clock saving: the firewall becoming ready can dominate either schedule.
These samples support a reliability improvement, not a measured net speedup.

The repeated runs still spend about 24 seconds before the runtime shell starts.
Credentials take another 3.4–4.1 seconds. Faster disk restoration, a smaller
snapshot, and reducing credential setup are the next measurable targets. Keeping
an instance running avoids a cold restore but changes billed runtime; no idle
policy or machine size was changed for this experiment.

## E2B guardrail

With all providers routed through alarms, E2B delivered in 23.476, 6.243, and
22.905 seconds. Two cycles reached the 12-second warm fallback and restarted.
This is why the final change preserves E2B's existing execution path. It does
not establish that alarms caused every fallback; runtime reconnects require
separate verification. Final deployed-source results are recorded below.

## Final source verification

Source `c0cdd3726`, staging Worker
`05115627-fb32-4cd1-bc65-695fd26e134e`. Runtime unchanged at the signed `dc7d4d93b`
build. All API/provider/utility source files on the deployment Mac were verified
by SHA-256 against the cloud checkout before deploying.

- Box workspace `workspace_fLuCBSbDPs630Nlw` / `bx_ebpnpvaf`: provider-confirmed
  archived resume delivered in **67.420 seconds**. Across the successful tests,
  the observed fully archived range is **30.957–84.724 seconds**. In this final
  sample provider resume took 11.000 s, signing-key installation overlapped for
  1.196 s, and network preparation took **45.799 s** before runtime replacement
  took 0.557 s. This makes the late boot/firewall readiness barrier a major
  remaining target, not just the provider usable-state wait.
- E2B workspace `workspace_Im0eWFxY2Gis85-8`: three pause/reopen deliveries in
  **9.164, 7.884, 8.838 seconds**. API timing logs show only the explicit runtime
  upgrade before testing; no warm fallback/replacement during these three cycles.
  The optional post-test runtime-log collector could not map the pooled E2B
  instance by workspace metadata and failed after all three delivery checks.
  Cleanup still completed; do not claim runtime-PID verification from that run.

These are delivery/acceptance measurements. The test model did not provide a
verified successful answer; they do not validate end-to-end model output.

Validation: **319 API unit tests**, **94 sandbox-provider unit tests**, API and
sandbox-provider type checks, and applicable Biome checks passed. Behavioral
coverage includes retained alarm work on failure, eviction recovery, concurrent
wake requests, provider-aware routing, and preventing launch on network failure.

All six disposable API workspaces were confirmed deleted. The three identified
Box benchmark instances returned provider HTTP 404 after cleanup. Temporary API
keys were revoked, local credential files removed, and the Worker tail stopped.
Production was not deployed and provider keys were not changed.

Raw sanitized measurements: [JSON](2026-09-16-box-startup-optimization.json).
