# @zuse/relay

Thin control-plane relay for the account-based device-discovery model. It links a
WorkOS account to the computers ("environments") that account controls, brokers
short-lived DPoP-bound connect tokens, and tracks presence. **It is never in the
data path** — chat traffic goes directly phone ↔ laptop.

- Runtime: **Cloudflare Workers** (`src/worker.ts`).
- Store: **PlanetScale Postgres via Cloudflare Hyperdrive** (`@effect/sql-pg`).
- Identity: **WorkOS** access tokens (verified against WorkOS JWKS).
- Everything is **Effect**; every record is scoped by the WorkOS account id.

## Layout
- `src/config.ts` — `RelayConfiguration` service (issuer, WorkOS JWKS, Ed25519 mint keypair, TTLs).
- `src/store.ts` — `RelayStore` service: `RelayStorePg` (prod) + `RelayStoreMemory` (tests).
- `src/workos.ts` — `WorkosVerifier`: `WorkosVerifierLive` (JWKS) + `WorkosVerifierTest`.
- `src/crypto.ts` — Ed25519 link-proof verify, DPoP verify, token signing, hashing (jose + WebCrypto).
- `src/auth.ts` — WorkOS gate, DPoP-bound access gate (+ replay consume), env-credential gate.
- `src/handler.ts` — the account-scoped endpoint router.
- `src/index.ts` — `makeRelay(layer)` → a `fetch` handler.
- `drizzle/schema.ts` — Postgres schema (source of truth for migrations).
- `drizzle/migrations/` — generated SQL, applied at **deploy** time via `bun run db:migrate`.

## Endpoints
| Method + path | Auth | Purpose |
|---|---|---|
| `POST /v1/client/environment-link-challenges` | WorkOS bearer | issue a link nonce |
| `POST /v1/client/environment-links` | WorkOS bearer | verify Ed25519 proof, mint env credential, provision managed tunnel |
| `POST /v1/client/environment-unlink` | WorkOS bearer | deprovision the managed tunnel + remove the environment |
| `GET  /v1/environments` | WorkOS bearer | list the account's environments |
| `POST /v1/client/dpop-token` | WorkOS bearer + DPoP | mint a DPoP-bound access token |
| `POST /v1/environments/{id}/status` | DPoP | presence (online/offline) |
| `POST /v1/environments/{id}/connect` | DPoP | mint a short-lived connect token |
| `POST /v1/mobile/devices` | DPoP | register a device for push |
| `POST /v1/environments/{id}/heartbeat` | env credential | presence origin (desktop) |
| `POST /v1/environments/{id}/agent-activity` | env credential | push events (rejects chat data) |

## Test
```
bun test
```
Tests wire `RelayStoreMemory` + `WorkosVerifierTest` and simulate the desktop
(Ed25519) and mobile (ES256 DPoP) clients with `jose` — covering link, presence,
connect, cross-account isolation, proof forgery, and replay rejection.

## Deploy (needs Cloudflare + PlanetScale accounts)
1. **Mint the relay Ed25519 keypair** (JWK) — run from `infra/relay` (where `jose`
   is a dependency; a bare `node -e` from the repo root can't resolve it):
   ```
   node scripts/mint-keys.mjs
   ```
   Put the printed PUBLIC JWK in `wrangler.jsonc` `RELAY_MINT_PUBLIC_JWK`; set the
   PRIVATE one as a secret: `bunx wrangler secret put RELAY_MINT_PRIVATE_JWK`.
2. **PlanetScale**: create a Postgres database, copy `.env.example` → `.env`, set
   `DATABASE_URL`, then apply migrations:
   ```
   bun run db:migrate
   ```
3. **Hyperdrive**: `bunx wrangler hyperdrive create zuse-relay-db --connection-string="postgres://…"`
   and paste the id into `wrangler.jsonc`.
4. **WorkOS**: set `WORKOS_JWKS_URL` (`https://api.workos.com/sso/jwks/<client_id>`) and `WORKOS_ISSUER`.
5. **Managed Cloudflare tunnel** (optional — enables reach-from-anywhere; leave off for LAN-only):
   - In `wrangler.jsonc` set `MANAGED_TUNNEL_BASE_DOMAIN` (the CF zone apex),
     `MANAGED_TUNNEL_NAMESPACE`, `CF_ACCOUNT_ID`, and `CF_ZONE_ID` (the base domain's zone id).
     Keep generated tunnel hostnames one label under the zone, for example
     `zenv-<hash>.stuff.md`; a nested hostname like `zenv-<hash>.t.stuff.md`
     can resolve but fail TLS unless a matching Cloudflare certificate exists.
   - Set the API token secret: `bun run secret:cf` (`wrangler secret put CF_API_TOKEN`). The token
     needs **Account: Cloudflare Tunnel: Edit** + **Zone: DNS: Edit** on that zone.
   - The desktop must have **`cloudflared`** on PATH (`brew install cloudflared`); it runs the
     connector automatically on link and relaunches it on boot.
6. `bunx wrangler deploy`. Point the desktop at the deployed URL (`VITE_ZUSE_RELAY_URL`).

## Notes
- Link proofs are **Ed25519** (asymmetric): the desktop holds the private key and sends
  its public key at link; the relay verifies every proof against it. HMAC was rejected —
  the relay never sees the desktop's secret, so it can't verify a symmetric signature.
- Migrations run at **deploy** via Drizzle (`bun run db:migrate`), never on Worker cold-start.
- **Managed tunnels**: on link the relay creates a per-`(account, environment)` named tunnel,
  pushes its ingress (hostname → the desktop's loopback WS origin), sets a proxied CNAME, and
  returns a connector token the desktop runs `cloudflared` with. Presence/connect then route to
  `wss://<hostname>`. Unlink tears the tunnel + DNS down. Chat bytes never touch the relay —
  the data path is phone ↔ Cloudflare edge ↔ desktop connector.
