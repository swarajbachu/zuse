# ADR 0022 — One-click deploy: managed Vercel frontend, user-owned Convex backend

Date: 2026-07-04
Status: Accepted

## Context

Zuse's agents build web apps in worktrees, but shipping them means leaving
the app: create a Vercel account, install a CLI, wire up a Convex project,
paste env vars. Products like Lovable, v0, and Replit collapse this into one
click — the app appears at `<name>.their-domain.app` seconds after "Publish".
0.05 adds the same: a **Deploy** button in the top bar that takes the active
worktree from source to a live URL.

Two hosting models were on the table per target:

| Model | Frontend (Vercel) | Backend (Convex) |
|---|---|---|
| **BYO account** | User runs `vercel login`; we orchestrate their CLI | User runs `npx convex login`; we orchestrate their CLI |
| **Managed / platform** | We publish to OUR Vercel team under `*.zuse.app` via REST API | We provision projects in THEIR team via Convex platform OAuth |

Facts that shaped the decision:

- **Vercel has no lightweight BYO OAuth.** Third-party access to a user's
  Vercel account requires a reviewed marketplace integration; the only v1-able
  BYO path is driving the `vercel` CLI through a PTY — a flow with login
  prompts, plan questions, and no quota control. Meanwhile the REST API
  supports the full managed path: project-per-tenant, file-upload deployments
  (`POST /v13/deployments`, server-side build, `QUEUED → BUILDING → READY |
  ERROR`), wildcard subdomains with auto-SSL (`POST /v10/projects/{id}/domains`),
  and env vars — the documented "Vercel for Platforms" multi-project pattern
  (Pro plan suffices).
- **Convex has a first-class platform OAuth** (beta): a registered OAuth app
  sends the user to `https://dashboard.convex.dev/oauth/authorize/team`
  (PKCE S256), and the resulting token drives the Management API
  (`api.convex.dev/v1`): `create_project`, `create_deploy_key`,
  `token_details`. Code push stays CLI-shaped by design:
  `CONVEX_DEPLOY_KEY=… npx convex deploy`. This is exactly how
  full-stack builders (e.g. the "Full-Stack" Convex integration in app
  builders) do it — the user keeps their account, data, and bill.
- **A Vercel team token cannot ship in the Electron app.** It grants full
  control of our team; a decompiled binary would leak it. Managed publishing
  therefore requires a server-side component. Likewise Convex's token
  exchange requires the OAuth `client_secret` even with PKCE, so the exchange
  also needs a server side.
- ADR 0021 chose BYOK-only for rerank keys to avoid running a cloud service.
  Deploy is different in two ways: the whole feature *is* publishing to a
  domain we own (there is no serverless-free version of `*.zuse.app`), and
  the proxy surface is tiny (no billing, no data plane — user page traffic
  goes straight to Vercel, not through us).

## Decision

**Hybrid managed/BYO, with a minimal deploy-proxy service.**

1. **Frontend — managed (Option B).** Zuse publishes the user's frontend
   under `<slug>.zuse.app` on Zuse's own Vercel team, provisioned
   programmatically: one Vercel project per (user, Zuse project), file-upload
   deployments (no git coupling), wildcard subdomain assignment, env vars set
   per deploy. Vercel builds server-side, which gives build caching between
   deploys for free via project reuse.
2. **Backend — user-owned via Convex platform OAuth.** The user authorizes
   Zuse's registered Convex OAuth app once (team scope, PKCE, browser
   consent — the same flow Convex-integrated app builders use). Zuse stores
   the application token in the OS keychain and uses it to create projects
   and mint deploy keys in the *user's* team, then runs `npx convex deploy`
   in the worktree with the deploy key. The user owns their data and their
   Convex bill; Zuse owns nothing backend-side.
3. **A new `apps/deploy-proxy` service (Hono, Cloudflare Workers)** is the
   only holder of `VERCEL_TEAM_TOKEN`, `VERCEL_TEAM_ID`, and
   `CONVEX_OAUTH_CLIENT_SECRET`. It:
   - authenticates every call with the user's **WorkOS access token**
     (JWKS verification) — the identity that ties a deploy to a person;
   - proxies the four Vercel operations (ensure project, upload files,
     create deployment, poll status) plus the Convex OAuth token exchange;
   - records project → WorkOS-user ownership and refuses cross-user access;
   - enforces per-user quotas (projects, deploys/day, bytes/deploy) — the
     cost-exposure and abuse-control point.
4. **Desktop keeps zero Vercel credentials.** The Electron app holds only
   the user's own Convex OAuth token and Convex deploy keys, in the keychain
   (`convex:oauth`, `convex:deployKey:<projectId>`), via the existing
   CredentialsService/keytar pattern.

### Implementation details

- Wire: new `deploy.*` RPC group in `packages/wire` (detect / start /
  events-stream / cancel / history / lastFailure / convex connect-status-
  disconnect), typed errors as `Schema.TaggedError`.
- Server: `apps/server/src/deploy/` orchestrator — framework detection
  (Next.js/Vite/Astro + `convex/` presence), file collection via
  `git ls-files` (respects `.gitignore`, drops `.env*`), Convex
  provision/deploy, proxy calls, Vercel status polling; all I/O
  Effect-wrapped; events fan out through a `Mailbox` stream (PTY pattern).
- Convex OAuth reuses the WorkOS PKCE loopback machinery: system browser,
  `http://localhost:8976/convex/callback` in both dev and packaged builds
  because Convex rejects custom-scheme redirect URIs; exchange via the proxy.
- History: `deployments` + `deploy_projects` tables (SQLite migration 0021);
  the `deploy_projects` row caches Vercel/Convex project identity so
  redeploys reuse the same project, subdomain, and build cache.
- Failure surfacing: terminal failures persist an `error_summary` and an
  ~8KB `log_tail`; `deploy.lastFailure` exposes them so the agent can fix
  and redeploy.

### Identity, quotas, and cost exposure

- Every deploy is attributable to a WorkOS user id (JWT `sub`).
- Quota defaults (proxy-enforced, tunable without app releases): 10 projects
  per user, 30 deploys per user per day, 100 MB per deploy.
- Cost exposure is bounded to Vercel build minutes + bandwidth on our team
  for frontends only; Convex compute/storage lands on the user's own team.
  Vercel Pro is sufficient for v1; per-tenant preview URLs (Enterprise) are
  out of scope.

### Migration story

- **Custom domains later**: the proxy already owns domain assignment; a
  `POST /v1/vercel/domains` endpoint + DNS instructions is additive.
- **BYO Vercel later**: a reviewed Vercel marketplace integration can slot
  in as an alternate credential source behind the same DeployService; the
  wire contract doesn't change.
- **Convex is already effectively BYO** — nothing to migrate.

## Alternatives considered

- **BYO Vercel via CLI orchestration (Option A)** — no proxy to build, but
  the worst possible first-run: account signup, CLI login round-trips,
  interactive prompts, and no `zuse.app` URL. Rejected for v1; revisit as
  the custom-domain/power-user path.
- **Fully managed Convex (projects under Zuse's team)** — makes us the
  owner of user data and the Convex bill, couples abuse to our backend
  quota, and fights Convex's own platform design, which pushes per-user
  teams via OAuth. Rejected.
- **Git-based Vercel deployments** — requires pushing user code to a git
  remote we control; slower, leaks code to another system, and the worktree
  may be mid-rebase. File-upload deployments are simpler and match the
  "deploy what's on disk" mental model.
- **Cloudflare Pages instead of Vercel** — cheaper at scale, but weaker
  zero-config framework builds (Next.js SSR specifically) and no equivalent
  of the Platforms multi-project pattern maturity. Vercel first; the proxy
  isolates the choice.
- **Embedding the Vercel token in the desktop app** — rejected outright
  (decompilable binary = leaked team token).
