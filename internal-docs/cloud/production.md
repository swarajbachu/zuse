> For the Stripe migration, follow [Stripe billing and migration](stripe-billing.md).
> Keep the Polar configuration below for legacy subscriptions during coexistence.

# Public cloud beta production runbook

Production remains fail-closed for billable operations until every immutable
ID, secret, and smoke test below is complete. Local, SSH, pairing, and
user-managed remote connections do not use Cloud billing.

## External resources

1. In Polar production, create Cloud Workspace with a $40 monthly price. Create
   meter `zuse_cloud_overage_cent`, summing numeric metadata field `units`, and
   attach a recurring $0.01-per-unit price. Register
   `https://api.zuse.sh/v1/billing/webhook/polar` for the subscription events
   supported by the Polar adapter: created, updated, active, past due, canceled,
   uncanceled, and revoked. A checkout link purchase has no Zuse account yet;
   after the buyer signs in with the same verified WorkOS email, API claims
   the unowned Polar customer once and reconciles its existing subscription.
2. In E2B production, build artifacts from the release commit, then publish the
   isolated production template:

   ```sh
   infra/cloud-sandboxes/prepare-artifacts.sh
   node infra/cloud-sandboxes/publish-template.mjs production
   ```

   Record the immutable build identifier from the CLI in
   `E2B_TEMPLATE_VERSION`. Register
   `https://api.zuse.sh/v1/cloud/billing/webhook/e2b` and verify a signed real
   delivery. Subscribe to created, resumed, paused, checkpointed, updated, and
   killed lifecycle events.
4. A version tag, or an explicit production dispatch from `main`, publishes a separately signed runtime to
   `cloud-runtime-production`. Record that manifest URL and its production
   public signing key in API. The workflow uploads the archive before the
   manifest and verifies its checksum, signature, native modules, metadata, and
   startup first. To deploy merged runtime fixes without publishing a desktop
   release, run `gh workflow run cloud-runtime-staging.yml --ref main -f publish_target=production`.
   Production dispatches from feature branches remain rejected.
5. Configure the shared GitHub App Setup URL as
   `https://api.zuse.sh/v1/cloud/github/callback`. Use the same App ID, slug,
   client ID, and private key in both deployments. Production validates its own
   signed install state and forwards only the exact staging issuer to
   `api-staging.zuse.sh`, where staging performs the signature and account
   validation.

### GitHub installation authorization

The main **Install GitHub App / Configure app** button handles both new and existing
installations. This uses GitHub user authorization, not an installation
callback or a manually entered installation ID. The browser then explicitly
chooses one account for the selected Zuse workspace; users without an installation
are sent to GitHub to install it. Personal and organization
links remain independent; no credentials are inherited automatically.

Before deploying this flow:

- Set `GITHUB_APP_CLIENT_SECRET` alongside the existing client ID/private key in
  each API deployment. Never expose the client secret to the renderer.
- Register each environment's authorization callback in its own GitHub App:
  production `zusehq` uses `https://api.zuse.sh/v1/cloud/github/callback`;
  staging `zuse-staging` uses `https://api-staging.zuse.sh/v1/cloud/github/callback`.
- Grant the app **Organization permissions → Members: read-only**. Existing
  installations must approve this permission before their GitHub organization
  owner can connect them. Repository collaborators cannot grant an entire
  installation to a workspace.
- Keep the existing Setup URL and leave **Request user authorization during
  installation** off: Zuse starts authorization after setup and binds it to an
  HttpOnly browser cookie. **Redirect on update** is useful but not required for
  existing-connection recovery or repository refresh.

New setup callbacks also require user authorization before saving an installation.
Old in-flight setup links expire; restart them from Zuse after the deployment.
Verify fresh install, existing install, repository access changes without a
callback, and organization-admin removal during authorization on staging before
promoting. No migration is needed. GitHub OAuth tokens are not persisted or sent
to clients; only the explicitly selected installation is stored.

References: [GitHub setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url),
[user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

### GitHub installation webhooks

Deploy the receiver before enabling **Webhook → Active** on the GitHub App.
Use separate GitHub Apps and secrets for staging and production:

- Staging: `https://api-staging.zuse.sh/v1/cloud/github/webhook`
- Production: `https://api.zuse.sh/v1/cloud/github/webhook`
- Store the matching secret as `GITHUB_APP_WEBHOOK_SECRET` in that API deployment
  (`bun run secret:github-webhook-secret` from `infra/api` for staging).
- Match the App ID, client ID/secret, slug and private key to the same app.
  With separate apps, register only that environment's callback and Setup URL.
- The receiver handles `installation`, `installation_repositories`, and signed
  `ping` deliveries. Push/PR events and additional repository permissions are
  unnecessary for connection synchronization.

Signatures are verified against the raw body before parsing. Events trigger a
current-state GitHub API read, not historical payload replay. Only existing
workspace links are updated; uninstallation removes links, not projects or
repositories. Connecting an installation still requires user authorization.
Repeated deliveries are idempotent reconciliations, not jobs; there is no separate
delivery ledger or connection registry. Older overlapping refreshes cannot
overwrite newer observations or recreate removed links.

The existing GitHub status endpoint reconciles installation metadata after 60
seconds, including suspended installations, to recover missed deliveries. The
repository picker already fetches current permissions from GitHub. Visible
repository settings refresh their scoped cache every 30 seconds and on window
focus; this is not a new push transport. Transient GitHub failures leave persisted
connections intact and return a non-2xx webhook response. GitHub does not retry
failed deliveries automatically: inspect Recent deliveries and redeliver failures.

Before enabling, verify a signed ping, repository selection changes, suspension,
restoration, and uninstall against a test installation. A new installation must
not appear in a Zuse workspace until explicitly connected. No migration is needed.

When the production API hostname changes, update and verify both the Polar
and E2B endpoints above. They are provider-owned configuration and cannot be
changed by an API deployment.

## Production configuration

Replace every empty production value in `wrangler.production.jsonc`. Set E2B
enabled with the immutable production template, Polar to `production` with its
product and meter IDs, and an explicit `CLOUD_BILLING_CUTOVER_AT`. Hyperdrive
must point to the approved production database with SQL caching disabled. The
R2 binding remains `zuse-cloud-transcripts`, and `WorkspaceGateway` remains a
thin Durable Object router.

Install secrets only through the explicit production commands:

```sh
bun --cwd infra/api secret:mint:production
bun --cwd infra/api secret:workos:production
bun --cwd infra/api secret:cf:production
bun --cwd infra/api secret:e2b:production
bun --cwd infra/api secret:e2b-webhook:production
bun --cwd infra/api secret:cloud-vault:production
bun --cwd infra/api secret:polar:production
bun --cwd infra/api secret:polar-webhook:production
bun --cwd infra/api secret:github-private-key:production
```

Apply migration `0010_cloud_billing_ledger` before deploying billing code. The
guarded command requires the approved database identity in
`production-database.json` and rejects staging:

```sh
ZUSE_CONFIRM_PRODUCTION_DATABASE_MIGRATION=migrate-api.zuse.sh \
DATABASE_URL=... \
bun --cwd infra/api db:migrate:production
```

The production deploy independently validates nonempty runtime, E2B, Polar,
R2, Hyperdrive, cutover, and secret configuration:

```sh
ZUSE_CONFIRM_PRODUCTION_API_DEPLOY=deploy-api.zuse.sh \
bun --cwd infra/api deploy:production
```

## Cutover

Start with checkout, enforcement, and Polar export disabled. Use one internal
WorkOS account to complete a production subscription. Smoke template boot,
repository setup, runtime enrollment,
gateway WebSocket, pause/resume, SSH, checkpoint sync, cap update, archive, and
deletion.

Import the matching E2B statement and require variance of at most 1% and $1.
Then enable enforcement while export stays off, verify reservations stop new
compute at the cap, enable export for the internal account, and confirm stable
external IDs deduplicate retries and API, Polar, and the operator report have
equal totals. Only then open checkout to public-beta accounts.

Rollback switches are independent: disable checkout, Polar export, or
enforcement as needed. A Worker rollback must preserve sandboxes,
encrypted transcripts, customers, and all ledger records.
