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
- `migrations/postgres/0001_init.sql` — schema, applied at **deploy** time (not Worker boot).

## Endpoints
| Method + path | Auth | Purpose |
|---|---|---|
| `POST /v1/client/environment-link-challenges` | WorkOS bearer | issue a link nonce |
| `POST /v1/client/environment-links` | WorkOS bearer | verify Ed25519 proof, mint env credential |
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
1. **Mint the relay Ed25519 keypair** (JWK), keep the private key secret:
   ```
   node -e "const {generateKeyPair,exportJWK}=require('jose');generateKeyPair('EdDSA',{extractable:true}).then(async k=>{console.log('PRIVATE',JSON.stringify(await exportJWK(k.privateKey)));console.log('PUBLIC',JSON.stringify(await exportJWK(k.publicKey)))})"
   ```
   Put the public JWK in `wrangler.jsonc` `RELAY_MINT_PUBLIC_JWK`; set the private one:
   `bunx wrangler secret put RELAY_MINT_PRIVATE_JWK`.
2. **PlanetScale**: create a Postgres database, apply `migrations/postgres/0001_init.sql`
   (`psql "$CONNECTION_STRING" -f migrations/postgres/0001_init.sql`).
3. **Hyperdrive**: `bunx wrangler hyperdrive create zuse-relay-db --connection-string="postgres://…"`
   and paste the id into `wrangler.jsonc`.
4. **WorkOS**: set `WORKOS_JWKS_URL` (`https://api.workos.com/sso/jwks/<client_id>`) and `WORKOS_ISSUER`.
5. `bunx wrangler deploy`.

## Notes
- Link proofs are **Ed25519** (asymmetric): the desktop holds the private key and sends
  its public key at link; the relay verifies every proof against it. HMAC was rejected —
  the relay never sees the desktop's secret, so it can't verify a symmetric signature.
- Migrations run at **deploy**, never on Worker cold-start.
