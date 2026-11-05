# Slow-network performance

## Transcript transfer changes

Desktop and mobile request a recent-first timeline rather than automatically
hydrating every older page. Opening a chat retains permission to load history,
but does not request it. Scrolling near the beginning, pressing Load older,
restoring a saved reading position, or searching older prose requests the next
page. Explicit demand waits for the synchronization barrier; local live-tail
updates do not invalidate an otherwise correctly scoped durable history page.
The shared scheduler bounds concurrent history reads and cancels them after the
last reader releases the chat.

Ordinary history pages target 256 KiB of UTF-8 JSON, including message metadata.
The database selects the window using byte lengths before loading bodies into
JavaScript. One oversized message is allowed so the cursor always advances
without dropping content. The initial snapshot retains its existing 900 KiB
ceiling. This is a transfer target, not a strict upper bound on every frame.

New clients explicitly opt into deferred tool details. String results above
4 KiB from shell, file-read, grep, and glob tools carry a short preview and a
revision marker. Structured outputs, tool inputs, approval/plan content,
delegation, and generated media stay intact. In particular, full edit inputs
remain available to file summaries. Durable messages and provider context are
never shortened. Existing clients receive full bodies.

Expanding a desktop tool or opening mobile tool details retrieves the complete
result. Live detail reads use additive fields on the existing session-scoped
messages-page RPC. The server reads the body once into a short-lived download
buffer, returning at most 128 KiB of raw UTF-8 content per response, base64
encoded. Buffers are limited to 64 MiB in aggregate per database client and
32 entries, with lazy eviction after 60 seconds of inactivity. Missing or evicted
continuations restart once from the beginning, then fail closed; reopening also
restarts the download. Clients validate
scope, offsets, progress, size, metadata, and the deferred revision, then decode
UTF-8 after reassembly. The 64 MiB detail limit rejects larger bodies. Account,
bus generation, epoch, and revision changes reject late responses; collapse or
navigation cancels pending requests. Loaded details stay in the open view and
are reused on reopening, separate from the canonical timeline and its cursor.
Older runtimes can still return a complete single-message response.

Paused Cloud detail reads use the existing authenticated encrypted checkpoint
and older-page APIs. They do not acquire a runtime connection or wake compute.
Checkpoint storage remains full-body for compatibility. An uncached paused
read can therefore download a checkpoint and traverse older pages; it does not
have the live detail chunking or transfer reduction described above.

### Observed checks

The same synthetic four-message SQLite snapshot encoded to **421,023 bytes**
without the opt-in and **121,827 bytes** with it (UTF-8 JSON, uncompressed).
Both retained all four messages, including a 120 KB edit input and its file path;
full detail reads returned the original 300 KB Unicode tool result. This is about
71% fewer bytes for that fixture, not an application startup timing or general
traffic reduction. Reproduce with:

```sh
cd packages/domain
ZUSE_TRANSFER_REPORT=1 bunx vitest run test/integration/queries/sql-session-queries.test.ts --disableConsoleIntercept --reporter=verbose
```

The browser regression exercises the actual desktop disclosure with HTTP
throttled through Chrome DevTools to 400 kbit/s download, 100 kbit/s upload, and
400 ms added latency. It verifies no collapsed fetch, cancellation of a stalled
body on collapse, successful expanded loading, and no repeat download on
reopening. It is a component fixture, not an authenticated full-app startup or
WebSocket throughput benchmark. Run with an available Chrome executable:

```sh
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node apps/renderer/test/integration/deferred-tool-details.browser.mjs
```

Regression coverage also includes byte-window cursor progression, Unicode chunk
reassembly, malformed chunks, cancellation, account/generation/epoch fencing,
encrypted paused detail reads, and one database body read per download. The
server RPC test verifies same-session access and unchanged legacy full reads.

## Client processing evidence

The shared desktop/mobile background-history scheduler previously scheduled a
16 ms timer while a request was in flight whenever an unused concurrency slot
remained. It also polled every 16 ms during retry backoff. A fake-clock regression
observed 31 redundant timer callbacks in a 499 ms backoff window. The scheduler
now sleeps until the next eligible retry or request completion; a newly queued
job brings a later retry timer forward. Releasing the last queued job clears its
timer. Request concurrency, priority, retry count, cancellation, and transcript
publication are unchanged.

This scheduler change reduces unnecessary client work during slow or failed
requests. It does not itself reduce transcript bytes or prove improved
application startup, battery use, or end-to-end latency. The regression uses a simulated clock and stalled/rejected
promises, not a measured cellular network.

The Cloud gateway wrapper also reparsed each event in its native listener and
in every wrapped RPC listener. With two RPC listeners, a valid availability event
was parsed four times, and a normal RPC event three times. Classification now
uses one weakly held result per event; RPC frames retain their original bytes and
event identity. Ordinary RPC objects skip availability-schema validation, avoiding
an exception as part of normal streaming. Malformed control lookalikes and binary
frames retain their existing pass-through behavior. This is reduced decoding
work, not a measured network-throughput improvement.

Run the shared regression suite with:

```sh
bun run --cwd packages/client-runtime test:unit
```

## Validation record

Local validation for this change:

- Desktop unit suite: 2,241 passed; mobile unit suite: 548 passed.
- Shared client-runtime suite: 534 passed; domain suite: 199 passed;
  contracts suite: 198 passed.
- Focused server detail/handler suites: 5 passed, including actual SQLite-backed
  RPC reads, legacy responses, and session isolation.
- Applicable package type checks, architecture boundaries, localization, Biome,
  and production renderer bundle budgets passed. Biome retains three existing
  informational suggestions in the tool renderer.
- The complete server unit run was **not green**: 1,044 passed, 28 failed,
  3 skipped. Failures were in unchanged Cloud shell/runtime harness tests on
  macOS, including missing `flock`/`mapfile`, GNU `date` formatting, `/dev/shm`,
  runtime-updater subprocess failures, and a toolchain reconciliation timeout.
  The affected detail tests passed separately. These failures are not proof of
  successful Linux CI and must remain visible in release validation.
- Throttled desktop disclosure browser fixture passed. Authenticated full-app
  startup, WebSocket throughput, native mobile device behavior, packaged desktop
  behavior, and deployment were not measured or performed.

## Remaining investigation

Use the same build, account, selected workspace, chat fixtures, and device for
before/after runs. Separate local desktop, Cloud workspace, and mobile results.
Desktop application assets are bundled locally: network asset-transfer results
from a hosted browser must not be reported as desktop startup results.

The following are synthetic test profiles, not definitions of cellular service:

| Profile | Download | Upload | Added latency | Interruption |
| --- | --- | --- | --- | --- |
| Constrained | 400 kbit/s | 100 kbit/s | 400 ms | None |
| Very constrained | 150 kbit/s | 50 kbit/s | 800 ms | None |
| Reconnect | 400 kbit/s | 100 kbit/s | 400 ms | 10 seconds offline |

Record the throttle mechanism and whether it affects HTTP, WebSockets, or both.
Measure a normal-network control and cold/warm cache cases. Record distributions
and raw traces, not only one successful trial.

1. **Startup and chat selection:** measure existing `renderer.startup.*` and
   `zuse.cloud.fetch.*` stages through usable shell and first transcript paint.
   Separate cached paint from live synchronization and older-history completion.
2. **Traffic competition:** record bytes and concurrent requests by foreground
   transcript, older history, catalog polling, attachments, and file sync. The
   history scheduler bounds history requests only; it does not reserve bandwidth
   against these other traffic classes. Establish contention before changing
   scheduling or disabling prefetch.
3. **Streaming interaction:** measure input latency, long tasks, render work, and
   time from received event to visible text in short and long chats. Keep provider
   time to first event separate from client rendering and transport latency.
4. **Recovery:** interrupt download and streaming, switch chats during an old
   download, and reconnect repeatedly. Verify cached content remains readable,
   cancelled work stops, and message submission produces one durable command
   without duplicate sends. Account changes must invalidate previous-account data.
5. **Background load:** compare foreground and hidden-window CPU, request counts,
   and transferred bytes with no active turns. Profile the main process separately
   from the renderer before changing Git, sync, or database work.

Keep existing recent-first loading, cache/account fencing, and mutation replay
rules intact. See [cloud chat fetching](../cloud/chat-fetching.md),
[battery investigation](battery-investigation.md), and
[connectivity research](../research/mac-client-connectivity.md).

## Release gate

The fixture and regression tests establish the bounded behaviors above. Full application
3G qualification, packaged desktop/device profiling, authenticated chat timing,
and deployment verification remain open. Set user-facing latency budgets after
collecting those baselines; passing bundle-size checks alone is insufficient.
