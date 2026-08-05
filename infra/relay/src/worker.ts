import { PgClient } from "@effect/sql-pg";
import { HOSTED_APP_URL } from "@zuse/contracts";
import { Effect, Layer, Redacted } from "effect";
import { Pool } from "pg";
import cloudInitTemplate from "../../cloud-machines/bootstrap/cloud-init.yaml.tmpl";
import { AccountIdentityLive } from "./account-identity.ts";
import { resolveBillingRuntime } from "./billing-config.ts";
import * as Config from "./config.ts";
import { isConfigured } from "./environment.ts";
import { hyperdrivePoolConfig } from "./hyperdrive.ts";
import { makeRelay } from "./index.ts";
import {
	type MachineControlConfig,
	MachineControlConfiguration,
} from "./machine-config.ts";
import { resolveMachineProviderRuntime } from "./machine-provider-config.ts";
import { MachineStorePg } from "./machine-store.ts";
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
	readonly MAX_ENVIRONMENTS_PER_ACCOUNT?: string;
	readonly ALLOWED_BROWSER_ORIGINS?: string;
	// Managed Cloudflare tunnel (optional — absent disables provisioning).
	readonly CF_API_TOKEN?: string;
	readonly CF_ACCOUNT_ID?: string;
	readonly CF_ZONE_ID?: string;
	readonly MANAGED_TUNNEL_BASE_DOMAIN?: string;
	readonly MANAGED_TUNNEL_NAMESPACE?: string;
	readonly MACHINE_ALPHA_ALLOWLIST?: string;
	readonly MACHINE_MANUAL_ENTITLEMENTS?: string;
	readonly MACHINE_LIVE_CHECKOUT_ENABLED?: string;
	readonly POLAR_ACCESS_TOKEN?: string;
	readonly POLAR_ENVIRONMENT?: string;
	readonly POLAR_PRODUCT_PERSISTENT_STANDARD_V1?: string;
	readonly POLAR_VPS_SALES_APPROVED?: string;
	readonly POLAR_WEBHOOK_SECRET?: string;
	readonly MACHINE_PROVIDER?: string;
	readonly HETZNER_ADAPTER_ENABLED?: string;
	readonly HETZNER_API_TOKEN?: string;
	readonly HETZNER_API_BASE_URL?: string;
	readonly HETZNER_FIREWALL_ID?: string;
	readonly HETZNER_IMAGE?: string;
	readonly HETZNER_LOCATION?: string;
	readonly HETZNER_SERVER_TYPE_PERSISTENT_STANDARD_V1?: string;
	readonly MACHINE_RUNTIME_INSTALL_COMMAND?: string;
	readonly MACHINE_RUNTIME_MANIFEST_URL?: string;
	readonly MACHINE_RUNTIME_SIGNING_PUBLIC_JWK?: string;
}

const managedTunnelConfig = (
	env: Env,
): Config.ManagedTunnelConfig | undefined => {
	if (
		!isConfigured(env.CF_API_TOKEN) ||
		!isConfigured(env.CF_ACCOUNT_ID) ||
		!isConfigured(env.CF_ZONE_ID) ||
		!isConfigured(env.MANAGED_TUNNEL_BASE_DOMAIN) ||
		!isConfigured(env.MANAGED_TUNNEL_NAMESPACE)
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

const build = (env: Env): ReturnType<typeof makeRelay> => {
	const billing = resolveBillingRuntime(env);
	const machineProvider = resolveMachineProviderRuntime(env, {
		cloudInitTemplate,
		relayIssuer: env.RELAY_ISSUER,
	});
	const configuredLimit = Number(env.MAX_ENVIRONMENTS_PER_ACCOUNT ?? "5");
	const configLayer = Config.layer({
		relayIssuer: env.RELAY_ISSUER,
		workosJwksUrl: env.WORKOS_JWKS_URL,
		workosIssuer: env.WORKOS_ISSUER,
		workosApiKey: isConfigured(env.WORKOS_API_KEY)
			? Redacted.make(env.WORKOS_API_KEY)
			: undefined,
		mintPrivateKey: Redacted.make(env.RELAY_MINT_PRIVATE_JWK),
		mintPublicKey: env.RELAY_MINT_PUBLIC_JWK,
		maxEnvironmentsPerAccount:
			Number.isInteger(configuredLimit) && configuredLimit > 0
				? configuredLimit
				: null,
		allowedBrowserOrigins: (env.ALLOWED_BROWSER_ORIGINS ?? HOSTED_APP_URL)
			.split(",")
			.map((value) => value.trim())
			.filter((value) => value.length > 0),
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
	const machineConfig: MachineControlConfig = {
		allowlistedAccountIds: new Set(
			(env.MACHINE_ALPHA_ALLOWLIST ?? "")
				.split(",")
				.map((accountId) => accountId.trim())
				.filter((accountId) => accountId.length > 0),
		),
		manualEntitlementsEnabled: env.MACHINE_MANUAL_ENTITLEMENTS === "true",
		liveCheckoutEnabled:
			billing.liveCheckoutEnabled &&
			(env.POLAR_ENVIRONMENT === "sandbox" || machineProvider.productionReady),
		enrollmentTtlMs: 30 * 60 * 1_000,
		recoveryWindowMs: 7 * 24 * 60 * 60 * 1_000,
		finalSnapshotRetentionMs: 14 * 24 * 60 * 60 * 1_000,
		reconcileLeaseMs: 5 * 60 * 1_000,
	};
	const appLayer = Layer.mergeAll(
		configLayer,
		WorkosVerifierLive.pipe(Layer.provide(configLayer)),
		AccountIdentityLive.pipe(Layer.provide(configLayer)),
		RelayStorePg.pipe(Layer.provide(dbLayer)),
		MachineStorePg.pipe(Layer.provide(dbLayer)),
		machineProvider.layer,
		billing.layer,
		Layer.succeed(MachineControlConfiguration, machineConfig),
		ManagedTunnelProviderLive.pipe(Layer.provide(configLayer)),
		PushDeliveryLive,
	).pipe(Layer.orDie);
	return makeRelay(appLayer);
};

export default {
	async fetch(
		request: Request,
		env: Env,
		context: { readonly waitUntil: (promise: Promise<unknown>) => void },
	): Promise<Response> {
		// Cloudflare recommends request-scoped database clients for Hyperdrive.
		// A shared max-one pool stranded concurrent mobile auth requests.
		const relay = build(env);
		let response: Response;
		try {
			response = await relay.fetch(request);
		} catch (error) {
			await relay.dispose();
			throw error;
		}
		const machineId = response.headers.get("x-zuse-reconcile-machine");
		response.headers.delete("x-zuse-reconcile-machine");
		if (machineId === null) {
			await relay.dispose();
			return response;
		}
		context.waitUntil(
			relay
				.reconcileMachine(machineId, `webhook-${crypto.randomUUID()}`)
				.finally(() => relay.dispose()),
		);
		return response;
	},
	async scheduled(
		controller: { readonly scheduledTime: number },
		env: Env,
		context: { readonly waitUntil: (promise: Promise<unknown>) => void },
	): Promise<void> {
		const relay = build(env);
		context.waitUntil(
			relay
				.reconcile(`cron-${controller.scheduledTime}`)
				.finally(() => relay.dispose()),
		);
	},
};
