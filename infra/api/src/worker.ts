import { PgClient } from "@effect/sql-pg";
import {
	CLOUD_WORKSPACE_OFFER_ID,
	HOSTED_APP_URL,
	PERSISTENT_STANDARD_OFFER_ID,
	PRODUCTION_API_URL,
} from "@zuse/contracts";
import type { QueueMessage } from "@zuse/slack/types";
import { Effect, Layer, Redacted } from "effect";
import { Pool } from "pg";
import runtimeInstallerSource from "../../../apps/server/scripts/runtime-updater.mjs";
import cloudInitTemplate from "../../cloud-machines/bootstrap/cloud-init.yaml.tmpl";
import { AccountIdentityLive } from "./account-identity.ts";
import { BetaAccessAllowAll, PostHogBetaAccessLayer } from "./beta-access.ts";
import { resolveBillingRuntime } from "./billing-config.ts";
import { CloudBillingStorePg } from "./cloud-billing-store.ts";
import type { BillingUsageRecovery } from "./cloud-billing-usage-source.ts";
import { billingUsageSourceModules } from "./cloud-billing-usage-source-config.ts";
import {
	drainMailboxLifecycleOutbox,
	reconcileCloudThenDrainMailboxLifecycleOutbox,
} from "./cloud-mailbox-bookkeeping.ts";
import {
	coordinateCloudMailboxResponse,
	deliverCloudMailboxLifecycle,
} from "./cloud-mailbox-coordinator.ts";
import {
	CloudWorkspaceLaunchIntentCipher,
	CloudWorkspaceLaunchIntentCipherLive,
} from "./cloud-workspace-launch-intent.ts";
import { CloudWorkspaceStorePg } from "./cloud-workspace-store.ts";
import * as Config from "./config.ts";
import { isConfigured } from "./environment.ts";
import { hyperdrivePoolConfig } from "./hyperdrive.ts";
import { makeApi } from "./index.ts";
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
import {
	resolveSlackConfiguration,
	type SlackBindings,
} from "./slack/config.ts";
import { SlackPersistenceLive } from "./slack/persistence.ts";
import { ApiStorePg } from "./store.ts";
import { WorkosVerifierLive } from "./workos.ts";

export { WorkspaceGateway } from "./workspace-gateway.ts";
export { WorkspaceMailbox } from "./workspace-mailbox.ts";

/**
 * Cloudflare Worker bindings. Secrets (`RELAY_MINT_PRIVATE_JWK`) are set via
 * `wrangler secret put`; the rest are `vars` in wrangler.jsonc. `HYPERDRIVE`
 * is the Hyperdrive binding fronting PlanetScale Postgres.
 */
interface Env extends SlackBindings {
	readonly HYPERDRIVE: { readonly connectionString: string };
	readonly WORKSPACE_GATEWAY: {
		readonly idFromName: (name: string) => unknown;
		readonly get: (id: unknown) => {
			readonly fetch: (request: Request) => Promise<Response>;
		};
	};
	readonly WORKSPACE_MAILBOX: {
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
	readonly API_ISSUER: string;
	readonly WORKOS_JWKS_URL: string;
	readonly WORKOS_ISSUER: string;
	readonly WORKOS_API_KEY?: string;
	readonly RELAY_MINT_PRIVATE_JWK: string;
	readonly API_MINT_PUBLIC_JWK: string;
	readonly CLOUD_DATA_ENCRYPTION_KEY?: string;
	readonly GITHUB_APP_ID?: string;
	readonly GITHUB_APP_SLUG?: string;
	readonly GITHUB_APP_CLIENT_ID?: string;
	readonly GITHUB_APP_PRIVATE_KEY?: string;
	readonly GITHUB_APP_CLIENT_SECRET?: string;
	readonly GITHUB_APP_WEBHOOK_SECRET?: string;
	/** Legacy binding retained so existing encrypted staging data remains readable. */
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
	readonly SANDBOX_DEFAULT_PROVIDER_ID?: string;
	readonly BOX_ADAPTER_ENABLED?: string;
	readonly BOX_API_KEY?: string;
	readonly BOX_API_BASE_URL?: string;
	readonly BOX_TEMPLATE_SNAPSHOT?: string;
	readonly BOX_TEMPLATE_VERSION?: string;
	readonly BOX_MACHINE_TYPE?: string;
	readonly BOX_HOSTED_PORT_DOMAIN?: string;
	readonly BOX_WEBHOOK_SECRET?: string;
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
	/** Additive rollout gate. Accepted rows continue draining when disabled. */
	readonly CLOUD_COMMAND_MAILBOX_ENABLED?: string;
	readonly CLOUD_CODEX_AUTH_BROKER_ENROLLMENT_ENABLED?: string;
	readonly CLOUD_CODEX_AUTH_BROKER_SERVING_ENABLED?: string;
	readonly CLOUD_PROVIDER_AUTH_BROKER_ENROLLMENT_ENABLED?: string;
	readonly CLOUD_PROVIDER_AUTH_BROKER_SERVING_ENABLED?: string;
}

const pollBillingUsageSources = async (
	env: Env,
	api: BillingUsageRecovery,
	nowMs: number,
): Promise<number> => {
	let recovered = 0;
	for (const module of billingUsageSourceModules) {
		if (module.poll === undefined) continue;
		recovered += await module
			.poll({ env, api, nowMs })
			.catch((error: unknown) => {
				console.error(
					`[cloud-billing] ${module.provider} lifecycle recovery failed`,
					error,
				);
				return 0;
			});
	}
	return recovered;
};

const flushMailboxLifecycleOutbox = (
	env: Pick<Env, "WORKSPACE_MAILBOX">,
	api: Pick<
		ReturnType<typeof makeApi>,
		"listPendingCloudMailboxLifecycles" | "acknowledgeCloudMailboxLifecycle"
	>,
): Promise<number> =>
	drainMailboxLifecycleOutbox({
		list: () => api.listPendingCloudMailboxLifecycles(100),
		deliver: (lifecycle) =>
			deliverCloudMailboxLifecycle(env.WORKSPACE_MAILBOX, lifecycle),
		acknowledge: (lifecycle) =>
			api.acknowledgeCloudMailboxLifecycle(lifecycle, Date.now()),
		onFailure: (lifecycle, error) =>
			console.error("[workspace-mailbox] lifecycle outbox retry failed", {
				...lifecycle,
				error,
			}),
	});

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

/**
 * Tell a workspace's gateway Durable Object that pending public-API commands
 * are waiting so it pushes a `runtime.command` control frame to the runtime.
 * Best-effort: a missed nudge is recovered by the cron sweep and by the
 * runtime's reconnect drain.
 */
const nudgeWorkspaceGateway = (env: Env, target: string): Promise<unknown> => {
	const id = env.WORKSPACE_GATEWAY.idFromName(target);
	return env.WORKSPACE_GATEWAY.get(id)
		.fetch(
			new Request("https://workspace-gateway.internal/nudge", {
				method: "POST",
				headers: { "x-zuse-gateway-nudge": "command" },
			}),
		)
		.catch((error) => {
			console.warn("[public-api] gateway nudge failed", error);
			return undefined;
		});
};

const build = (env: Env): ReturnType<typeof makeApi> => {
	const cloudTranscriptBucket = env.CLOUD_TRANSCRIPTS;
	const billing = resolveBillingRuntime(env);
	const postHogConfigured =
		isConfigured(env.POSTHOG_HOST) &&
		isConfigured(env.POSTHOG_PROJECT_TOKEN) &&
		isConfigured(env.POSTHOG_CLOUD_BETA_FLAG_KEY);
	if (env.API_ISSUER === PRODUCTION_API_URL && !postHogConfigured)
		throw new Error("Production cloud beta access requires PostHog");
	const betaAccessLayer = postHogConfigured
		? PostHogBetaAccessLayer({
				host: env.POSTHOG_HOST as string,
				projectToken: env.POSTHOG_PROJECT_TOKEN as string,
				flagKey: env.POSTHOG_CLOUD_BETA_FLAG_KEY as string,
				cache: (caches as CacheStorage & { readonly default: Cache }).default,
			})
		: BetaAccessAllowAll;
	const machineProvider = resolveMachineProviderRuntime(env, {
		cloudInitTemplate,
		apiIssuer: env.API_ISSUER,
		runtimeInstallerSource,
	});
	const sandboxProvider = resolveSandboxProviderRuntime(env);
	const sandboxOffer = {
		...sandboxProvider.offer,
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
					provider.advertised &&
					(env.POLAR_ENVIRONMENT === "sandbox" || provider.productionReady),
			)
			.map((provider) => provider.providerId),
	);
	const persistentCheckoutReady =
		billing.liveCheckoutEnabled &&
		(env.POLAR_ENVIRONMENT === "sandbox" ||
			(env.POLAR_VPS_SALES_APPROVED === "true" &&
				machineProvider.productionReady));
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
	const cloudDataEncryptionKey =
		env.CLOUD_DATA_ENCRYPTION_KEY ?? env.CLOUD_CREDENTIAL_VAULT_KEY;
	const githubAppConfigured = [
		env.GITHUB_APP_ID,
		env.GITHUB_APP_SLUG,
		env.GITHUB_APP_PRIVATE_KEY,
	].every(isConfigured);
	const configLayer = Config.layer({
		apiIssuer: env.API_ISSUER,
		workosJwksUrl: env.WORKOS_JWKS_URL,
		workosIssuer: env.WORKOS_ISSUER,
		workosApiKey: isConfigured(env.WORKOS_API_KEY)
			? Redacted.make(env.WORKOS_API_KEY)
			: undefined,
		mintPrivateKey: Redacted.make(env.RELAY_MINT_PRIVATE_JWK),
		mintPublicKey: env.API_MINT_PUBLIC_JWK,
		cloudDataEncryptionKey: isConfigured(cloudDataEncryptionKey)
			? Redacted.make(cloudDataEncryptionKey)
			: undefined,
		githubApp: githubAppConfigured
			? {
					appId: env.GITHUB_APP_ID as string,
					slug: env.GITHUB_APP_SLUG as string,
					privateKey: Redacted.make(env.GITHUB_APP_PRIVATE_KEY as string),
					clientId: isConfigured(env.GITHUB_APP_CLIENT_ID)
						? env.GITHUB_APP_CLIENT_ID
						: undefined,
					clientSecret: isConfigured(env.GITHUB_APP_CLIENT_SECRET)
						? Redacted.make(env.GITHUB_APP_CLIENT_SECRET)
						: undefined,
					webhookSecret: isConfigured(env.GITHUB_APP_WEBHOOK_SECRET)
						? Redacted.make(env.GITHUB_APP_WEBHOOK_SECRET)
						: undefined,
				}
			: undefined,
		providerWebhookSecrets: new Map([
			...(isConfigured(env.E2B_WEBHOOK_SECRET)
				? [["e2b", Redacted.make(env.E2B_WEBHOOK_SECRET)] as const]
				: []),
			...(isConfigured(env.BOX_WEBHOOK_SECRET)
				? [["box", Redacted.make(env.BOX_WEBHOOK_SECRET)] as const]
				: []),
		]),
		cloudBillingEnforcementEnabled,
		cloudBillingExportEnabled,
		cloudCommandMailboxEnabled: env.CLOUD_COMMAND_MAILBOX_ENABLED === "true",
		cloudCodexAuthBrokerEnrollmentEnabled:
			env.CLOUD_CODEX_AUTH_BROKER_ENROLLMENT_ENABLED === "true",
		cloudCodexAuthBrokerServingEnabled:
			env.CLOUD_CODEX_AUTH_BROKER_SERVING_ENABLED === "true",
		cloudProviderAuthBrokerEnrollmentEnabled:
			env.CLOUD_PROVIDER_AUTH_BROKER_ENROLLMENT_ENABLED === "true",
		cloudProviderAuthBrokerServingEnabled:
			env.CLOUD_PROVIDER_AUTH_BROKER_SERVING_ENABLED === "true",
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
		SlackPersistenceLive.pipe(Layer.provide(Layer.merge(dbLayer, configLayer))),
		betaAccessLayer,
		WorkosVerifierLive.pipe(Layer.provide(configLayer)),
		AccountIdentityLive.pipe(Layer.provide(configLayer)),
		ApiStorePg.pipe(Layer.provide(dbLayer)),
		MachineStorePg.pipe(Layer.provide(dbLayer)),
		CloudWorkspaceStorePg.pipe(Layer.provide(dbLayer)),
		CloudBillingStorePg.pipe(Layer.provide(dbLayer)),
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

	const pending = new Set<Promise<unknown>>();
	const context = {
		waitUntil(task: Promise<unknown>) {
			const tracked = task.catch(() => {
				console.error("[slack-app] background work failed");
			});
			pending.add(tracked);
			void tracked.finally(() => pending.delete(tracked));
		},
	};
	const slackConfig = resolveSlackConfiguration(
		env,
		isConfigured(cloudDataEncryptionKey),
	);
	const api: ReturnType<typeof makeApi> = makeApi(appLayer, {
		slackPublicOrigin: env.SLACK_PUBLIC_ORIGIN,
		slack: slackConfig
			? {
					...slackConfig,
					dispatch: async (response) => {
						// The outer request/queue owns the runtime. Individual operations must not dispose it.
						const scoped = { ...api, dispose: async () => {} };
						return (
							(await coordinateCloudMailboxResponse({
								response,
								mailboxes: env.WORKSPACE_MAILBOX,
								mailboxEnabled: env.CLOUD_COMMAND_MAILBOX_ENABLED === "true",
								api: scoped,
								context,
							})) ?? applyResponseEffects(response, scoped, env, context)
						);
					},
				}
			: undefined,
	});
	return {
		...api,
		dispose: async () => {
			while (pending.size > 0) await Promise.allSettled([...pending]);
			await api.dispose();
		},
	};
};

/** Shared post-operation work for public requests and first-party integrations. */
const applyResponseEffects = async (
	response: Response,
	api: ReturnType<typeof makeApi>,
	env: Env,
	context: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> => {
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
	const cloudPoolAccountId = response.headers.get(
		"x-zuse-reconcile-cloud-pool",
	);
	const gatewayNudgeTarget = response.headers.get(
		"x-zuse-nudge-cloud-workspace",
	);
	const webhookDeliveryAccountId = response.headers.get(
		"x-zuse-deliver-cloud-webhooks",
	);
	response.headers.delete("x-zuse-reconcile-machine");
	response.headers.delete("x-zuse-reconcile-cloud-build");
	response.headers.delete("x-zuse-reconcile-cloud-workspace");
	response.headers.delete("x-zuse-reconcile-cloud-pool");
	response.headers.delete("x-zuse-nudge-cloud-workspace");
	response.headers.delete("x-zuse-deliver-cloud-webhooks");
	if (
		machineId === null &&
		cloudBuildId === null &&
		cloudWorkspaceId === null &&
		cloudPoolAccountId === null &&
		gatewayNudgeTarget === null &&
		webhookDeliveryAccountId === null
	) {
		await api.dispose();
		return response;
	}
	context.waitUntil(
		Promise.allSettled([
			machineId === null
				? Promise.resolve()
				: api.reconcileMachine(machineId, `webhook-${crypto.randomUUID()}`),
			...cloudBuildIds.map((buildId) => api.reconcileCloudBuild(buildId)),
			cloudWorkspaceId === null
				? Promise.resolve()
				: api.reconcileCloudWorkspaceStartup(cloudWorkspaceId),
			cloudPoolAccountId === null
				? Promise.resolve()
				: api.reconcileCloudPool(cloudPoolAccountId),
			gatewayNudgeTarget === null
				? Promise.resolve()
				: nudgeWorkspaceGateway(env, gatewayNudgeTarget),
			webhookDeliveryAccountId === null
				? Promise.resolve()
				: api.deliverApiWebhooks().catch((error) => {
						console.error("[public-api] webhook delivery failed", error);
						return 0;
					}),
		])
			.then((results) => {
				if (results.some((result) => result.status === "rejected"))
					console.error(
						"[api] background reconciliation failed; maintenance will retry",
					);
			})
			.finally(() => api.dispose()),
	);
	return response;
};

export default {
	async fetch(
		request: Request,
		env: Env,
		context: { readonly waitUntil: (promise: Promise<unknown>) => void },
	): Promise<Response> {
		// Cloudflare recommends request-scoped database clients for Hyperdrive.
		// A shared max-one pool stranded concurrent mobile auth requests.
		const api = build(env);
		let response: Response;
		try {
			response = await api.fetch(request);
		} catch (error) {
			await api.dispose();
			throw error;
		}
		const mailboxResponse = await coordinateCloudMailboxResponse({
			response,
			mailboxes: env.WORKSPACE_MAILBOX,
			mailboxEnabled: env.CLOUD_COMMAND_MAILBOX_ENABLED === "true",
			api,
			context,
		});
		if (mailboxResponse !== undefined) return mailboxResponse;
		const gatewayWorkspaceId = response.headers.get("x-zuse-gateway-workspace");
		const gatewayRole = response.headers.get("x-zuse-gateway-role");
		const gatewayGeneration = response.headers.get("x-zuse-gateway-generation");
		const gatewayEpoch = response.headers.get("x-zuse-gateway-epoch");
		const gatewayProtocol = response.headers.get("x-zuse-gateway-protocol");
		if (
			gatewayWorkspaceId !== null &&
			gatewayGeneration !== null &&
			gatewayEpoch !== null &&
			gatewayProtocol !== null &&
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
			headers.set("x-zuse-gateway-protocol", gatewayProtocol);
			if (connectionId !== null)
				headers.set("x-zuse-gateway-connection", connectionId);
			await api.dispose();
			const id = env.WORKSPACE_GATEWAY.idFromName(
				`${gatewayWorkspaceId}:${gatewayEpoch}`,
			);
			return env.WORKSPACE_GATEWAY.get(id).fetch(
				new Request(request, { headers }),
			);
		}
		return applyResponseEffects(response, api, env, context);
	},
	async queue(
		batch: { readonly messages: ReadonlyArray<QueueMessage> },
		env: Env,
	): Promise<void> {
		const api = build(env);
		try {
			await api.consumeSlackJobs(batch);
		} finally {
			await api.dispose();
		}
	},
	async scheduled(
		controller: { readonly scheduledTime: number },
		env: Env,
		context: { readonly waitUntil: (promise: Promise<unknown>) => void },
	): Promise<void> {
		const api = build(env);
		context.waitUntil(
			Promise.allSettled([
				api.reconcile(`cron-${controller.scheduledTime}`),
				reconcileCloudThenDrainMailboxLifecycleOutbox({
					reconcile: () => api.reconcileCloud(),
					drain: () => flushMailboxLifecycleOutbox(env, api),
					onReconcileFailure: (error) =>
						console.error(
							"[cloud-workspace] scheduled reconciliation failed",
							error,
						),
				}),
				api.maintainCloudBilling(controller.scheduledTime),
				api.deliverApiWebhooks().catch((error) => {
					console.error("[public-api] webhook delivery sweep failed", error);
					return 0;
				}),
				api
					.sweepApiCommands()
					.then((targets) =>
						Promise.all(
							targets.map((target) =>
								nudgeWorkspaceGateway(
									env,
									`${target.workspaceId}:${target.gatewayEpoch}`,
								),
							),
						),
					)
					.catch((error) => {
						console.error("[public-api] command sweep failed", error);
						return [];
					}),
				pollBillingUsageSources(env, api, controller.scheduledTime),
			])
				.then((results) => {
					for (const result of results)
						if (result.status === "rejected")
							console.error(
								"[api] scheduled maintenance failed",
								result.reason,
							);
				})
				.finally(() => api.dispose()),
		);
	},
};
