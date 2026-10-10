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

The desktop's own local server serves every workspace. Each local project row
records its owning workspace in `projects.workspace_key` (`personal` or
`organization:<id>`, migration 0063). Projects added while an organization is
selected belong to that organization and merge with its cloud project by git
origin. The renderer shows only the selected workspace's projects, and their
chats and sessions, through `scopeEnvironmentShell`. Adding a path owned by
another workspace offers a move; the move is a compare-and-swap on the owner.
This is presentation separation for the same machine owner, not an access
boundary. Machine-wide bookkeeping (keep-awake, update deferral) still counts
every workspace's agents, and external-chat import stays Personal-only.

Ordinary SSH and other remote device profiles stay Personal. Organization
enrollment of self-hosted servers and shared-host access are separate, deferred
work.

## Rollout flags

- API: `ORGANIZATION_WORKSPACES_ENABLED=true` is the global kill switch.
  Staging and production enable it. Production access remains restricted by the
  targeted rollout below. Keep this setting in the production deployment config
  so a redeploy does not hide existing organizations.
- API: `ORGANIZATION_ROLLOUT_ENABLED=true` restricts access using server-side
  PostHog flags. Production configuration enables targeted rollout; staging
  retains unrestricted organization testing. Missing keys or failed evaluations
  deny targeted access.
- Set the Worker secret `ORGANIZATION_POSTHOG_KEY` to the PostHog project token,
  and `ORGANIZATION_POSTHOG_HOST` to its ingestion origin (defaults to
  `https://us.i.posthog.com`; EU uses `https://eu.i.posthog.com`). Never use a
  personal administrative API key here.
- Desktop/browser reads `GET /v1/organizations/capabilities` through account-scoped
  `organizations.capabilities` RPC. Production UI stays hidden until the backend
  approves creation or returns an accessible team. A separate
  `VITE_ORGANIZATION_WORKSPACES` production build is no longer required.

Create two boolean PostHog flags with everyone else excluded:

1. `organization-creation`, targeted by person, enables selected users at 100%.
   Use the existing pseudonymous PostHog distinct ID, not email or raw WorkOS ID.
   Obtain it from the existing PostHog person, or calculate it locally with
   `bun -e 'import { analyticsAccountId } from "./packages/analytics/src/identity.ts"; console.log(analyticsAccountId(process.argv[1]))' user_EXAMPLE`.
2. `organization-access`, targeted by the `organization` group, optionally
   enables existing organization IDs at 100%. Configure the group type using
   [PostHog group analytics](https://posthog.com/docs/product-analytics/group-analytics).
   Evaluations send the organization ID as the group key and `$group_key` property.

Teams created by approved users get access automatically, including existing
teams whose WorkOS `zuse_creator` metadata names that user. Members and invitees
need no individual flag approval. The backend reads creator metadata from WorkOS;
requesting members cannot nominate a creator. An organization is enabled if its
creator has `organization-creation` or its ID has `organization-access`.
Removing creator approval also removes inherited team access unless the team is
explicitly enabled. Use the global switch to disable all organization access.

Flags supplement WorkOS membership and role authorization. Shared authorization,
organization catalogs, creation, and GitHub/domain auto-join use the same rollout
policy. GitHub account linking remains available on the API so an eligible person
can link before joining; it does not grant membership to an unapproved team.

Evaluations use `/flags/?v=2`, a three-second timeout, bounded worker-local caches,
and a 30-second approval TTL. Concurrent evaluations coalesce. Failed evaluations
cache denial for five seconds and never extend stale approval. The client refreshes
capabilities while visible every 30 seconds and on focus, resets them on account
changes, and returns to Personal when a refreshed catalog removes the selected
team or a capability refresh fails. Backend decisions are independent of the usage analytics consent setting;
no capture events or browser analytics SDK flags are enabled by this rollout.
Flag changes can take about 30 seconds to reach backend checks and one further
client refresh to reach the visible catalog. Existing accepted runtime turns retain
their current lifecycle semantics; this does not forcibly terminate running work.

Deploy the compatible API and desktop/browser before enabling the production
kill switch. Code changes do not update an already-published runtime. Keep
existing sandbox data, databases and session IDs intact. Older clients retain
their build-time UI gate; backend access checks still restrict them.

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
