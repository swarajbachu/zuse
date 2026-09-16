# E2B preserved-runtime restart investigation — 2026-09-16

The staging reproduction selected `warm-reconnect-not-observed`, not a mailbox
fence, explicit restart, or runtime upgrade. Provider wake took 486 ms. The
reconciler chose replacement just 642 ms after wake returned, following its
500 ms reconnect grace. The runtime generation changed from 2 to 3.

| Event | Epoch milliseconds |
| --- | ---: |
| Provider resume begins | 1789546727737 |
| Provider resume returns | 1789546728223 |
| Warm reconnect fallback chooses restart | 1789546728865 |
| Replacement shell starts, generation 3 | 1789546730768 |
| Replacement receives message | 1789546738029 |

The test used staging API `dff60cfd7` / Worker version
`0121a343-2c10-411c-a8dc-7a630c0e9fa0` and signed runtime
`3496b53c538bce69d539c459afb0584b93a6c9cd`. The workspace was
`workspace_a7iTWfI61LxielPF`, E2B sandbox `io8ydfwmkibm7tq883td9`.
An explicit restart first installed the instrumented runtime; that intentional
generation-2 restart is separate from the observed generation-3 fallback.

## Preserved-process controls

After the normal-path reproduction, two controls paused the same workspace via
the API and woke the provider directly, without submitting another message or
running the API startup reconciler. Both eventually logged `runtime.gateway-open`
on **generation 3**, with no new shell/startup/bootstrap events. Mailbox polling
continued from the preserved runtime. Therefore process preservation works, and
neither a mandatory runtime upgrade nor a fresh bootstrap is inherently required
for these short pauses.

The first control logged a new gateway open at 1789546830274 ms. Its provider wake
request took 0.591 s, but exact request boundary timestamps were not retained;
do not derive an exact reconnect latency for that control.

The second control retained exact boundaries:

- Provider wake request starts: 1789546871661 ms.
- Provider wake returns: 1789546872274 ms (613 ms request duration).
- Same-generation gateway opens: 1789546893507 ms.
- Wake return to gateway open: **21.233 s**.

These controls deliberately bypass API orchestration and leave the desired state
paused. They demonstrate process survival and gateway reconnection, **not** normal
end-to-end message delivery or successful readiness publication. Consequently,
mailbox `cloud_workspace_runtime_not_ready` errors in the controls are expected
and are not evidence of invalid credentials. The selected Codex turns settled
with an agent error; this investigation is not a successful model-response
latency benchmark.

## What the code explains

`wakePreservedWorkspaceRuntime` waits for provider resume, then sets a 500 ms grace.
The startup observer checks every 250 ms and restarts after that deadline unless
readiness has been published. The observed 642 ms fallback follows that code.

The runtime's `websocketClosed` opens a socket and waits for an error/close before
retrying. It has no active heartbeat or explicit wake notification. Its shared
retry schedule starts at 250 ms and caps the base delay at 16 seconds with jitter.
On gateway open it sends `repository-ready`; the reconnect callback ignores a
failed readiness request. Mailbox polling continues independently, but does not
itself publish the preserved runtime's readiness after waking.

The measured 21.233 seconds includes socket failure detection, retries, and
connection establishment. Existing logs do not isolate those components; do not
attribute the entire interval to retry backoff or a specific TCP timeout. The
controls do establish that waiting 500 ms is not sufficient for every healthy
preserved runtime to reconnect.

## Next change

Use a prompt, authenticated readiness/reconnect path for the existing generation
after provider wake, decoupled from passive recovery of the UI gateway socket.
Reuse the existing mailbox/readiness mechanisms and keep bounded dead-runtime
recovery, credential expiration checks, and generation fencing. Instrument close,
retry-start, handshake, and ready-request outcomes to distinguish transport delay
from rejected or lost readiness. Increasing grace alone could trade a restart for
a 20-second wait; it is not a complete latency fix.

This turn changes only diagnostic documentation, not runtime behavior or staging
configuration. See [sanitized evidence](2026-09-16-e2b-warm-diagnostic.json).

Cleanup verified the API workspace was deleted and E2B returned 404. The temporary
API key was revoked (200), its local file removed, and capture/controllers stopped.
Biome passed for the evidence JSON. Type and behavior suites were not rerun
because no executable code changed; the live controls above are the verification.
