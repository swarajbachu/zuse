# Machine provider adapters

This package owns the machine-provider seam and registry. Relay lifecycle code
depends only on `MachineProviders`; concrete infrastructure vendors implement
`MachineProviderAdapter`.

`MachineProviderAdapter` is the persistent-machine lifecycle contract. A
provider must implement create/recover, inspect, power, snapshot, and
idempotent deletion semantics before it can back a persistent offer. Ephemeral
sandboxes with materially different lifecycle guarantees should use a separate
adapter interface while sharing `@zuse/provider-registry`; they should not
weaken the persistent-machine contract with optional operations.

Each adapter must:

- use a stable, unique `providerId`;
- map the server-owned `MachineOffer.offerId` to its own SKU and region;
- make creation recoverable by deterministic provider label;
- normalize vendor failures to `MachineProviderError`;
- treat deletion operations as idempotent;
- keep credentials and raw provider payloads inside the adapter.

Register every adapter that may own an existing machine. Changing
`defaultProviderId` only routes new machines; reconciliation resolves existing
machines using the provider ID persisted on each record.

`MachineProviderRegistration.aliases` maps retired provider IDs to the same
adapter implementation. Alias expansion is centralized in this package so
relay configuration never needs to clone or wrap adapters itself.

## Adding a provider

1. Add one provider adapter module and export it from `package.json`.
2. Test the complete `MachineProviderAdapter` interface using a fake HTTP
   client, including timeout recovery and idempotent deletion.
3. Add one relay configuration module under
   `infra/relay/src/machine-provider-modules`.
4. Add that module to `machineProviderModules` in
   `infra/relay/src/machine-provider-config.ts`.

The generic resolver loads every configured module, registers historical
aliases, and uses `MACHINE_PROVIDER` only to choose the default for new
machines. Switching the default therefore does not strand machines created by
an earlier provider, including when the fake adapter is selected for a
non-production deployment. Each live module owns a schema for its environment
and activates only when selected or when its indispensable credential is
present; optional endpoint defaults do not accidentally activate it.

## Hetzner

`@zuse/machine-providers/hetzner` provides the `hetzner` adapter. It uses the
Cloud API directly, validates the configured server type and location against
the server-owned offer before creation, attaches a pre-created firewall,
enables backups, and recovers ambiguous creates by deterministic server name.

The relay owns configuration and cloud-init rendering. The adapter owns only
provider API translation and never exposes the project token or raw provider
responses through the machine contract.

The relay also registers the former generic provider ID as a reconciliation
alias. Existing machines therefore remain manageable after switching the
default for newly created records to `hetzner`.
