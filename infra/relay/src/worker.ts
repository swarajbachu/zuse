import { PgClient } from "@effect/sql-pg";
import {
	CLOUD_WORKSPACE_OFFER_ID,
	HOSTED_APP_URL,
	PERSISTENT_STANDARD_OFFER_ID,
	PRODUCTION_RELAY_URL,
} from "@zuse/contracts";
import { Effect, Layer, Redacted } from "effect";
import { Pool } from "pg";
import runtimeInstallerSource from "../../../apps/server/scripts/runtime-updater.mjs";
import cloudInitTemplate from "../../cloud-machines/bootstrap/cloud-init.yaml.tmpl";
import { AccountIdentityLive } from "./account-identity.ts";
import { BetaAccessAllowAll, PostHogBetaAccessLayer } from "./beta-access.ts";
import { resolveBillingRuntime } from "./billing-config.ts";
import { CloudBillingStorePg } from "./cloud-billing-store.ts";
import {
	CloudCredentialVault,
	CloudCredentialVaultLive,
} from "./cloud-credential-vault.ts";
import {
	CloudWorkspaceLaunchIntentCipher,
	CloudWorkspaceLaunchIntentCipherLive,
} from "./cloud-workspace-launch-intent.ts";
import { CloudWorkspaceStorePg } from "./cloud-workspace-store.ts";
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
import {
	resolveSandboxProviderRuntime,
	SandboxOfferConfiguration,
} from "./sandbox-provider-config.ts";
import { RelayStorePg } from "./store.ts";
import { WorkosVerifierLive } from "./workos.ts";

export { WorkspaceGateway } from "./workspace-gateway.ts";

/**
 * Cloudflare Worker bindings. Secrets (`RELAY_MINT_PRIVATE_JWK`) are set via
 * `wrangler secret put`; the rest are `vars` in wrangler.jsonc. `HYPERDRIVE`
 * is the Hyperdrive binding fronting PlanetScale Postgres.
 */
interface Env {
	readonly HYPERDRIVE: { readonly connectionString: string };
	readonly WORKSPACE_GATEWAY: {
		readonly idFromName: (name: string) => unknown;
		readonly get: (id: unknown) => {
			readonly fetch: (request: Request) => Promise<Response>;
		};
	};
	readonly CLOUD_TRANSCRIPTS?: {
		readonly put: (
			key: string,
			value: string,
			options?: { readonly onlyIf?: { readonly etagDoesNotMatch: string } },
		) => Promise<unknown | null>;
		readonly get: (
			key: string,
		) => Promise<{ readonly text: () => Promise<string> } | null>;
		readonly delete: (keys: string | ReadonlyArray<string>) => Promise<unknown>;
		readonly list: (options: {
			readonly prefix: string;
			readonly cursor?: string;
		}) => Promise<{
			readonly objects: ReadonlyArray<{ readonly key: string }>;
			readonly truncated: boolean;
			readonly cursor?: string;
		}>;
	};
	readonly RELAY_ISSUER: string;
	readonly WORKOS_JWKS_URL: string;
	readonly WORKOS_ISSUER: string;
	readonly WORKOS_API_KEY?: string;
	readonly RELAY_MINT_PRIVATE_JWK: string;
	readonly RELAY_MINT_PUBLIC_JWK: string;
	readonly CLOUD_CREDENTIAL_VAULT_KEY?: string;
	readonly CLOUD_WORKSPACE_IDLE_TIMEOUT_MS?: string;
	readonly CLOUD_REPOSITORY_CACHE_MAX_BYTES?: string;
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
	readonly POLAR_PRODUCT_CLOUD_WORKSPACE_STANDARD_V1?: string;
	readonly POLAR_PRODUCT_PERSISTENT_STANDARD_V1?: string;
	/** @deprecated Use POLAR_PRODUCT_CLOUD_WORKSPACE_STANDARD_V1. */
	readonly POLAR_PRODUCT_SANDBOX_STANDARD_V1?: string;
	readonly POLAR_VPS_SALES_APPROVED?: string;
	readonly POLAR_WEBHOOK_SECRET?: string;
	readonly POSTHOG_HOST?: string;
	readonly POSTHOG_PROJECT_TOKEN?: string;
	readonly POSTHOG_CLOUD_BETA_FLAG_KEY?: string;
	readonly POLAR_CLOUD_OVERAGE_METER_ID?: string;
	readonly MACHINE_PROVIDER?: string;
	readonly HETZNER_ADAPTER_ENABLED?: string;
	readonly HETZNER_API_TOKEN?: string;
	readonly HETZNER_API_BASE_URL?: string;
	readonly HETZNER_FIREWALL_ID?: string;
	readonly HETZNER_IMAGE?: string;
	readonly HETZNER_LOCATION?: string;
	readonly HETZNER_SERVER_TYPE_PERSISTENT_STANDARD_V1?: string;
	readonly MACHINE_RUNTIME_MANIFEST_URL?: string;
	readonly MACHINE_RUNTIME_SIGNING_PUBLIC_JWK?: string;
	readonly CLOUD_WORKSPACE_RUNTIME_MANIFEST_URL?: string;
	readonly CLOUD_WORKSPACE_RUNTIME_SIGNING_PUBLIC_JWK?: string;
	readonly E2B_ADAPTER_ENABLED?: string;
	readonly E2B_API_KEY?: string;
	readonly E2B_API_BASE_URL?: string;
	readonly E2B_SANDBOX_DOMAIN?: string;
	readonly E2B_TEMPLATE_ID?: string;
	readonly E2B_TEMPLATE_VERSION?: string;
	readonly E2B_VCPU_COUNT?: string;
	readonly E2B_MEMORY_MIB?: string;
	readonly E2B_WEBHOOK_SECRET?: string;
	readonly CLOUD_BILLING_ENFORCEMENT_ENABLED?: string;
	readonly CLOUD_BILLING_EXPORT_ENABLED?: string;
	readonly CLOUD_BILLING_CUTOVER_AT?: string;
}

const pollE2bLifecycleEvents = async (
	env: Env,
	relay: Pick<
		ReturnType<typeof makeRelay>,
		"hasFinalizedE2bBillingEvent" | "ingestE2bBillingEvents"
	>,
	nowMs: number,
): Promise<number> => {
	if (
		!isConfigured(env.E2B_API_KEY) ||
		!isConfigured(env.CLOUD_BILLING_CUTOVER_AT)
	)
		return 0;
	const cutoverAtMs = Date.parse(env.CLOUD_BILLING_CUTOVER_AT);
	const apiBaseUrl = (env.E2B_API_BASE_URL ?? "https://api.e2b.app").replace(
		/\/+$/u,
		"",
	);
	const recovered: Array<unknown> = [];
	let offset = 0;
	let reachedCutover = false;
	while (!reachedCutover && offset < 10_000) {
		const query = new URLSearchParams({
			limit: "100",
			offset: String(offset),
			orderAsc: "false",
		});
		query.append("types", "sandbox.lifecycle.paused");
		query.append("types", "sandbox.lifecycle.killed");
		const response = await fetch(`${apiBaseUrl}/events/sandboxes?${query}`, {
			headers: { "x-api-key": env.E2B_API_KEY },
		});
		if (!response.ok)
			throw new Error(`E2B lifecycle poll failed: ${response.status}`);
		const payload: unknown = await response.json();
		if (!Array.isArray(payload))
			throw new Error("E2B lifecycle poll was not an array");
		for (const event of payload) {
			if (typeof event !== "object" || event === null) continue;
			const eventRecord = event as Record<string, unknown>;
			const eventId = eventRecord.id;
			if (typeof eventId !== "string") continue;
			const timestamp =
				typeof eventRecord.timestamp === "string"
					? Date.parse(eventRecord.timestamp)
					: Number.NaN;
			if (Number.isFinite(timestamp) && timestamp < cutoverAtMs) {
				reachedCutover = true;
				break;
			}
			const providerExecutionId =
				typeof eventRecord.sandbox_execution_id === "string"
					? eventRecord.sandbox_execution_id
					: typeof eventRecord.sandboxExecutionId === "string"
						? eventRecord.sandboxExecutionId
						: undefined;
			if (await relay.hasFinalizedE2bBillingEvent(eventId, providerExecutionId))
				continue;
			recovered.push(event);
		}
		if (reachedCutover || payload.length < 100) break;
		offset += payload.length;
	}
	if (!reachedCutover && offset >= 10_000)
		console.error("[cloud-billing] E2B recovery exceeded 10,000 events");
	return relay.ingestE2bBillingEvents(recovered.reverse(), nowMs);
};

const positiveInteger = (
	value: string | undefined,
	fallback: number,
	name: string,
) => {
	const parsed = value === undefined ? fallback : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0)
		throw new Error(`${name} must be a positive integer`);
	return parsed;
};

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
	const cloudTranscriptBucket = env.CLOUD_TRANSCRIPTS;
	const billing = resolveBillingRuntime(env);
	const postHogConfigured =
		isConfigured(env.POSTHOG_HOST) &&
		isConfigured(env.POSTHOG_PROJECT_TOKEN) &&
		isConfigured(env.POSTHOG_CLOUD_BETA_FLAG_KEY);
	if (env.RELAY_ISSUER === PRODUCTION_RELAY_URL && !postHogConfigured)
		throw new Error("Production cloud beta access requires PostHog");
	const betaAccessLayer = postHogConfigured
		? PostHogBetaAccessLayer({
				host: env.POSTHOG_HOST as string,
				projectToken: env.POSTHOG_PROJECT_TOKEN as string,
				flagKey: env.POSTHOG_CLOUD_BETA_FLAG_KEY as string,
			})
		: BetaAccessAllowAll;
	const machineProvider = resolveMachineProviderRuntime(env, {
		cloudInitTemplate,
		relayIssuer: env.RELAY_ISSUER,
		runtimeInstallerSource,
	});
	const sandboxProvider = resolveSandboxProviderRuntime(env);
	const sandboxOffer = {
		...sandboxProvider.offer,
		vcpuCount: positiveInteger(
			env.E2B_VCPU_COUNT,
			sandboxProvider.offer.vcpuCount,
			"E2B_VCPU_COUNT",
		),
		memoryMib: positiveInteger(
			env.E2B_MEMORY_MIB,
			sandboxProvider.offer.memoryMib,
			"E2B_MEMORY_MIB",
		),
		...(isConfigured(env.CLOUD_WORKSPACE_RUNTIME_MANIFEST_URL) &&
		isConfigured(env.CLOUD_WORKSPACE_RUNTIME_SIGNING_PUBLIC_JWK)
			? {
					runtimeManifestUrl: env.CLOUD_WORKSPACE_RUNTIME_MANIFEST_URL,
					runtimeSigningPublicJwk:
						env.CLOUD_WORKSPACE_RUNTIME_SIGNING_PUBLIC_JWK,
				}
			: {}),
	};
	const availableSandboxProviderIds = new Set(
		sandboxProvider.configuredProviders
			.filter(
				(provider) =>
					env.POLAR_ENVIRONMENT === "sandbox" || provider.productionReady,
			)
			.map((provider) => provider.providerId),
	);
	const persistentCheckoutReady =
		billing.liveCheckoutEnabled &&
		(env.POLAR_ENVIRONMENT === "sandbox" || machineProvider.productionReady);
	const sandboxOperational =
		availableSandboxProviderIds.size > 0 &&
		isConfigured(
			env.POLAR_PRODUCT_CLOUD_WORKSPACE_STANDARD_V1 ??
				env.POLAR_PRODUCT_SANDBOX_STANDARD_V1,
		);
	const sandboxCheckoutReady =
		billing.liveCheckoutEnabled && sandboxOperational;
	const configuredLimit = Number(env.MAX_ENVIRONMENTS_PER_ACCOUNT ?? "5");
	const configuredIdleTimeout = Number(
		env.CLOUD_WORKSPACE_IDLE_TIMEOUT_MS ?? 10 * 60 * 1_000,
	);
	const configuredCacheMaxBytes = Number(
		env.CLOUD_REPOSITORY_CACHE_MAX_BYTES ?? 8 * 1024 * 1024 * 1024,
	);
	const cloudBillingEnforcementEnabled =
		env.CLOUD_BILLING_ENFORCEMENT_ENABLED === "true";
	const cloudBillingExportEnabled = env.CLOUD_BILLING_EXPORT_ENABLED === "true";
	const cloudBillingCutoverAtMs = isConfigured(env.CLOUD_BILLING_CUTOVER_AT)
		? Date.parse(env.CLOUD_BILLING_CUTOVER_AT)
		: undefined;
	if (
		cloudBillingCutoverAtMs !== undefined &&
		!Number.isFinite(cloudBillingCutoverAtMs)
	)
		throw new Error("CLOUD_BILLING_CUTOVER_AT must be an ISO timestamp");
	if (
		(cloudBillingEnforcementEnabled || cloudBillingExportEnabled) &&
		cloudBillingCutoverAtMs === undefined
	)
		throw new Error(
			"CLOUD_BILLING_CUTOVER_AT is required before enforcement or export",
		);
	if (
		cloudBillingExportEnabled &&
		(!billing.polarConfigured ||
			!isConfigured(env.POLAR_CLOUD_OVERAGE_METER_ID))
	)
		throw new Error(
			"Polar and POLAR_CLOUD_OVERAGE_METER_ID are required for billing export",
		);
	const configLayer = Config.layer({
		relayIssuer: env.RELAY_ISSUER,
		workosJwksUrl: env.WORKOS_JWKS_URL,
		workosIssuer: env.WORKOS_ISSUER,
		workosApiKey: isConfigured(env.WORKOS_API_KEY)
			? Redacted.make(env.WORKOS_API_KEY)
			: undefined,
		mintPrivateKey: Redacted.make(env.RELAY_MINT_PRIVATE_JWK),
		mintPublicKey: env.RELAY_MINT_PUBLIC_JWK,
		cloudCredentialVaultKey: isConfigured(env.CLOUD_CREDENTIAL_VAULT_KEY)
			? Redacted.make(env.CLOUD_CREDENTIAL_VAULT_KEY)
			: undefined,
		e2bWebhookSecret: isConfigured(env.E2B_WEBHOOK_SECRET)
			? Redacted.make(env.E2B_WEBHOOK_SECRET)
			: undefined,
		cloudBillingEnforcementEnabled,
		cloudBillingExportEnabled,
		cloudBillingCutoverAtMs,
		cloudBillingPolarMeterId: isConfigured(env.POLAR_CLOUD_OVERAGE_METER_ID)
			? env.POLAR_CLOUD_OVERAGE_METER_ID
			: undefined,
		cloudTranscriptObjects:
			cloudTranscriptBucket === undefined
				? undefined
				: {
						put: async (key, value) =>
							(await cloudTranscriptBucket.put(key, value, {
								onlyIf: { etagDoesNotMatch: "*" },
							})) === null
								? "exists"
								: "created",
						get: async (key) =>
							(await cloudTranscriptBucket.get(key))?.text() ?? null,
						deletePrefix: async (prefix) => {
							let cursor: string | undefined;
							do {
								const page = await cloudTranscriptBucket.list({
									prefix,
									...(cursor === undefined ? {} : { cursor }),
								});
								if (page.objects.length > 0)
									await cloudTranscriptBucket.delete(
										page.objects.map((object) => object.key),
									);
								cursor = page.truncated ? page.cursor : undefined;
							} while (cursor !== undefined);
						},
					},
		cloudWorkspaceIdleTimeoutMs:
			Number.isSafeInteger(configuredIdleTimeout) &&
			configuredIdleTimeout >= 60_000
				? configuredIdleTimeout
				: 10 * 60 * 1_000,
		cloudRepositoryCacheMaxBytes:
			Number.isSafeInteger(configuredCacheMaxBytes) &&
			configuredCacheMaxBytes >= 256 * 1024 * 1024
				? configuredCacheMaxBytes
				: 8 * 1024 * 1024 * 1024,
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
		liveCheckoutEnabled: persistentCheckoutReady || sandboxCheckoutReady,
		availableOfferIds: new Set([PERSISTENT_STANDARD_OFFER_ID]),
		liveCheckoutOfferIds: new Set([
			...(persistentCheckoutReady ? [PERSISTENT_STANDARD_OFFER_ID] : []),
			...(sandboxCheckoutReady ? [CLOUD_WORKSPACE_OFFER_ID] : []),
		]),
		availableSandboxProviderIds,
		enrollmentTtlMs: 30 * 60 * 1_000,
		recoveryWindowMs: 7 * 24 * 60 * 60 * 1_000,
		finalSnapshotRetentionMs: 14 * 24 * 60 * 60 * 1_000,
		reconcileLeaseMs: 5 * 60 * 1_000,
	};
	const appLayer = Layer.mergeAll(
		configLayer,
		betaAccessLayer,
		WorkosVerifierLive.pipe(Layer.provide(configLayer)),
		AccountIdentityLive.pipe(Layer.provide(configLayer)),
		RelayStorePg.pipe(Layer.provide(dbLayer)),
		MachineStorePg.pipe(Layer.provide(dbLayer)),
		CloudWorkspaceStorePg.pipe(Layer.provide(dbLayer)),
		CloudBillingStorePg.pipe(Layer.provide(dbLayer)),
		Layer.effect(CloudCredentialVault, CloudCredentialVaultLive).pipe(
			Layer.provide(configLayer),
		),
		Layer.effect(
			CloudWorkspaceLaunchIntentCipher,
			CloudWorkspaceLaunchIntentCipherLive,
		).pipe(Layer.provide(configLayer)),
		machineProvider.layer,
		sandboxProvider.layer,
		Layer.succeed(SandboxOfferConfiguration, sandboxOffer),
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
		const gatewayWorkspaceId = response.headers.get("x-zuse-gateway-workspace");
		const gatewayRole = response.headers.get("x-zuse-gateway-role");
		const gatewayGeneration = response.headers.get("x-zuse-gateway-generation");
		const gatewayEpoch = response.headers.get("x-zuse-gateway-epoch");
		if (
			gatewayWorkspaceId !== null &&
			gatewayGeneration !== null &&
			gatewayEpoch !== null &&
			(gatewayRole === "runtime" || gatewayRole === "client") &&
			request.headers.get("upgrade")?.toLowerCase() === "websocket"
		) {
			const connectionId = response.headers.get("x-zuse-gateway-connection");
			const headers = new Headers(request.headers);
			headers.delete("authorization");
			headers.set("x-zuse-gateway-workspace", gatewayWorkspaceId);
			headers.set("x-zuse-gateway-role", gatewayRole);
			headers.set("x-zuse-gateway-generation", gatewayGeneration);
			headers.set("x-zuse-gateway-epoch", gatewayEpoch);
			if (connectionId !== null)
				headers.set("x-zuse-gateway-connection", connectionId);
			await relay.dispose();
			const id = env.WORKSPACE_GATEWAY.idFromName(
				`${gatewayWorkspaceId}:${gatewayEpoch}`,
			);
			return env.WORKSPACE_GATEWAY.get(id).fetch(
				new Request(request, { headers }),
			);
		}
		const machineId = response.headers.get("x-zuse-reconcile-machine");
		const cloudBuildId = response.headers.get("x-zuse-reconcile-cloud-build");
		const cloudBuildIds =
			cloudBuildId
				?.split(",")
				.map((value) => value.trim())
				.filter(Boolean) ?? [];
		const cloudWorkspaceId = response.headers.get(
			"x-zuse-reconcile-cloud-workspace",
		);
		response.headers.delete("x-zuse-reconcile-machine");
		response.headers.delete("x-zuse-reconcile-cloud-build");
		response.headers.delete("x-zuse-reconcile-cloud-workspace");
		if (
			machineId === null &&
			cloudBuildId === null &&
			cloudWorkspaceId === null
		) {
			await relay.dispose();
			return response;
		}
		context.waitUntil(
			Promise.all([
				machineId === null
					? Promise.resolve()
					: relay.reconcileMachine(machineId, `webhook-${crypto.randomUUID()}`),
				...cloudBuildIds.map((buildId) => relay.reconcileCloudBuild(buildId)),
				cloudWorkspaceId === null
					? Promise.resolve()
					: relay.reconcileCloudWorkspace(cloudWorkspaceId),
			]).finally(() => relay.dispose()),
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
			Promise.all([
				relay.reconcile(`cron-${controller.scheduledTime}`),
				relay.reconcileCloud(),
				relay.maintainCloudBilling(controller.scheduledTime),
				pollE2bLifecycleEvents(env, relay, controller.scheduledTime).catch(
					(error) => {
						console.error(
							"[cloud-billing] E2B lifecycle recovery failed",
							error,
						);
						return 0;
					},
				),
			]).finally(() => relay.dispose()),
		);
	},
};
