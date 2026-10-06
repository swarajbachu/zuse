# Organization auto-join staging deployment

Source: uncommitted working tree on `swarajbachu/github-organization-auto-join`
(on top of `c332a091`). Production was not changed.

- Database: migration `0036_organization_auto_join` applied to staging
  (`0035` was already present). Applied through the staging Hyperdrive binding
  (`dfc67e05…`) by a temporary Worker that ran the SQL in a transaction and
  recorded the same drizzle hash and journal timestamp `drizzle-kit migrate`
  would; it was deleted immediately afterwards. Staging now records 40
  migrations and has `api_github_org_members`, `api_organization_domains` and
  `api_organization_domain_enrollments`.
- API: `zuse-relay-staging`, version `7015f569-2e5b-4c96-ace1-1f604386011a`,
  serving `https://api-staging.zuse.sh`. Previous version:
  `f75d00cd-5267-43ee-8219-fe27f257332f`.

Verification before deploy: API unit tests, the PostgreSQL integration test,
and contracts/client-runtime/server/renderer type checks passed. Live checks
confirmed the organization, domain and GitHub connection routes reject a
missing bearer (401) and the GitHub callback rejects missing state (400).

Manual staging checks remain: link a GitHub account whose email differs from
the Zuse account, auto-join through a linked GitHub organization and through a
verified email domain, admin removal blocking, and roster webhooks.

Rollback: redeploy the previous API version. Migration `0036` only adds tables
and is safe to leave in place.

## GitHub account chooser follow-up

Organization installations were missing from the chooser because the
`zuse-staging` GitHub App had no Organization **Members** permission, so the
admin-membership check returned 403 and the chooser silently skipped them.
The chooser now lists such organizations with **Approve on GitHub** (linking
the installation settings) and never offers them as linkable choices.
Redeployed API version: `ca515e4c-ac56-4abf-970b-d2cc82485e27`.

The GitHub App itself still needs Organization → Members: Read-only, the
Organization webhook event, and each organization's acceptance of the updated
permissions before organizations can be linked or auto-joined.

## One-step GitHub linking follow-up

Returning from GitHub no longer requires choosing the account again when the
person already chose it there: after installing on a new account (the setup
redirect's `installation_id` is carried through OAuth in the signed state), and
after approving updated permissions (the chooser's **Approve on GitHub** row
resumes the flow when its tab regains focus). The skip applies only when the
authorizing GitHub user is already linked to the Zuse actor who started the
flow; otherwise the chooser naming the workspace still confirms the link, so a
link minted for another workspace cannot attach someone's account to it.
Redeployed API version: `06f052cb-713a-4802-a907-f9d0233862a2`.
