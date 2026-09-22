# Staging message delivery measurements — 2026-09-16

The five-second E2B target is **not achieved**. Three short-pause E2B samples
acknowledged delivery in **11.852, 13.683, and 14.435 seconds** after API acceptance
(median **13.683 s**). All three restarted Zuse. Box could not complete initial
API provisioning, so this run provides no valid Box resume latency.

Runtime: `3496b53c538bce69d539c459afb0584b93a6c9cd`, read back from the actual E2B
runtime metadata. API: `a9628fe878931a538987462aead4f517ec1947d0`, staging Worker
version `ad39bd4f-57af-4288-8ad3-5516f72a6f7f`. These are staging-only changes.
The Mac sent a short prompt requesting a fixed reply without tools or file edits.
The existing account selected Codex. Initial startup and an explicit runtime
upgrade completed before the measured pause/send cycles.

| Boundary (seconds after API acceptance) | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| Restart shell begins | 4.673 | 5.943 | 5.860 |
| Runtime updater finishes | 5.052 | 6.181 | 6.072 |
| Runtime initialization begins | 6.215 | 7.276 | 7.035 |
| Bootstrap response received | 6.743 | 7.792 | 7.550 |
| Credentials ready | 9.763 | 11.577 | 12.388 |
| Message received by runtime | 11.054 | 12.805 | 13.620 |
| Session accepts message | 11.708 | 13.549 | 14.284 |
| API records delivery acknowledgement | 11.852 | 13.683 | 14.435 |

Mac send to API acknowledgement was 12.317, 14.298, and 15.011 seconds. Those
cross-host differences can include clock skew. API acceptance-to-ack uses the
same API clock domain; runtime-local operation durations use a monotonic clock.
The initial interval before the restart shell is aggregate orchestration/wake/
replacement time, not a measurement of provider VM resume alone.

The runtime updater check cost only 0.376/0.235/0.209 seconds. Credential preparation
after bootstrap cost 3.020/3.785/4.838 seconds. Local session acceptance cost
0.653/0.743/0.664 seconds. The largest opportunities remain avoiding replacement
of a healthy preserved E2B runtime and understanding credential preparation.

## Failures uncovered while measuring

- The request observer reconciles every 250 ms without respecting `nextActionAtMs`.
  The warm-resume branch now explicitly checks its reconnect deadline. Previously,
  moving the deadline after provider wake alone did not preserve that grace window.
- PostgreSQL could not infer the type of the standalone nullable parameter in the
  acknowledgement query's `IS NOT NULL` guard. A `::text` cast fixes the HTTP 500.
  The memory-store tests missed this; a new opt-in PostgreSQL integration test
  executes the actual store method, including absent/mismatched/matching turn IDs
  and an idempotent retry that preserves the original delivery time.
- Before those follow-up fixes, a long-pause E2B sample received its message at
  13.285 s, accepted it at 14.653 s, and completed the reply at 18.604 s after API
  acceptance. Both delivery-ack attempts failed. Settlement was still published,
  so treating the absent `deliveredAt` as absent message execution was incorrect.
- The first explicit pause did not complete within the 180-second test deadline;
  it was later observed paused. Subsequent measured pauses completed normally.
- The API-created Box workspace stayed queued through repeated reconciliation.
  Its account image was reported ready. A separate direct provider restore from
  that exact account snapshot succeeded, and the diagnostic Box was deleted.
  This does not isolate the API provisioning failure; rebuilding the image or
  claiming slow Box resume from this failed allocation would be unjustified.

## Comparison limits and next experiment

The earlier 19–23-second numbers were **production settlement observations** using
coarse polling. These are **staging delivery acknowledgements** with precise
stored timestamps. They are not a controlled before/after comparison, so no
percentage speedup is established. The initial failing staging sample also used a
longer pause than the three successful samples.

Capture the specific restart decision and preserved-runtime socket/auth state on
E2B before changing the grace duration. A 500 ms grace can still be too short for
network recovery, but increasing it blindly delays genuinely dead-runtime recovery.
Investigate Box's API allocation separately before attempting its resume benchmark.
Keep generation fencing, durable receipts, and network readiness checks intact.

See [raw runtime events and samples](2026-09-16-staging-resume.json) and the
[phase definitions](../resume-latency.md). Model first-token timing was not measured.

## Cleanup

E2B workspace deletion was confirmed, the temporary Zuse API key was revoked,
and log capture/local PostgreSQL were stopped. The Box API workspace accepted
`desiredState: deleted` but remained `delete-retrying` at verification; this
pending cleanup is an additional lifecycle failure, not a successful deletion.
No production deployment or provider-key replacement was performed.
