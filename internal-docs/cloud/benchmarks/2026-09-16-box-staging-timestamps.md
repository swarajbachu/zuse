# Box staging resume timestamps — 2026-09-16

Three short API-pause/reopen cycles delivered messages in **23.887, 25.188,
and 27.770 seconds** (median 25.188 s). A separate control, with Box explicitly
confirmed `archived` before sending, stalled after the request's background
execution ended during network setup. Do not use the short-pause samples as a
completed-archive restore estimate or discard the stalled control.

## Environment and method

- Staging API source: `dff60cfd7`; Worker version
  `0121a343-2c10-411c-a8dc-7a630c0e9fa0`.
- Signed runtime: `3496b53c538bce69d539c459afb0584b93a6c9cd`, verified from
  `/opt/zuse/current/runtime-metadata.json` after an explicit upgrade.
- Small Box, 2 vCPU/4 GiB, account image based on template version 5.
- One disposable workspace, `workspace_64i0gp6oEKkxLTLQ`, Box `bx_rqzh63gq`.
- Codex; prompt: “Reply exactly RESUME_OK. Do not use tools or change files.”
- Each short cycle waited for the API to report paused, then three seconds,
  then submitted a public API message. Provider archival was not independently
  confirmed for those three cycles. Each reply settled before the next pause.
- For the control, provider GET confirmed `archived` at 1789545725434 ms;
  the Mac began sending at 1789545743028 ms.

## Short-pause timeline

Seconds after API message creation. Delivery acknowledgement uses API timestamps;
runtime boundaries span API/VM clocks and may include clock skew. Poll observation
times are retained in the raw data but are not used as delivery timestamps.

| Boundary | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| Restart shell starts | 13.651 | 13.503 | 17.148 |
| Updater finishes | 14.298 | 14.137 | 17.743 |
| Bootstrap response received | 17.902 | 18.221 | 21.481 |
| Credentials ready | 20.620 | 21.181 | 24.209 |
| Runtime receives message | 21.958 | 22.578 | 25.641 |
| Session accepts message | 23.655 | 24.971 | 27.556 |
| API records delivery | 23.887 | 25.188 | 27.770 |

Provider/API operation durations below are not cumulative. Nested resume stages
must not be added to the enclosing provider resume duration.

| Operation | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| Provider resume, including layout/policy restoration | 4.221 | 3.922 | 6.164 |
| Resume HTTP request | 0.216 | 0.209 | 0.207 |
| Poll until provider reports usable | 0.187 | 0.180 | 0.190 |
| Restore filesystem layout | 2.229 | 1.556 | 3.122 |
| Restore persisted firewall policy | 1.401 | 1.798 | 2.457 |
| Write runtime files | 2.706 | 2.621 | 3.034 |
| Apply requested network policy | 2.105 | 2.661 | 3.383 |
| Replace tagged runtime process | 2.794 | 2.455 | 2.765 |
| Updater check | 0.620 | 0.623 | 0.589 |
| Runtime exec through bootstrap response | 3.602 | 4.080 | 3.734 |
| Credential preparation | 2.718 | 2.960 | 2.728 |

These runs do not isolate systemd overhead: replacement includes the provider
command round trip and stopping the previous process tree. No matched before/after
comparison was performed. The old 31–79 s server-health measurements used another
method and exclude account bootstrap and message delivery.

## Fully archived control and lifecycle failure

The control recorded:

- Resume request: 0.351 s.
- Wait for provider usable state: 4.550 s.
- Restored filesystem layout preparation: 17.740 s.
- Persisted firewall restoration: 0.502 s.
- Total provider resume/setup: 23.327 s.
- Runtime file write: 0.604 s.
- Network setup started at 1789545769296 ms; no matching end or runtime replacement
  event was recorded in that invocation.

The HTTP invocation began at 1789545743326 ms and lasted **31.567 s**, ending
roughly 30 seconds after returning the queued-message response. Worker outcome
was `ok`, without an exception. The control did not deliver within its 180-second deadline and subsequently
reported `failed` / `runtime-connection-timeout`. Initially the workspace remained
`provisioning` with
`resume-runtime-restarting`; no new runtime shell event appeared.

This is strong evidence of HTTP background-work cancellation, not proof of slow
systemd startup: the launcher was never reached. `applyResponseEffects` runs the
startup reconciler in `waitUntil`. Cloudflare documents a maximum of 30 seconds
after response completion for this work. See
[Workers execution limits](https://developers.cloudflare.com/workers/platform/limits/).
The reconciler saves the fresh generation/provisioning state before network setup
and launch; later provisioning reconciliation waits for callbacks/deadlines
rather than resuming that interrupted launch step.

The next reliability change should give lifecycle work durable ownership and
resumable checkpoints, using the existing coordination mechanisms, while keeping
generation fencing and firewall readiness intact. Merely speeding up systemd or
extending a reconnect grace period will not resolve this execution-lifetime limit.

## Provisioning blocker fixed before measuring

Box requests previously used `redirect: "error"`. The deployed Workers runtime
rejects that option synchronously, so every provider call failed before network
I/O. Miniflare reproduced the exact error; `manual` reached Box and returned the
expected 401 for a deliberately invalid diagnostic key. The adapter now uses
`manual` and rejects non-success responses without following redirects or sending
credentials to another origin. The queued benchmark provisioned after this fix;
its initial snapshot fork/setup took 56.257 s, excluded from resume samples.

Validation: 126 provider/reconciler tests and 3 shared timing tests passed;
provider, API, and utils type checks passed; applicable Biome checks passed.
Only staging was deployed. No provider keys or production settings were changed.

Cleanup: the measured workspace and the previously stuck Box benchmark workspace
both reached `deleted`. The temporary Zuse API key was revoked (HTTP 200), its
local credential file removed, and benchmark controllers/log capture stopped.

See [raw sanitized events](2026-09-16-box-staging-timestamps.json).
