# Usage loading performance

Usage presentation and history loading had three avoidable delays:

- Limits used one all-provider response, so a provider taking the full 30-second
  timeout prevented fast providers from appearing. The renderer now publishes
  provider-specific reads as they settle, with loading tracked per provider.
- Usage reads were sent through the workspace action lane, which serializes
  commands. They now use the existing ClientBus connected-client query path,
  retain a connection lease, and reject results if the connection changes.
- History parsing reread unchanged Claude and Codex transcripts after the report
  cache expired. Both parsers now use one shared cache implementation keyed by
  file identity, size, modification time, change time, and parser context. Changed
  files are parsed again; cross-file deduplication remains outside the cache.
  Each parser cache retains at most 2,000 files and 100,000 parsed rows. Files
  changed during parsing and failed reads do not populate the cache.

Normal usage reports also prefer disk/bundled prices while the existing pricing
loader refreshes outdated prices in the background. Explicit report refreshes
continue awaiting the pricing loader. This removes up to five seconds of network
waiting from normal reports; prices for unknown models remain unknown until
matching prices are available.

## Verification

Regression tests cover fast results while a provider and workspace action are
pending, request ordering, account invalidation, partial failures, slow pricing,
unchanged scans, appended and replaced files, deletion, and changes during a
scan.

A synthetic scan benchmark in this cloud VM used 60 Claude transcript files,
6,000 usage rows, and approximately 61 MB of text:

| Scan | Time | Rows |
| --- | ---: | ---: |
| First scan | 355 ms | 6,000 |
| Unchanged scan | 9 ms | 6,000 |
| One file appended | 11 ms | 6,001 |

These are parser timings, not end-to-end provider response times. The cache is
in memory: a server restart requires a cold scan, and changed files are reparsed
in full. Live provider latency was not measured because authenticated desktop
accounts were unavailable in this workspace.
