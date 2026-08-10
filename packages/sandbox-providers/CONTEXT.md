# Sandbox Compute

Sandbox Compute provides isolated, remotely accessible execution environments without tying the product or chat model to one infrastructure vendor.

## Language

**Sandbox offer**:
A provider-neutral commercial entitlement to use sandbox compute.
_Avoid_: Provider subscription, vendor plan

**Sandbox provider**:
An infrastructure service on which a sandbox can be provisioned. Provider choice is placement, not product identity.
_Avoid_: AI provider, billing provider

**Provider adapter**:
The internal integration that translates the shared sandbox lifecycle into a provider's native API and configuration.
_Avoid_: Sandbox offer

**Sandbox placement**:
The provider choice applied when a sandbox is provisioned. It may use the system default when the user makes no explicit choice.
_Avoid_: Subscription type, machine plan

**Sandbox**:
An isolated execution environment created through one sandbox provider and attached to an account-owned chat or workspace lifecycle.
_Avoid_: Provider, subscription
