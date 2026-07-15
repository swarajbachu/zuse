import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import { Pool, type PoolConfig } from "pg";
import { AccountIdentityLive } from "./account-identity.ts";
import * as Config from "./config.ts";
import { makeRelay } from "./index.ts";
import { ManagedTunnelProviderLive } from "./managed-tunnel.ts";
import { PushDeliveryLive } from "./push.ts";
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
	readonly WORKOS_API_KEY?: string;
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

export const hyperdrivePoolConfig = (connectionString: string): PoolConfig => ({
	connectionString,
	max: 1,
	connectionTimeoutMillis: 5_000,
});

const build = (env: Env): ReturnType<typeof makeRelay> => {
	const configLayer = Config.layer({
		relayIssuer: env.RELAY_ISSUER,
		workosJwksUrl: env.WORKOS_JWKS_URL,
		workosIssuer: env.WORKOS_ISSUER,
		workosApiKey: configured(env.WORKOS_API_KEY)
			? Redacted.make(env.WORKOS_API_KEY)
			: undefined,
		mintPrivateKey: Redacted.make(env.RELAY_MINT_PRIVATE_JWK),
		mintPublicKey: env.RELAY_MINT_PUBLIC_JWK,
		managedTunnel: managedTunnelConfig(env),
	});
	const dbLayer = PgClient.layerFrom(
		PgClient.fromPool({
			acquire: Effect.acquireRelease(
				Effect.sync(
					() => new Pool(hyperdrivePoolConfig(env.HYPERDRIVE.connectionString)),
				),
				(pool) => Effect.promise(() => pool.end()),
			),
		}),
	);
	const appLayer = Layer.mergeAll(
		configLayer,
		WorkosVerifierLive.pipe(Layer.provide(configLayer)),
		AccountIdentityLive.pipe(Layer.provide(configLayer)),
		RelayStorePg.pipe(Layer.provide(dbLayer)),
		ManagedTunnelProviderLive.pipe(Layer.provide(configLayer)),
		PushDeliveryLive,
	).pipe(Layer.orDie);
	return makeRelay(appLayer);
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Cloudflare recommends request-scoped database clients for Hyperdrive.
		// A shared max-one pool stranded concurrent mobile auth requests.
		const relay = build(env);
		try {
			return await relay.fetch(request);
		} finally {
			await relay.dispose();
		}
	},
};
