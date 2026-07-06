import { PgClient } from "@effect/sql-pg";
import { Layer, Redacted } from "effect";

import * as Config from "./config.ts";
import { makeRelay } from "./index.ts";
import { ManagedTunnelProviderLive } from "./managed-tunnel.ts";
import { RelayStorePg } from "./store.ts";
import { WorkosVerifierLive } from "./workos.ts";

/**
 * Cloudflare Worker bindings. Secrets (`RELAY_MINT_PRIVATE_JWK`) are set via
 * `wrangler secret put`; the rest are `vars` in wrangler.jsonc. `HYPERDRIVE`
 * is the Hyperdrive binding fronting PlanetScale Postgres.
 */
interface Env {
  readonly HYPERDRIVE: { readonly connectionString: string };
  readonly RELAY_ISSUER: string;
  readonly WORKOS_JWKS_URL: string;
  readonly WORKOS_ISSUER: string;
  readonly RELAY_MINT_PRIVATE_JWK: string;
  readonly RELAY_MINT_PUBLIC_JWK: string;
  // Managed Cloudflare tunnel (optional — absent disables provisioning).
  readonly CF_API_TOKEN?: string;
  readonly CF_ACCOUNT_ID?: string;
  readonly CF_ZONE_ID?: string;
  readonly MANAGED_TUNNEL_BASE_DOMAIN?: string;
  readonly MANAGED_TUNNEL_NAMESPACE?: string;
}

const configured = (value: string | undefined): value is string =>
  value !== undefined &&
  value.trim().length > 0 &&
  !value.trim().startsWith("REPLACE_WITH");

const managedTunnelConfig = (
  env: Env,
): Config.ManagedTunnelConfig | undefined => {
  if (
    !configured(env.CF_API_TOKEN) ||
    !configured(env.CF_ACCOUNT_ID) ||
    !configured(env.CF_ZONE_ID) ||
    !configured(env.MANAGED_TUNNEL_BASE_DOMAIN) ||
    !configured(env.MANAGED_TUNNEL_NAMESPACE)
  ) {
    return undefined;
  }
  return {
    cfApiToken: Redacted.make(env.CF_API_TOKEN),
    cfAccountId: env.CF_ACCOUNT_ID,
    cfZoneId: env.CF_ZONE_ID,
    baseDomain: env.MANAGED_TUNNEL_BASE_DOMAIN,
    namespace: env.MANAGED_TUNNEL_NAMESPACE,
  };
};

// Build the runtime once per isolate, not per request.
let relay: ReturnType<typeof makeRelay> | undefined;

const build = (env: Env): ReturnType<typeof makeRelay> => {
  const configLayer = Config.layer({
    relayIssuer: env.RELAY_ISSUER,
    workosJwksUrl: env.WORKOS_JWKS_URL,
    workosIssuer: env.WORKOS_ISSUER,
    mintPrivateKey: Redacted.make(env.RELAY_MINT_PRIVATE_JWK),
    mintPublicKey: env.RELAY_MINT_PUBLIC_JWK,
    managedTunnel: managedTunnelConfig(env),
  });
  const dbLayer = PgClient.layer({
    url: Redacted.make(env.HYPERDRIVE.connectionString),
  });
  const appLayer = Layer.mergeAll(
    configLayer,
    WorkosVerifierLive.pipe(Layer.provide(configLayer)),
    RelayStorePg.pipe(Layer.provide(dbLayer)),
    ManagedTunnelProviderLive.pipe(Layer.provide(configLayer)),
  ).pipe(Layer.orDie);
  return makeRelay(appLayer);
};

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    relay ??= build(env);
    return relay.fetch(request);
  },
};
