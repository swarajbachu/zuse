# Customer sandbox provider keys

Cloud Workspace settings accept E2B, Boxd and Boat keys for personal accounts and organization owners. Only organization admins can list, replace or disconnect their organization's connections. Organization members can use the resulting workspaces under the existing workspace permissions.

This initial offering has no Zuse subscription requirement or Zuse compute markup for resources created with customer credentials. Providers charge the customer's account directly. Existing Zuse subscriptions are not cancelled, and resources created with Zuse credentials remain subject to managed-cloud billing. Model authentication and model charges are separate from sandbox credentials.

## Deployment prerequisites

Apply migration `0037_cloud_provider_connections.sql` before deploying the API. Configure `CLOUD_DATA_ENCRYPTION_KEY` using the existing API sealing mechanism. The provider adapter must already be enabled and configured in the deployment; adding a customer key does not enable an unconfigured adapter.

Customer accounts must have access to the configured Zuse runtime template/snapshot. A private template in Zuse's provider account is not automatically shared or copied. Settings accept an optional Zuse-compatible template/snapshot ID and an optional Boxd organization. Provider API hosts remain server-controlled. Verify template access and a complete build/create/pause/resume/delete lifecycle with a customer account before rollout.

Keep the existing Codex and provider authentication broker enrollment/serving flags enabled. The authentication authority remains Zuse-managed. Its snapshots are never used to seed a customer's provider account; image builds use the customer's accessible template and broker-backed runtime authentication.

## Credential and resource lifecycle

Keys are verified with a read-only provider lookup, then encrypted with associated data binding the owner, provider and immutable connection ID. HTTP responses contain metadata only and use `Cache-Control: no-store`. Keys are not sent to workspace runtimes.

Replacement is transactional and serializes writes for each owner/provider pair. Only one connection is active for new placement. Builds pin a connection ID in their settings; workspaces pin it in request configuration. Template versions include this ID so snapshots cannot be reused across connections. Forking across different connections is rejected.

Disconnect retires a connection; it does not revoke the key at the provider, erase it, or stop existing workspaces. Retained keys are needed for lifecycle operations and cleanup. Account deletion removes credentials after resource cleanup. Keep old provider keys valid until their workspaces are deleted. If a provider revokes an old key, replacing it only applies to new resources; old resources cannot be managed with the new connection automatically. Missing or unreadable credentials fail closed without falling back to Zuse credentials.

## Billing and telemetry

Provider-key builds and workspaces bypass Zuse billing capacity checks, cost reservations and provider-cost settlement, including invoice and Boat polling paths. Runtime usage observations remain enabled. The owner and immutable resource connection determine billing, not whether the account currently has an active connection. This prevents changing or disconnecting a key from changing historical billing responsibility.

The shared authentication authority, API, durable objects and storage still cost Zuse money. This implementation does not add enterprise pricing, support commitments, or a subscription cancellation flow.

## Verification

Coverage includes encryption and owner isolation, all three provider IDs, replacement/disconnect behavior, invalid-key handling, billing bypass with enforcement enabled, organization permissions, and image-build connection pinning. The PostgreSQL integration test uses an isolated schema and verifies concurrent rotation, rollback and owner-scoped disconnect:

```sh
ZUSE_TEST_DATABASE_URL=postgresql://... bunx vitest run infra/api/test/integration/cloud-provider-connections.pg.test.ts
```

Local tests use fake adapters and disposable PostgreSQL. Live provider lifecycle verification requires customer credentials and an accessible Zuse template.
