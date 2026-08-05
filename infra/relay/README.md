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
| `DELETE /v1/account` | WorkOS bearer | delete relay data, tunnels, devices, and the identity account |
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

## Deploy

The tracked default workflow is staging-only:

```sh
bun run dev
bun run deploy
```

Staging is the unnamed Wrangler default, so these commands and even an
unqualified `wrangler deploy` use the `zuse-relay-staging` Worker,
`relay-staging.stuff.md`, a separate Hyperdrive binding, the `zenv-staging`
tunnel namespace, sandbox billing, manual entitlements, and the fake machine
provider. The secret scripts in this package also target staging by default.

An intentional production deployment is guarded and requires both the explicit
script and confirmation value:

```sh
ZUSE_CONFIRM_PRODUCTION_RELAY_DEPLOY=deploy-relay.stuff.md \
	bun run deploy:production
```

Production lives in a separate `wrangler.production.jsonc` file that ordinary
commands never read. The guarded script is the only approved entry point.
Audit production secret names read-only with
`wrangler secret list --config wrangler.production.jsonc`. Never delete or
replace a production binding during staging work; removing an accidental legacy
binding requires separate, explicit approval.

### Deployment prerequisites (Cloudflare + Postgres)
1. **Mint the relay Ed25519 keypair** (JWK) — run from `infra/relay` (where `jose`
   is a dependency; a bare `node -e` from the repo root can't resolve it):
   ```
   node scripts/mint-keys.mjs
   ```
   Put the printed PUBLIC JWK in `wrangler.jsonc` `RELAY_MINT_PUBLIC_JWK`; set the
   PRIVATE one as a secret. The package secret script targets staging; set an
   explicit production secret only during an approved production operation.
2. **Postgres**: copy `.env.example` → `.env`, set `DATABASE_URL`, then apply
   migrations:
   ```
   bun run db:migrate
   ```
   This is staging-only and validates the configured Neon host and database name
   before Drizzle runs. Production migrations are intentionally not scripted
   until an approved production database identity can be pinned and reviewed.
3. **Hyperdrive**: `bunx wrangler hyperdrive create zuse-relay-db --connection-string="postgres://…"`
   and paste the id into `wrangler.jsonc`.
4. **WorkOS**: set `WORKOS_JWKS_URL` (`https://api.workos.com/sso/jwks/<client_id>`) and `WORKOS_ISSUER`. Set the server-side account-deletion key with `bun run secret:workos` (`wrangler secret put WORKOS_API_KEY`); the mobile deletion flow deliberately fails closed when this secret is absent.
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
6. **Polar sandbox billing**:
   - Create the recurring machine product in Polar sandbox and place its product
     ID in `POLAR_PRODUCT_PERSISTENT_STANDARD_V1`.
   - Set `POLAR_ENVIRONMENT` to `sandbox`, then store the sandbox access token
     with `bun run secret:polar` and the endpoint signing secret with
     `bun run secret:polar-webhook`.
   - Add a webhook endpoint at
     `https://<relay-host>/v1/billing/webhook/polar` for subscription created,
     updated, active, past due, canceled, revoked, and uncanceled events.
   - Keep `MACHINE_LIVE_CHECKOUT_ENABLED` false while using manual alpha
     entitlements. Production checkout also requires
     `POLAR_VPS_SALES_APPROVED=true`; sandbox checkout never accepts real money
     and does not use the approval flag. This switch gates new checkout only;
     signed webhooks and the customer portal remain available for existing
     subscriptions.
7. **Live machine provider**:
   - Keep `MACHINE_PROVIDER=fake` for local and sandbox-only lifecycle tests.
   - Live adapters are discovered through the module catalog in
     `src/machine-provider-config.ts`. Every configured adapter remains
     registered for reconciliation; `MACHINE_PROVIDER` selects only the
     default used for new machines.
   - Staging a provider secret does not activate its adapter. Set
     `HETZNER_ADAPTER_ENABLED=true` only when a complete runtime channel is
     configured and existing machines from that provider must remain
     reconcilable while another provider is the default.
   - For Hetzner provisioning, set `MACHINE_PROVIDER=hetzner`,
     `HETZNER_SERVER_TYPE_PERSISTENT_STANDARD_V1`, `HETZNER_IMAGE`,
     `HETZNER_LOCATION`, and the ID of a pre-created zero-inbound-rule
     firewall in `HETZNER_FIREWALL_ID`. `HETZNER_API_BASE_URL` defaults to the
     official Cloud API endpoint.
   - Set `MACHINE_RUNTIME_MANIFEST_URL`,
     `MACHINE_RUNTIME_SIGNING_PUBLIC_JWK`, and
     `MACHINE_RUNTIME_INSTALL_COMMAND` to the published, signed Linux runtime
     channel. Store the project API token with `bun run secret:hetzner`.
   - The Worker refuses to start the live adapter when any setting is missing,
     the firewall ID is invalid, a URL is not HTTPS, or the signing JWK is not
     valid JSON. Production checkout remains disabled while the fake adapter is
     selected.
8. Deploy staging with `bun run deploy`. Point development clients at
   `https://relay-staging.stuff.md` (`VITE_ZUSE_RELAY_URL`).

## Test managed machines

For the technical alpha without taking payment, allowlist the WorkOS account
ID, set `MACHINE_MANUAL_ENTITLEMENTS` to `true`, leave both paid-checkout flags
false, and run the relay. Creating `persistent-standard-v1` then issues a
31-day manual entitlement and exercises the machine lifecycle without calling
Polar.

For a sandbox billing test, configure Polar as above, keep the machine-provider
side in its fake configuration, set `MACHINE_LIVE_CHECKOUT_ENABLED=true`, and
leave `POLAR_VPS_SALES_APPROVED=false`. Call the checkout endpoint as an
allowlisted account and complete the hosted checkout with Polar's sandbox test
payment details. The signed webhook should create the entitlement; confirm it
through `GET /v1/billing/entitlements`. An active subscription webhook now
atomically creates the one allowed machine and immediately schedules its first
reconciliation pass; no separate machine-create call is required. Return
`MACHINE_LIVE_CHECKOUT_ENABLED` to false after the test.

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
