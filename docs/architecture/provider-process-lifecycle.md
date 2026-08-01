# Provider process lifecycle

Provider integrations have two distinct runtime planes. Keeping them separate
prevents dashboard reads from competing with interactive sessions or mutating a
provider's shared state concurrently.

## Management plane

Availability, account, usage, model, skill, connector, and external-thread
reads belong to the management plane.

- Cache and single-flight equivalent reads at the owning server module.
- When a provider exposes a multiplexable control protocol, lease a shared
  client from `@zuse/agents/kernel/shared-resource-pool`.
- Key resources by every setting that changes process identity, including the
  binary and provider home.
- Batch provider-native multi-project reads when the protocol supports them.
- Release the final lease promptly and close the resource after a short idle
  window.
- Provider-managed filesystem updates must not recursively invalidate the read
  that caused them.

The generic pool owns creation coalescing, leases, retry after failed startup,
idle teardown, and disposal. A provider adapter owns launch arguments,
protocol requests, error classification, and diagnostic filtering.

## Session plane

Interactive chat sessions remain isolated unless the provider explicitly
guarantees session-safe multiplexing with independent configuration and event
routing. Session processes own notifications, approvals, tools, credentials,
and teardown for one conversation.

Management clients must never carry session-scoped MCP configuration or event
handlers. Session clients must not be reused for background probes.

## Mutations

Login, OAuth, configuration writes, installs, and enable/disable operations are
not shared reads. They use an isolated scoped client unless a provider offers a
transactional mutation interface with explicit serialization guarantees.

## Diagnostics

- Capture provider stderr at the adapter seam.
- Preserve the first actionable message immediately.
- Coalesce repeated messages by stable category within a bounded time window.
- Never include credentials, full payloads, or user content in process logs.
- Startup timeouts and process exits must reject pending requests and permit a
  clean retry; they must not leave a poisoned pool entry.

## Adding a provider

1. Classify each operation as management read, session work, or mutation.
2. Reuse the existing availability and usage snapshot coordinators.
3. Use a shared resource only when the provider protocol is genuinely
   multiplexable; otherwise use a bounded one-shot process behind single-flight
   caching.
4. Keep protocol-specific behavior inside the provider adapter.
5. Test concurrent creation, failed startup retry, isolation by configuration,
   teardown, and log coalescing through the adapter's interface.
