# Runtime telemetry

Zuse records operational telemetry locally so failures can be diagnosed without
sending user content to another service. Product analytics and runtime telemetry
are separate:

- Product analytics contains only the typed, allowlisted aggregate events in
  `packages/analytics`.
- Runtime telemetry contains operation timings, outcomes, trace identifiers,
  process ownership, and sanitized failure causes. It powers Settings →
  Diagnostics and support bundles.

## Local capture

The server installs one Effect tracer around the complete RPC runtime. RPC
operations and explicitly instrumented provider boundaries are recorded as
structured diagnostic events. Events are kept in memory for live queries and
written asynchronously to rotating NDJSON files under the app data directory.

The store retains at most 100,000 events, rotates at 20 MB, keeps five files,
and removes files older than seven days. Capture, serialization, rotation, and
cleanup failures are isolated from normal application behavior.

Diagnostic polling RPCs are excluded from local span capture so opening the
Diagnostics page cannot create a feedback loop.

## Data safety

Persisted span attributes use an explicit allowlist. Prompts, transcripts,
message content, files, terminal output, environment values, credentials, URL
query values, and raw command arguments are excluded. Failure causes and
allowed string attributes are scrubbed again before persistence and export.

Support bundles apply the existing second redaction pass.

## Optional OTLP export

Remote export is disabled unless an endpoint is explicitly configured:

```sh
ZUSE_OTLP_TRACES_URL=http://127.0.0.1:4318/v1/traces
ZUSE_OTLP_METRICS_URL=http://127.0.0.1:4318/v1/metrics
ZUSE_OTLP_SERVICE_NAME=zuse-server
ZUSE_OTLP_EXPORT_INTERVAL_MS=10000
```

Traces and metrics can be enabled independently. Export uses the same
allowlisted attributes as local capture and sends sanitized failure causes.
Exporter outages, retries, and shutdown flushing are handled by the Effect OTLP
exporter and do not block application work.

## Metrics

The runtime exposes low-cardinality counters and histograms:

- `zuse_operations_total`
- `zuse_operation_duration`
- `zuse_failures_total`

Labels are limited to operation, category, and outcome. IDs and user-derived
values are never metric labels.
