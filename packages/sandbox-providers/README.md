# Sandbox provider adapters

This package owns the ephemeral-sandbox provider seam and registry. It is the
sibling of `@zuse/machine-providers`: that package holds the persistent-machine
lifecycle contract, while `SandboxProviderAdapter` models second-scale
microVM sandboxes (fast create, pause/resume, snapshot-and-fork, short
timeouts). The two contracts share `@zuse/provider-registry` and must not be
merged — ephemeral lifecycle guarantees would weaken the persistent contract
with optional operations.

Each adapter must:

- use a stable, unique `providerId`;
- make creation recoverable by deterministic provider label;
- normalize vendor failures to `SandboxProviderError`;
- treat kill and snapshot deletion as idempotent;
- keep credentials and raw provider payloads inside the adapter;
- start every fork with egress blocked at the provider level and expose a
  single-call `setNetwork` that writes the complete final policy (ADR 0033:
  the quarantine barrier is provider-enforced and never a caller choice).

`ProviderSandbox.endpointDomain` composes per-port public hosts via
`sandboxHostForPort` — sandbox providers supply reachability directly, unlike
persistent machines, which dial out through a managed tunnel.

`SandboxProviderRegistration.aliases` maps retired provider IDs to the same
adapter implementation, mirroring the machine-provider registry.

## Adding a provider

1. Add one provider adapter module and export it from `package.json`.
2. Test the complete `SandboxProviderAdapter` interface using a fake HTTP
   client, including timeout recovery, idempotent deletion, and the
   fork-starts-quarantined invariant.
3. Add relay configuration following the pattern in
   `infra/relay/src/machine-provider-modules`.

## E2B

`@zuse/sandbox-providers/e2b` provides the `e2b` adapter. It talks to the
E2B REST API directly over `fetch` (no vendor SDK, so it runs in workerd) and
authenticates with the `x-api-key` header. Forks are creates from a snapshot
ID and always pass `allow_internet_access: false`; the network is opened by
`setNetwork` after enrollment re-keys the fork. Snapshot deletion goes
through the provider's template store, and recovery uses the deterministic
label persisted in sandbox metadata. The quarantine capability this adapter
relies on was verified live in
`specs/cloud-platform/research/quarantined-fork-verification.md`.
