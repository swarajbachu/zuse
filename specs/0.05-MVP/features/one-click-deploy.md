# Feature: One-Click Deploy

Publish the active worktree's app from the top bar: frontend to Vercel under
`<slug>.zuse.app` (on Zuse's Vercel team, provisioned programmatically),
backend to Convex in the **user's own** Convex team (authorized once via
Convex's platform OAuth). Logs stream into a right-pane **Deploy** panel; on
success a URL chip opens the live site in the in-app browser pane; on failure
the error is handed to the agent so it can fix and redeploy.

See ADR 0022 for the hosting-model decision.

## Why this exists

Agents can build a full-stack app in a worktree in minutes, but "get it on
the internet" still means leaving Zuse: accounts, CLIs, env vars. Lovable/v0
proved the bar is one click to a live URL. Zuse already has every ingredient —
WorkOS identity, keychain secrets, a PKCE OAuth flow, an in-app browser to
show the result, and an agent that can react to build failures.

## Architecture (the one hard fact)

> **The desktop never holds Vercel credentials; it holds the user's Convex
> token.**

Managed publishing needs Zuse's Vercel team token, which cannot ship inside a
decompilable Electron binary. So all Vercel calls (and the Convex OAuth token
exchange, which needs the app's `client_secret`) go through a small cloud
service, authenticated by the user's WorkOS access token:

```
Renderer  Deploy button / Deploy panel / browser pane
   │  deploy.* RPCs (packages/wire)
   ▼
DeployService (apps/server/src/deploy/)
   detect ─► convex provision + `npx convex deploy` (user's team,
   │         token from keychain `convex:oauth`)
   ├─► collect files (git ls-files) ─► deploy-proxy ─► Vercel (build) ─► poll
   └─► events: Mailbox<DeployEvent> ─► deploy.events stream ─► panel log
   history: SQLite `deployments` / `deploy_projects` (migration 0021)

deploy-proxy (apps/deploy-proxy — Hono on Cloudflare Workers)
   holds VERCEL_TEAM_TOKEN + CONVEX_OAUTH_CLIENT_SECRET
   WorkOS JWKS auth · per-user quotas (KV) · project→user ownership map
```

## Deploy state machine

| Status | Meaning |
|---|---|
| `queued` | Row inserted, pipeline forked |
| `detecting` | Framework + Convex detection in the worktree |
| `convex_provisioning` | Ensure Convex project + deploy key (skipped when no `convex/`) |
| `convex_deploying` | `npx convex deploy` streaming |
| `collecting` | `git ls-files` + sha1 + limits (≤5,000 files, ≤100 MB) |
| `uploading` | Inline (<15 MB total) or sha-referenced upload via proxy |
| `building` | Vercel server-side build; proxy polled every 3 s |
| `ready` | Live at `https://<slug>.zuse.app` |
| `failed` | Any phase; `error_summary` + ~8 KB `log_tail` persisted |
| `canceled` | Via `deploy.cancel` |

One active run per `(projectId, worktreeId)`; a second `deploy.start` fails
with `DeployAlreadyRunningError`.

## Wire contract (`deploy.*`)

| RPC | Shape |
|---|---|
| `deploy.detect` | `{folderId, worktreeId}` → `DeployDetection` (framework, hasConvex, rootDir, packageManager, warnings) |
| `deploy.start` | `{folderId, worktreeId}` → `Deployment` (queued row) |
| `deploy.events` | stream; seeds latest snapshot + accumulated log, then live `DeployLogEvent` (full-log replace, like worktree setup) / `DeployStatusChangedEvent` |
| `deploy.cancel` | `{deploymentId}` → void |
| `deploy.history` | `{folderId, limit?}` → `Deployment[]` |
| `deploy.lastFailure` | `{folderId, worktreeId}` → `{errorSummary, logTail, url} \| null` — agent/"Fix with agent" consumption |
| `deploy.convexStatus` / `connectConvex` / `disconnectConvex` | ConvexConnection management |

## Convex OAuth flow

Mirrors the WorkOS login flow (PKCE S256, system browser, loopback):

1. `deploy.connectConvex` → authorize URL on
   `dashboard.convex.dev/oauth/authorize/team` opened via `AuthShell.open`.
2. Callback: `http://localhost:8976/convex/callback` in both dev and packaged
   builds — Convex rejects custom-scheme redirect URIs, so this is a second
   sink on the existing loopback server in `apps/desktop/src/main.ts`.
3. Code exchange via proxy `POST /v1/convex/oauth/token` (the proxy adds
   `client_secret`).
4. Token bundle → keychain `convex:oauth`. Management API calls
   (`create_project`, `create_deploy_key`, `token_details`) then go
   desktop → `api.convex.dev/v1` directly; only the exchange is proxied.
5. Tokens have no documented refresh; on 401 the user reconnects
   (`ConvexAuthRequiredError` → "Connect Convex" CTA in the panel).

## Deploy-proxy endpoints

| Endpoint | Purpose |
|---|---|
| `POST /v1/convex/oauth/token` | Token exchange (adds client secret) |
| `POST /v1/vercel/projects` | Idempotent ensure: name `zuse-<userHash8>-<slug>`, assign `<slug>.zuse.app`, record ownership |
| `POST /v1/vercel/files` | SHA1-keyed passthrough to Vercel `/v2/files` |
| `POST /v1/vercel/deployments` | Ownership check → upsert `CONVEX_URL` env → `POST /v13/deployments` |
| `GET /v1/vercel/deployments/:id` | Status; on `ERROR` also a ~4 KB `buildLogTail` |
| `GET /v1/quota` | `{deploysUsedToday, deployLimit, projectsUsed, projectLimit}` |

Quotas (KV): 10 projects/user, 30 deploys/user/day, 100 MB/deploy → 429
`{quotaExceeded: true}`.

## UI

- **Top bar**: Deploy button next to CI status (GlassActionButton pattern);
  a status chip mirroring `CiStatus` — spinner while running, green when
  live (click → URL opens in the browser pane), red when failed (click →
  reveal panel).
- **Deploy panel**: new singleton right-pane panel (like Browser/Changes):
  header (status, Deploy/Cancel, "Connect Convex" CTA when needed), live
  autoscrolled log, history list with URL links and **Fix with agent** on
  failed rows (injects a chat message with phase, summary, log tail).
- Success/failure toasts via `toastManager`; hugeicons bulk-rounded,
  `text-muted-foreground`, no accent colors.

## Non-goals (v1)

- Custom domains (migration path lives in the proxy; see ADR 0022).
- Per-PR preview deployments, rollbacks, deploy environments.
- Monorepo app-picker UI — a heuristic picks the first frontend workspace
  and surfaces a warning.
- Non-Node frameworks; BYO Vercel accounts.

## Key files

| Purpose | Path |
|---|---|
| Wire contract | `packages/wire/src/deploy.ts` |
| Orchestrator | `apps/server/src/deploy/layers/deploy-service.ts` |
| Convex OAuth | `apps/server/src/deploy/layers/convex-auth-service.ts` |
| Detection / files | `apps/server/src/deploy/layers/framework-detect.ts`, `file-collector.ts` |
| Proxy client | `apps/server/src/deploy/layers/deploy-proxy-client.ts` |
| Convex provision | `apps/server/src/deploy/layers/convex-provision.ts` |
| Proxy service | `apps/deploy-proxy/src/` |
| Migration | `apps/server/src/persistence/migrations/0021_deployments.ts` |
| Panel | `apps/renderer/src/components/deploy-pane.tsx` |
| Top bar | `apps/renderer/src/components/top-bar.tsx` |

## How to verify

1. Proxy standalone: `bun dev` in `apps/deploy-proxy`; curl without a WorkOS
   token → 401; project ensure idempotent; 31st deploy of the day → 429.
2. Connect Convex: panel CTA → browser consent (team authorize page) →
   keychain gains `convex:oauth`; disconnect clears it.
3. Demo: fresh Next.js project → Deploy → statuses walk to `ready` with live
   log → URL chip opens `https://<slug>.zuse.app` in the browser pane.
4. Failure: break the build → `failed` + log tail → "Fix with agent" → agent
   patches → redeploy reuses the same project/subdomain.
5. Restart mid-build → history row survives; boot sweep fails runs stuck
   >30 min. Parallel `deploy.start` → `DeployAlreadyRunningError`.
