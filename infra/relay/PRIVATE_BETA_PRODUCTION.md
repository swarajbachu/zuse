# Private cloud beta production runbook

Production remains fail-closed until every immutable ID, secret, and smoke test
below is complete. Local, SSH, pairing, and user-managed remote connections do
not use this gate.

## External resources

1. In PostHog production, create the boolean flag
   `zuse-cloud-beta-access`, default false. Target invited people by the exact
   `workos_account_id`. Relay evaluates it with the WorkOS-verified account ID;
   clients cannot supply or override that identity.
2. In Polar production, create Cloud Workspace with a $40 monthly price. Create
   meter `zuse_cloud_overage_cent`, summing numeric metadata field `units`, and
   attach a recurring $0.01-per-unit price. Register
   `https://relay.stuff.md/v1/billing/webhook/polar` for the subscription events
   supported by the Polar adapter.
3. In E2B production, build artifacts from the release commit, then publish the
   isolated production template:

   ```sh
   infra/cloud-sandboxes/prepare-artifacts.sh
   node infra/cloud-sandboxes/publish-template.mjs production
   ```

   Record the immutable build identifier from the CLI in
   `E2B_TEMPLATE_VERSION`. Register
   `https://relay.stuff.md/v1/cloud/billing/webhook/e2b` and verify a signed real
   delivery.
4. A version tag publishes a separately signed runtime to
   `cloud-runtime-production`. Record that manifest URL and its production
   public signing key in Relay. The workflow uploads the archive before the
   manifest and verifies its checksum, signature, native modules, metadata, and
   startup first.

## Production configuration

Replace every empty production value in `wrangler.production.jsonc`. Set E2B
enabled with the immutable production template, Polar to `production` with its
product and meter IDs, and an explicit `CLOUD_BILLING_CUTOVER_AT`. Hyperdrive
must point to the approved production database with SQL caching disabled. The
R2 binding remains `zuse-cloud-transcripts`, and `WorkspaceGateway` remains a
thin Durable Object router.

Install secrets only through the explicit production commands:

```sh
bun --cwd infra/relay secret:mint:production
bun --cwd infra/relay secret:workos:production
bun --cwd infra/relay secret:cf:production
bun --cwd infra/relay secret:e2b:production
bun --cwd infra/relay secret:e2b-webhook:production
bun --cwd infra/relay secret:cloud-vault:production
bun --cwd infra/relay secret:posthog:production
bun --cwd infra/relay secret:polar:production
bun --cwd infra/relay secret:polar-webhook:production
```

Apply migration `0010_cloud_billing_ledger` before deploying billing code. The
guarded command requires the approved database identity in
`production-database.json` and rejects staging:

```sh
ZUSE_CONFIRM_PRODUCTION_DATABASE_MIGRATION=migrate-relay.stuff.md \
DATABASE_URL=... \
bun --cwd infra/relay db:migrate:production
```

The production deploy independently validates nonempty runtime, E2B, PostHog,
Polar, R2, Hyperdrive, cutover, and secret configuration:

```sh
ZUSE_CONFIRM_PRODUCTION_RELAY_DEPLOY=deploy-relay.stuff.md \
bun --cwd infra/relay deploy:production
```

## Cutover

Start with checkout, enforcement, and Polar export disabled. Invite one internal
WorkOS account through PostHog, enable checkout for it, and complete a production
subscription. Smoke template boot, repository setup, runtime enrollment,
gateway WebSocket, pause/resume, SSH, checkpoint sync, cap update, archive, and
deletion.

Import the matching E2B statement and require variance of at most 1% and $1.
Then enable enforcement while export stays off, verify reservations stop new
compute at the cap, enable export for the internal account, and confirm stable
external IDs deduplicate retries and Relay, Polar, and the operator report have
equal totals. Only then expand the PostHog cohort and checkout eligibility.

Rollback switches are independent: disable the PostHog flag, checkout, Polar
export, or enforcement as needed. A Worker rollback must preserve sandboxes,
encrypted transcripts, customers, and all ledger records.
