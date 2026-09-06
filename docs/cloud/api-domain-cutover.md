# API domain cutover

## Ownership

| Hostname | Owner | Cloudflare Worker |
| --- | --- | --- |
| `api.zuse.sh` | Cloudflare Worker Custom Domain | `zuse-relay` |
| `api-staging.zuse.sh` | Cloudflare Worker Custom Domain | `zuse-relay-staging` |
| `code.zuse.sh` | Vercel, production renderer | none |

Keep the Worker names, secret bindings, Durable Object namespaces, Hyperdrive,
R2 buckets, and managed-tunnel domains unchanged. `CF_ZONE_ID` in the Worker is
for managed tunnels under `stuff.md`, **not** for the API Custom Domain under
`zuse.sh`. Do not replace it with the `zuse.sh` zone ID.

PR #527 moved production to `api.zuse.sh` but kept staging on
`api-staging.stuff.md`. This cutover changes staging's canonical origin and
issuer to `https://api-staging.zuse.sh`. ADR 0003 and migration 0052 describe
the historical naming cutover and remain unchanged.

## Current rollout state (2026-09-05)

- Production's existing Custom Domain was verified, not redeployed.
- `api-staging.zuse.sh` was attached to the existing staging Worker through the
  Mac's authenticated Cloudflare session. No Worker code or settings changed.
- The old staging domain remains attached during preparation. The live staging
  issuer is still `https://api-staging.stuff.md` until the coordinated release.
- The new canonical client defaults, issuer configuration, and local migration
  are prepared in this branch, not yet deployed. DNS attachment alone does not
  prove that authenticated clients work against the new origin.
- Routing was verified from both the Mac and cloud sandbox: both new API
  hostnames return `401 missing_bearer` from `/v1/environments`. The old staging
  hostname still responds. The Mac OAuth session could manage Worker domains
  but could not list DNS records; no DNS records were manually deleted.

Recorded deployment versions before this routing-only change:

| Worker | Version |
| --- | --- |
| `zuse-relay` | `54e7baee-018e-4445-ab76-3b24f72ac369` |
| `zuse-relay-staging` | `f87f96a1-33f6-473f-8947-d41a146cb3fe` |

## Preflight

1. Authenticate to the existing Cloudflare account. Inspect both Worker Custom
   Domains and the exact DNS records for the API hostnames. Record the current
   deployment versions, domain mappings, and settings for rollback.
2. Attach the new staging hostname to `zuse-relay-staging` as a **Custom Domain**.
   Cloudflare manages DNS and TLS for this mapping. Do not add a Vercel CNAME
   or a Worker route pointing at Vercel. If an explicit CNAME blocks attachment,
   back up and remove only that verified API-host record; never remove the
   apex, wildcard, `code.zuse.sh`, or unrelated DNS records.
3. Inventory existing staging machines, cloud workspaces, provider-auth brokers,
   and clients before changing the issuer. Updating a default does not rewrite
   an already-provisioned runtime's `ZUSE_API_URL` or service configuration.
4. Coordinate a staging maintenance window. Prepare current clients, runtime
   artifacts, credentials, and staging provider callback URL updates before
   switching. Preserve workspace files and transcripts; do not delete
   workspaces to accomplish a hostname migration.

## Coordinated release

1. Verify the release with Biome, types, API deployment/crypto/GitHub tests,
   client configuration tests, and the local migration tests.
2. Publish the matching signed staging runtime and template. Apply any required
   database migrations before deploying code that uses them. This branch's
   public API also requires migrations 0019 and 0020; do not deploy it solely
   to change DNS without completing those prerequisites.
3. Deploy the updated production GitHub callback allowlist via the guarded
   production workflow. Its shared `STAGING_API_URL` must recognize the new
   issuer before staging starts GitHub installations. The GitHub App's Setup
   URL remains `https://api.zuse.sh/v1/cloud/github/callback`. Do not deploy
   unrelated branch functionality to production for this step.
4. Deploy staging with `bun run deploy:staging` from `infra/api`. The tracked
   route and `API_ISSUER` select `api-staging.zuse.sh`. Keep production isolated.
5. Update existing staging runtime/service API URLs, restart through the normal
   lifecycle, and renew issuer-bound credentials. Re-enroll provider-auth
   brokers whose authority labels depend on the issuer. Refresh browser/mobile
   sessions and reconnect linked computers as needed. Local migration 0055
   updates exact old staging URLs/issuers while preserving connection data;
   it does not rewrite signed credentials or runtime service files.
6. Update staging Polar/E2B webhook destinations and any explicit deployment
   environment overrides. Point the staging Slack Worker at
   `ZUSE_API_URL=https://api-staging.zuse.sh`; keep its keys and webhook secret
   scoped to the staging account.
7. Verify the journeys below before retiring the old domain. Do not rely on
   redirects or accepting old issuers as an authentication compatibility layer.

## Verification

For each API origin, `GET /v1/environments` without a token should return HTTP
401 with `{"error":"missing_bearer"}`. This tests routing to the API handler,
not database health or successful authentication. There is no `/health` route;
a root or `/health` 404 is not a health check.

```sh
curl -i https://api.zuse.sh/v1/environments
curl -i https://api-staging.zuse.sh/v1/environments
```

Then use a staging test account to verify sign-in, DPoP token issuance,
environment listing, gateway connection, workspace create/send/pause/resume,
GitHub installation, provider-auth enrollment, and signed provider callbacks.
Verify that staging credentials do not authorize production operations. Run
the [Slack thread and image journey](../../examples/slack-bot/README.md) after
the staging public API and bot are deployed.

A separate staging renderer needs its own Vercel deployment, explicit
`VITE_ZUSE_HOSTED=1`, `VITE_ZUSE_API_URL=https://api-staging.zuse.sh`, the staging
`VITE_WORKOS_CLIENT_ID`, WorkOS redirect/origin registration, and an exact
staging API CORS allowlist entry. `code-staging.zuse.sh` is the proposed URL,
not an already-deployed app. Do not repoint production `code.zuse.sh`.

## Rollback

If the new domain attachment fails, retain the old domain and issuer. If the
coordinated issuer release fails, restore the recorded staging deployment,
issuer, runtime/service configuration, and client configuration together;
restore old domain routing if it was removed. Do not roll back database
migrations destructively. A local installation that has applied migration 0055
needs an explicit configuration repair for rollback; do not edit migration
history or delete its database.

Cloudflare reference: [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
