# API domain cutover

## Ownership

| Hostname | Owner | Cloudflare Worker |
| --- | --- | --- |
| `api.zuse.sh` | Cloudflare Worker Custom Domain | `zuse-relay` |
| `api-staging.zuse.sh` | Cloudflare Worker Custom Domain | `zuse-relay-staging` |
| `code.zuse.sh` | Vercel, production renderer | none |
| `code-staging.zuse.sh` | Vercel, staging renderer preview | none |

Keep the Worker names, secret bindings, Durable Object namespaces, Hyperdrive,
R2 buckets, and managed-tunnel domains unchanged. `CF_ZONE_ID` in the Worker is
for managed tunnels under `stuff.md`, **not** for the API Custom Domain under
`zuse.sh`. Do not replace it with the `zuse.sh` zone ID.

PR #527 moved production to `api.zuse.sh` but kept staging on
`api-staging.stuff.md`. This cutover changes staging's canonical origin and
issuer to `https://api-staging.zuse.sh`. ADR 0003 and migration 0052 describe
the historical naming cutover and remain unchanged.

## Cutover status

The new staging domain was restored on 2026-09-11 after its missing Worker
binding caused requests to reach Vercel (`DEPLOYMENT_NOT_FOUND`). Migrations
0019 and 0020 and the public API Worker were subsequently deployed to staging.
Both staging domains and the `https://api-staging.stuff.md` issuer remain active.
The signed cloud runtime rollout and issuer cutover are separate steps; confirm
current settings and authenticated behavior before promoting the release.

**Before another staging deployment from `main`:** reconcile its Wrangler
routes with both live staging hostnames. At the time of repair, `main` declared
only `api-staging.stuff.md`. Preserve both custom domains and the existing
issuer for a routing-only deployment. Use the coordinated release below to
switch the issuer; do not deploy this feature branch just to preserve a domain.

After a routing repair, compare authoritative DNS with the client's resolver.
Cached Vercel addresses may remain until their DNS TTL expires. Verify the
normal hostname after propagation, not just a request pinned to a Cloudflare IP.

Staging's `API_PUBLIC_ORIGIN` is `https://api-staging.zuse.sh`. Clients must use that URL; DPoP proofs for the retired hostname are intentionally rejected. A remaining legacy route does not imply client authentication compatibility. DPoP proofs
bind to that configured public origin, including behind a rewritten Worker
URL. `API_ISSUER` continues to identify existing signed credentials until the
coordinated cutover; it must not determine the client's request URL. No
forwarded host header or alternate origin is accepted for DPoP binding.

## Preflight

1. Inspect the API Custom Domains and exact DNS records. Record current
   deployment versions, domain mappings, and settings for rollback.
2. Attach the new staging hostname to `zuse-relay-staging` as a **Custom Domain**.
   Cloudflare manages DNS and TLS for this mapping. Do not add a Vercel CNAME
   or a Worker route pointing at Vercel. If an explicit CNAME blocks attachment,
   back up and remove only that verified API-host record; never remove the
   apex, wildcard, `code.zuse.sh`, or unrelated DNS records.
3. Inventory staging machines, workspaces, provider-auth brokers, and clients.
   Prepare a maintenance window and their configuration/credential updates.
   A new default does not update provisioned runtimes' `ZUSE_API_URL`. Preserve
   workspace files and transcripts throughout the cutover.

## Coordinated release

1. Run Biome, type checks, API tests, client configuration tests, and local
   migration tests.
2. Publish the matching signed staging runtime and template, then apply required
   database migrations. The public API requires migrations 0019 and 0020.
3. Deploy the updated production GitHub callback allowlist via the guarded
   production workflow. Its shared `STAGING_API_URL` must recognize the new
   issuer before staging starts GitHub installations. The GitHub App's Setup
   URL remains `https://api.zuse.sh/v1/cloud/github/callback`. Do not deploy
   unrelated branch functionality to production for this step.
4. Once the preceding prerequisites are complete, change staging's tracked
   `API_ISSUER` to `https://api-staging.zuse.sh`, update its deployment-safety
   assertion, and deploy with `bun run deploy:staging` from `infra/api`.
   The current config deliberately preserves the old issuer and both domains.
   Keep production isolated.
5. Update existing staging runtime/service API URLs, restart through the normal
   lifecycle, and renew issuer-bound credentials. Re-enroll provider-auth
   brokers whose authority labels depend on the issuer. Refresh browser/mobile
   sessions and reconnect linked computers as needed. Local migration 0055
   updates exact old staging URLs/issuers while preserving connection data;
   it does not rewrite signed credentials or runtime service files.
6. Update staging Polar/E2B webhook destinations and any explicit deployment
   environment overrides. Slack is part of the API Worker; keep
   `SLACK_PUBLIC_ORIGIN=https://api-staging.zuse.sh` and register its Slack and
   WorkOS callbacks for that host. Use the staging app registration and queue.
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

Use a staging account to verify sign-in, DPoP, GitHub installation, provider-auth
enrollment, signed provider callbacks, and the [required smoke journey](operations.md#required-smoke-journey).
Verify cross-environment authorization isolation, then run the
[Slack app installation and automation journey](slack-app-operations.md).

The staging renderer is hosted at `https://code-staging.zuse.sh` on Vercel's
`zuse-app` project. On 2026-09-26 this domain was attached to the
`feat/standalone-cloud-web-app` preview branch, initially at commit `8037c562`.
Its branch-scoped preview variables are `VITE_ZUSE_HOSTED=1`,
`VITE_ZUSE_API_URL=https://api-staging.zuse.sh`, and
`VITE_WORKOS_CLIENT_ID=client_01KW6ZEZKVMZ0G429A89XZD83Q`.
Vercel Deployment Protection remains enabled.

Reuse this domain for future staging builds. When testing another branch, set
its preview variables to the staging values above, deploy it, and update the
staging domain's branch assignment and deployment alias. Branch auto-deployment
is disabled by the repository's `vercel.json`, so explicitly deploy each build.
Do not repoint production `code.zuse.sh` or change production environment values.

The staging API CORS allowlist includes `https://code-staging.zuse.sh`. WorkOS
requires a one-time redirect registration for
`https://code-staging.zuse.sh/auth/callback` and the web origin
`https://code-staging.zuse.sh` in the staging client. As of 2026-09-26, the
renderer and CORS configuration are verified, but WorkOS still returns
`redirect-uri-invalid` until this dashboard registration is completed.
Do not register per-deployment Vercel URLs for routine staging testing.

## Rollback

Restore the recorded staging deployment, domain, issuer, runtime/service
configuration, and client configuration together. Do not undo database
migrations destructively. Installations that applied migration 0055 need an
explicit configuration repair; never edit migration history or delete data.

Cloudflare reference: [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
