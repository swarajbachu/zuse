# Context Map

## Contexts

- [Sandbox Compute](./packages/sandbox-providers/CONTEXT.md) — defines provider-neutral sandbox placement and provider-native runtime integrations.

## Relationships

- **Billing → Sandbox Compute**: a sandbox offer grants entitlement; it does not choose the infrastructure provider.
- **Chat → Sandbox Compute**: a chat may request an available sandbox provider when provisioning its execution environment.
- **Sandbox Compute → Relay**: the relay validates placement and routes lifecycle operations to the selected provider adapter.
