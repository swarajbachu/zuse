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

The server installs one Effect tracer around the complete RPC runtime. Every
operation updates a bounded five-minute aggregate with counts and duration
histograms. Individual events are retained only for warnings, failures, genuine
interruptions, and operations lasting at least one second.

Incident capture retains at most 5,000 events. A user can temporarily enable a
separate full trace for 5, 15, or 30 minutes; it retains at most 20,000 events
and 10 MB, overwrites the previous debug capture, and automatically returns to
incident capture. Seven days of five-minute operation rollups preserve counts,
p95 timings, and maximum timings without retaining routine successful spans.

Desktop and Serve processes write independent files whose names contain a
hashed runtime identity. Startup uses bounded tail reads, while legacy shared
logs are streamed through an incident-first migration in the background.
Capture, serialization, migration, rotation, and cleanup failures are isolated
from normal application behavior.

Diagnostic polling RPCs are excluded from local span capture so opening the
Diagnostics page cannot create a feedback loop.

## Data safety

Persisted span attributes use an explicit allowlist. Prompts, transcripts,
message content, files, terminal output, environment values, credentials, URL
query values, and raw command arguments are excluded. Failure causes and
allowed string attributes are scrubbed again before persistence and export.

Support bundles apply the existing second redaction pass, merge runtime files,
retain at most the newest 25,000 relevant events, report truncation, and stream
artifacts into the ZIP.

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
