# Organizations

## Ownership boundary

WorkOS owns organization membership and invitations. Only the account API holds
the WorkOS API key. Desktop organization RPCs forward to that API; browser clients
use the same authenticated account operations. Selecting a host never changes the
human actor's identity.

Personal is a single-person workspace. Each organization has separate resources,
settings and billing. The existing Personal owner keys remain unchanged, including
encryption bindings. Organization owner keys are `organization:<id>`.

See [organization workspaces](../cloud/organization-workspaces.md) for cloud
authorization, rollout flags and verification.

## Membership and roles

| Role | Workspace content | Organization administration | Billing |
| --- | --- | --- | --- |
| Admin | Yes | Yes | Yes |
| Member | Yes | No | No |
| Billing | No | No | Yes |

The API checks active WorkOS membership on protected operations. Token organization
claims are not authorization. Unknown roles fail closed. Member and invitation IDs
are checked against the requested organization before mutation.

A person may create one organization; organizations they join do not count toward
that limit. Each organization has five seats, counting members and pending
invitations, including billing-only users. Directory-managed membership is
read-only in Zuse. The last administrator cannot be removed or demoted.

Organization mutations serialize through the existing store lock. Production
currently uses a PostgreSQL advisory transaction lock, including the WorkOS
request. Moving network calls outside this transaction requires a replacement
that preserves creation, seat and last-admin race protection; simply removing the
lock is not safe. Changes made directly in WorkOS remain outside this lock.

## Runtime boundary

Organization cloud chats use the existing cloud workspace authorization and
transport. They do not use a second team registry or local sharing service.

Local laptop and SSH environments remain owner-only. Shared-host access and
self-hosted server management are split out for separate review. The old SQLite
migration slot 61 remains reserved by `0061_shared_host_compatibility.ts`; its
historical ledger name is retained. Previously created tables are not dropped,
and the legacy 58/59 ledger repair remains to protect existing installations.

## Client isolation

Clients capture account and workspace identity for asynchronous operations.
Catalogs, navigation, drafts, transports and durable commands must not publish or
replay into a different owner after switching. Workspace switching does not stop
agents. UI role checks improve presentation; server checks remain authoritative.

## Verification boundaries

Focused tests cover creation and seat limits, role enforcement, stale responses,
workspace isolation, sharing revisions and live gateway permission downgrades.
Passing these tests does not replace multi-identity staging checks.

Remaining review work includes mobile command/cache ownership, bounded organization
mutation locking, and consolidation of duplicated ownership code. Account HTTP
decoding is shared across desktop/browser and mobile. Organization access remains
opt-in.

## Automatic joining

Organization features live only in organization workspaces. Personal settings
have none; the workspace switcher creates organizations. Administrators control
two automatic joining paths from **Members**. Both admit people as Member only,
never convert a manually admitted membership, skip full organizations, and are
blocked by an administrator's removal until **Allow again**.

### GitHub organizations

An organization links any number of GitHub organizations with **Link GitHub
organization**. Linking uses the shared workspace GitHub installation flow, so the
same installation also serves the organization's Cloud repositories. Auto-join is
turned on per linked GitHub organization. Personal installations are ineligible.
GitHub owners do not receive Zuse administrator privileges.

People link a GitHub account in **Settings → General → Account → GitHub** through
Zuse's GitHub App OAuth flow (`/v1/organizations/github/authorize` and
`/callback`), not a second sign-in system. The browser has no Zuse session,
so after OAuth the verified identity is held for ten minutes and a page names
the target Zuse account by email; only its same-browser, same-origin POST
links the identity. A link minted for someone else's account therefore cannot
attach a GitHub account silently. The linked GitHub account may use a
different email than the WorkOS account, and an account can switch to another
GitHub account. One GitHub account never links to two Zuse accounts. GitHub
tokens are used only during linking and are not stored.

Joining happens without a member action: when GitHub is linked (the callback page
lists organizations joined), whenever organizations load (`GET /v1/organizations`),
when auto-join turns on (every linked account in the roster), and when signed
installation or organization webhooks report changes. Matching uses
`api_github_org_members`, the last complete roster per installation, which every
complete roster read replaces. Outside collaborators and pending GitHub
invitations are not in rosters.

### Email domains

An administrator can add only the domain of their own verified WorkOS email;
personal mailbox providers (gmail.com and similar) are rejected, and a domain
belongs to one organization. With auto-join on, anyone whose verified email is
on that domain joins when their organizations load. Domains and domain-join
provenance live in `api_organization_domains` and
`api_organization_domain_enrollments`.

### Consistency and authorization

WorkOS remains the membership authority. A GitHub join first commits an
enrollment intent with a ten-minute seat reservation under the existing
organization lock, then creates/reactivates the WorkOS membership under that lock.
Domain joins record provenance before the WorkOS call under the same lock. Seat
checks count active users, pending invitations and unexpired GitHub reservations.
This supports the production single-connection pool and preserves provenance if
WorkOS accepts a request whose response is lost. Matching is best effort and
never blocks listing organizations.

Shared workspace authorization validates GitHub-managed memberships against the
live roster. Complete successful rosters are cached in memory for at most 60
seconds, with concurrent reads coalesced and durable policy revisions
invalidating caches across workers. A confirmed GitHub departure idempotently
deactivates WorkOS membership. Outages fail closed after the cache expires;
disconnection and suspension block access without deactivating members. Turning
auto-join off only stops new joins. GitHub-managed members cannot be promoted.
Manually managed administrators provide the recovery path when GitHub is
unavailable.

### Rollout

Deploy migrations `0035_github_organization_joining` and
`0036_organization_auto_join` before the API. Keep
`/v1/organizations/github/callback` on each API origin in the GitHub App's allowed
OAuth callback URLs, grant Members read access, and subscribe the signed webhook
to organization membership events. Existing installations may need their owner
to approve the permission. The renderer always enables organization workspaces
when its resolved API URL is staging (including the default local dev target).
Other API targets retain the `VITE_ORGANIZATION_WORKSPACES=true` opt-in. The API
retains its `ORGANIZATION_WORKSPACES_ENABLED` rollout flag. Verify linking with a
GitHub account whose email differs, roster webhooks, domain joining, removal and
reconnect with separate staging accounts before production enablement.
