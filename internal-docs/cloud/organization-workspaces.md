# Organization workspaces

## Scope and billing

Personal and each organization own their cloud configuration, repositories,
scripts, images, credentials, usage and subscription independently. A member does
not need a Personal subscription to use a funded organization's resources.
Personal secrets are never inherited by organizations.

The authenticated actor remains the person. Organization storage uses the owner
key `organization:<id>`; Personal storage and encryption keys are unchanged.
There is no subscription transfer, credit pooling or per-seat pricing in this
implementation.

## Request authorization

Requests use `x-zuse-workspace: personal|organization:<id>` and, for scoped HTTP
routes, the `/v1/organization-workspaces/<id>` prefix. Conflicting or malformed
scope is rejected. Routes not explicitly supported for organization scope fail
closed rather than falling back to Personal.

WorkOS membership is verified by the API. Administrators may manage configuration
and billing. Members may access workspace content; billing-only members may
manage finances but may not read chats, code or credentials. Ordinary members
receive an entitlement boolean for placement, not financial details.

## Cloud chat sharing

Chat policies support Private or Organization audience, View or Edit permission,
and explicit membership-bound grants. Links require authentication and do not
grant access. Creators and organization administrators manage sharing.
Administrators retain access to private chats, including those with an invalid
legacy sharing policy; non-administrators fail closed on invalid policies.

Policies carry their own revision for compare-and-set updates. Runtime heartbeats,
usage and workspace lifecycle changes do not invalidate sharing edits. WorkOS
organization metadata stores defaults for future chats; existing policies remain
unchanged when defaults change.

Connection tickets carry actor and permission. The gateway rechecks current
membership and sharing policy and never upgrades a view ticket to edit. Runtime
RPC authorization scopes catalogs, transcripts, files, Git, terminals and agent
commands to the verified chat. View-only access cannot mutate the workspace.

Durable commands use the existing mailbox and receipts. Queued commands preserve
their author; removal or loss of access must prevent subsequent execution.
Account sign-in provides desktop/browser access to cloud chats without pairing.

## Settings and persistence

`/v1/cloud/settings` reads require content access; writes require administration
and the current settings revision. Device preferences remain local. Applied API
migrations, including `0030_workspace_settings`, stay in place. Do not recreate
sandboxes, runtime databases or session IDs during rollout.

Local laptops and ordinary SSH profiles stay Personal. Organization enrollment
of self-hosted servers and shared-host access are separate, deferred work.

## Rollout flags

- API: `ORGANIZATION_WORKSPACES_ENABLED=true`. Staging configuration enables it;
  production configuration leaves it disabled.
- Desktop/browser: `VITE_ORGANIZATION_WORKSPACES=true` at build time.
  The default is disabled.
- Mobile: `EXPO_PUBLIC_ORGANIZATION_WORKSPACES=true` at build time.
  The default is disabled.

A client flag is not an authorization boundary. The API rejects organization
operations when its flag is disabled. Confirm API, client and runtime compatibility
before enabling access. Code changes do not update an already-published runtime.

## Release verification

Before production enablement, verify on staging with an administrator, member and
billing-only identity:

- Personal and multiple organization workspaces isolate settings, chats, search,
  navigation, drafts and late responses.
- Invitations enforce one created organization and five occupied/reserved seats,
  including simultaneous requests and revoked or expired invitations.
- Funded organization chats work without Personal subscriptions.
- Private, organization View/Edit and named grants are enforced on reads,
  commands, files, terminals and authenticated links.
- Downgrades/removal revoke connected access and reconnects.
- Billing-only members cannot read content or start catalog retry loops.
- Existing Personal subscriptions, ciphertext, running sessions and migrations
  survive upgrades unchanged.
- Sharing edits succeed during active runtime heartbeats and conflict only with
  another sharing edit.

Run Biome, architecture, localization, package type checks, unit/integration tests,
PostgreSQL-backed tests and multi-user browser checks. Keep deployment IDs,
temporary QA credentials and test-run counts out of this document.

This branch is not production-approved solely because unit tests pass. Remaining
review and split work is tracked separately in the workspace review checklist.
