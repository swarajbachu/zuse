# ADR 0003: Name the hosted control plane API

- Status: Accepted
- Date: 2026-08-27
- Supersedes: Relay terminology in ADR 0001 and ADR 0002

## Context

The hosted control plane exposes versioned HTTP endpoints, a WebSocket gateway,
managed-tunnel coordination, runtime enrollment, and provider callbacks. The
product and code previously called this component Relay, while customers and
operators reached it through `relay.stuff.md`. That name obscured its broader
control-plane role and left production on a non-product domain.

## Decision

1. **The component is the Zuse API.** Current source, contracts, configuration,
   documentation, logs, and persisted schema use API terminology.
2. **The canonical origins are environment-specific.** Production uses
   `https://api.zuse.sh`; staging uses `https://api-staging.stuff.md`. The old
   origins are removed without aliases, and token issuers change with them.
3. **Wire paths stay versioned and stable.** Existing `/v1/...` HTTP and
   WebSocket paths do not change as part of the naming cutover.
4. **Persistence is renamed without consolidation.** Current Postgres tables,
   indexes, constraints, and sequences use the `api_` prefix. The local
   connection table is `api_config`. Historical migration files retain their
   original names and contents.
5. **Infrastructure identity stays stable where replacement loses state.** The
   Cloudflare Worker IDs remain `zuse-relay` and `zuse-relay-staging` so Worker
   secrets and Durable Object identity are preserved. The existing private mint
   key remains bound as `RELAY_MINT_PRIVATE_JWK`; current code otherwise uses API
   terminology.
6. **One GitHub App serves both environments.** Its Setup URL points to the
   production API. Production forwards only an exact allowlisted staging issuer
   to staging, which independently verifies the signed installation state.

## Consequences

- Clients, runtimes, tokens, persisted connections, and provider callbacks from
  before the cutover are intentionally incompatible until upgraded.
- Historical ADRs describe the component by its name at the time and remain
  immutable; this ADR supplies the current vocabulary.
- Database performance work is driven by measured queries and indexes rather
  than reducing table count at the cost of lifecycle or billing invariants.

## Required verification

- Reject current source terminology that reintroduces Relay outside the
  historical and immutable-infrastructure allowlist.
- Verify issuer, DPoP, enrollment, gateway, GitHub, provider webhook, and billing
  flows against both canonical origins.
- Compare relation and row counts before and after the naming migration and
  confirm that no migration statement drops or truncates data.
