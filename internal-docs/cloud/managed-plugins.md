# Managed plugins

Zuse embeds Executor v2 on Cloudflare, pinned to upstream commit
`50bea37fe5d146701990901a878ea940c5012564`. The renderer never receives vendor tokens,
client secrets, Executor settings, or user-editable server URLs.

This integration exposes catalog plugins, account connection, discovery and tool
calls. Schedules, workflows, codemode, webhooks, app UIs and user-authored code are
not exposed. The existing renderer and local/cloud agent contracts are unchanged.

## Deployment

Both API Wrangler configurations bind `PLUGIN_VAULT` to the SQLite-backed
`PluginVault` Durable Object, with the appended `plugins-v1` migration. Each
object owns one tenant. Its database is separate from workspace/runtime data.
`PLUGIN_APP_ORIGIN` is the hosted Zuse app that receives web OAuth returns;
`API_PUBLIC_ORIGIN` determines provider callback URLs. Keep these canonical
origins HTTPS and keep the app in `ALLOWED_BROWSER_ORIGINS`.

Install a **new, dedicated** random 32-byte base64url AES key as the API Worker's
`PLUGIN_ENCRYPTION_KEY` secret using Wrangler. Use separate keys for staging and
production, store recoverable copies in the deployment secret manager, and never
commit or print them. The service stays unavailable until the key and app origin
are configured. Deploy through the repository's usual guarded API workflow.
No D1 database or external Executor account is required.
The fixed catalog runs through a Zuse-owned v2 runtime adapter: no dynamic
Worker Loader, R2 build bucket or Postgres database is needed for plugins.

The Durable Object's internal schema marker is now `2`; `plugins-v1` remains the
Wrangler class-creation migration tag, not an Executor schema version. Existing
v1 objects fail closed before running v2 SQL migrations. The first staging
deployment on 2026-10-03 used a fresh plugin namespace; see the
[deployment record](deployments/2026-10-03-managed-plugins.md). If an
earlier build was deployed elsewhere, preserve that data and plan an explicit
conversion before deploying; never clear a namespace or initialize over it.

Do not replace this key on a running deployment without migrating stored
ciphertexts: doing so makes existing credentials and pending OAuth attempts
unreadable. Back up the key alongside the Durable Object data.

## Ownership and access

Plugins follow the selected workspace: `personal:<accountId>` or
`organization:<orgId>`. The API verifies current organization membership through
its existing workspace authorization service; a token organization claim alone
cannot grant access. Organization members can discover and invoke shared
connections; admins connect, toggle, disconnect and finish OAuth attempts.
Personal connections remain private and are never copied or used by an
organization machine. Connect the service separately in the organization.

New organization connections are marked organization-owned. The vault retains
the connecting subject's existing SDK owner and reference keys while exposing
those connections within that tenant, so another member or its runtime can use
them without relocating credentials. Legacy organization connections marked
user-owned remain private to their original subject; reconnect explicitly to
create an organization-owned connection. Personal keys, ciphertexts, pending
attempt ownership and storage namespaces remain unchanged.

Cloud agent tool routes derive the tenant from the authenticated workspace's
persisted owner, never from a caller's supplied tenant or creator identity. They
retain runtime expiry and deletion fences. Personal local sessions remain bound
to the account active when their agent handle is created; changing accounts
invalidates that handle's plugin access. The Plugins page, settings toggles and
composer mentions use the same workspace tenant and tenant-keyed cache; delayed
responses cannot replace the selected workspace's snapshot.

Provider secrets are encrypted with v2's AES-GCM adapter in Durable Object SQLite.
HKDF derives a per-object credential key from the configured secret; authenticated
data binds each envelope to its SDK resource ID. Pending OAuth attempt data
uses encrypted KV bound to its object and storage key. A per-tenant queue
serializes SDK operations, token refresh, disconnect, callbacks, and expiry
cleanup. SDK SQL transactions use the upstream Effect Durable Object SQLite driver;
remote mutations and Zuse metadata are not a distributed transaction. Metadata fences
prevent partially deleted/failed connections from being invoked. In-flight
external actions cannot be undone by disconnect.

## Catalog

`plugin-catalog.data.ts` is generated from the public
[integrations.sh feed](https://integrations.sh/api.json) that Executor's catalog
uses. From `infra/api`, run `bun scripts/generate-plugin-catalog.ts` (or pass
`--input <feed.json>`) and review the diff. The generator keeps remote MCP
entries with an HTTPS `connectUrl`, drops entries listed only by the
`discovered` feed, dedupes by URL (curated, then Claude, then OpenAI, then
popularity), and applies Executor's query defaults (`mode=tools` for PostHog,
`codemode=false` for `mcp.cloudflare.com`) while keeping the original URL as
the OAuth discovery URL. It pins `linear` and `cloudflare` (Cloudflare Docs) to
their original names, endpoints, auth and scopes, marks a short hand-picked list
as featured, and orders featured entries first, then by popularity. Clients only
receive display metadata; endpoints stay server-owned.

Changing an existing entry's name, endpoint, discovery URL or scopes changes its
build source (see below). Existing connections to it then need reconnection.

## Outbound policy

`plugin-egress.ts` is the single policy for MCP endpoints, OAuth metadata,
token calls and authorization URLs: HTTPS, no userinfo, default port, and a
dotted public hostname. IP literals, `localhost`, `*.localhost`, `*.local`,
`*.internal` and single-label hosts are rejected. Redirects are never followed.
There is no per-provider origin allowlist.

## Auth detection

The feed's `auth.kind` (`oauth` or `none`) is used when present. Otherwise
connecting sends one anonymous MCP `initialize` (10 s timeout, same policy):
2xx means public, 401/403 means OAuth. The resolved auth is stored in the
connection's engine reference, so restarts never re-probe. Connect failures
remove the attempt and connection and return a stable `{ error }` code:

- `plugin_client_registration_unsupported`: the OAuth server has no dynamic
  client registration and needs a pre-registered client.
- `plugin_auth_unsupported`: no usable OAuth metadata, or an unexpected probe
  status.
- `plugin_unreachable`: the probe failed, timed out, or got 429/5xx.
- `plugin_operation_failed`: anything else.

The desktop control-plane client currently maps every unknown 400 code to
`CloudWorkspaceOpError` `invalid-request`; distinguishing these in the UI needs
a contract change.

## OAuth return

OAuth uses Zuse client branding and PKCE. Callback state maps to a server-stored
owner. The connect request's `returnTo` is stored on the attempt. The callback
stores the full provider response encrypted, then redirects an opaque one-use
ticket with `plugin_ticket`, `plugin_tenant` and `plugin` (display name) to
`http://127.0.0.1:<port>/plugins/callback` for desktop returns (ports from
`PLUGIN_CALLBACK_PORTS` only, checked again when redirecting) or to
`PLUGIN_APP_ORIGIN` otherwise. A provider `error` cancels the attempt and
redirects to the same target with `plugin_error=cancelled`.

The app completes the ticket automatically. The ticket only reaches the browser
that finished consent, and completion requires the subject that started the
attempt, so another account cannot finish a forwarded link. Completion replays
the stored response to Executor, which validates state, issuer and duplicate
parameters. Attempts expire after ten minutes; alarms cancel expired attempts
and purge terminal attempts after a day. Closing/reopening Plugins resumes
pending attempt polling from the server. There is no automatic tool-call retry
at the Zuse HTTP boundary.

The stable tenant MCP endpoint is
`/v1/plugins/<encoded-tenant-id>/mcp`; it requires a verified WorkOS bearer and
matching tenant membership. Zuse itself uses the authenticated tools routes
through its session gateway, so users do not copy URLs or tokens.

## Agents and UI

Plugins is a main page reached from the sidebar, below New chat and New
project. It contains the searchable catalog and connection management. Plugin details let
users name and connect additional accounts, and disconnect each independently.
Composer plugin mentions select an enabled connection and carry its exact tool
address prefix; queued-message editing preserves that connection ID. Legacy
plugin-wide mentions remain readable. OAuth
returns are redeemed automatically (no confirmation click) and reported with a
toast. Linear is provided only as a managed plugin; the former per-computer
Linear integration (Settings → Integrations) has been removed. Connection data is loaded through the selected workspace’s control-plane RPC,
independently of the active runtime connection.

The shared session gateway exposes `plugins_search`, `plugins_schema`, and
`plugins_call`. Invocation follows Zuse's permission policy; plan mode blocks
calls conservatively. Provider elicitation and additional engine approval are
not automatically accepted. No v2 management or automation tools enter the agent
catalog. Search matches catalog service names as well as IDs and account labels,
including spacing/punctuation variants; an empty search means no matching tools,
so agents should use `plugins_list` before concluding no connections exist.

Each connection owns an SDK app/profile and, when authenticated, an account.
The SDK owner derives from both the tenant and subject. Every tool operation
rechecks app/profile ownership; no browser-supplied SDK IDs select credentials.
Disconnect removes the app and saved account. Cleanup also reads the SDK's
completed connection state, so an interrupted Zuse metadata write cannot leave
the newly created account's credentials behind.

Claude, Codex, Gemini, Grok, and Kiro use the existing shared gateway. Cursor
receives an additional session MCP server; both OpenCode drivers receive remote
MCP configuration in their process environment. Pi receives a temporary native
tool extension with a revocable loopback credential, removed on teardown. No
upstream tokens are installed in any agent runtime.

## Verification

From `infra/api`:

```sh
bunx vitest run test/integration/plugin-vault.test.ts test/unit/plugin-routes.test.ts test/unit/plugin-mcp.test.ts
bun run check-types
bunx wrangler deploy --dry-run --outdir ../../.context/plugin-worker-build
```

Worker tests exercise real workerd, SQLite, encryption, and the embedded SDK
against deterministic upstream HTTP fixtures. They cover Worker restart,
subject/tenant isolation, discovery, calls, disconnect, OAuth PKCE and branded
DCR, confirmation ownership, replay rejection, cancellation, multiple connections,
token refresh, failed exchange cleanup, account removal, auth probing, lazy
registration and legacy references across restarts, unsupported-provider codes,
and desktop/web return redirects. `test/unit/plugin-catalog.test.ts` and
`plugin-egress.test.ts` cover generator invariants, the outbound policy and the
probe. Agent tests
cover permission denial/approval before invocation. These are not live provider
consent tests. After staging deployment, connect with a real account, return to
the app, invoke from desktop and cloud, then disconnect and verify
access is gone before promoting production.

The renderer browser regression is `bun run test:plugins-browser` from
`apps/renderer`. It mounts the production components against a deterministic
control-plane fixture and verifies automatic return redemption, browse, search,
connect, connection details, disconnect, the OAuth pending state, and the
connected tab. Set `PLUGINS_SCREENSHOT_DIR` to capture screenshots. It does not require a live WorkOS account.

## Updating the v2 adapter

`packages/executor-v2` exposes a small Promise API. Its generated bundle includes
the private v2 SDK's pinned Effect snapshot; Zuse keeps Effect beta.102. The
checksummed upstream source archive and isolated Bun toolchain lockfile are
checked in. Runtime code never imports a research checkout or downloads source.

From `packages/executor-v2`, run `bun run build` after adapter changes, then
`bun run check-types`. The latter typechecks the adapter plus reachable upstream
source and independently rebuilds the bundle to detect stale generated output.
Both commands install the locked build dependencies in a temporary directory
outside the monorepo. Normal API builds consume the checked-in bundle directly.
Upstream's Effect and JSON-schema patches are retained in `toolchain/patches`.

Definitions are registered lazily, memoized per (plugin, auth), so Durable
Object cold starts do not process the whole catalog. Engine references carry
`plugin` and `auth`; every SDK operation registers that definition before
dispatching to its build. References written before lazy registration fall
back to the connection's plugin id and the catalog's fixed auth. The source
shape `{protocol, id, name, endpoint, auth, scopes}` (plus `oauthDiscovery`
when set) is unchanged for existing entries, so earlier build IDs stay valid.
The runtime matches retained source against the catalog's rendering;
build IDs hash that source. Changing a definition cannot silently execute the
new definition under an old build ID. Existing connections to a changed
definition need a deliberate migration or reconnection. Source retention uses
immutable, content-addressed KV snapshots because Zuse does not expose app
editing or source publication in this scope.
