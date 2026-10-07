import { analyticsAccountId } from "@zuse/analytics/identity";
import { Effect, Redacted, Schema } from "effect";
import { type ApiConfig, ApiConfiguration } from "./config.ts";
import { type ApiError, forbidden } from "./errors.ts";
import { requestWorkos, WorkosOrganization } from "./organization-workos.ts";

const Flags = Schema.Struct({
	errorsWhileComputingFlags: Schema.optional(Schema.Boolean),
	flags: Schema.Record(
		Schema.String,
		Schema.Struct({
			enabled: Schema.Boolean,
			variant: Schema.optional(Schema.NullOr(Schema.String)),
		}),
	),
});

// Worker-local, bounded and scoped to the deployment configuration. Coalesce
// concurrent evaluations; never keep a stale approval when the provider fails.
const caches = new WeakMap<
	ApiConfig,
	Map<
		string,
		{
			expiresAt: number;
			value: Promise<boolean>;
		}
	>
>();

const evaluate = (
	config: ApiConfig,
	kind: "creation" | "access",
	id: string,
) => {
	if (!config.organizationWorkspacesEnabled) return Promise.resolve(false);
	if (!config.organizationRolloutEnabled) return Promise.resolve(true);
	if (!config.organizationPosthog) return Promise.resolve(false);
	let cache = caches.get(config);
	if (!cache) {
		cache = new Map();
		caches.set(config, cache);
	}
	const key = `${kind}:${id}`;
	const cached = cache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.value;
	if (cache.size >= 512) cache.delete(cache.keys().next().value ?? "");
	const flag =
		kind === "creation" ? "organization-creation" : "organization-access";
	const entry = {
		expiresAt: Number.POSITIVE_INFINITY,
		value: Promise.resolve(false),
	};
	entry.value = (async () => {
		try {
			const posthog = config.organizationPosthog;
			if (!posthog) return false;
			const url = new URL("/flags/?v=2", posthog.host);
			const response = await fetch(url.toString(), {
				method: "POST",
				headers: { "content-type": "application/json" },
				signal: AbortSignal.timeout(3_000),
				body: JSON.stringify({
					api_key: Redacted.value(posthog.projectKey),
					distinct_id:
						kind === "creation" ? analyticsAccountId(id) : `organization:${id}`,
					...(kind === "access"
						? {
								groups: { organization: id },
								group_properties: { organization: { $group_key: id } },
							}
						: {}),
				}),
			});
			if (!response.ok) throw new Error("flag evaluation unavailable");
			const result = Schema.decodeUnknownSync(Flags)(await response.json());
			if (result.errorsWhileComputingFlags)
				throw new Error("flag evaluation incomplete");
			entry.expiresAt = Date.now() + 30_000;
			const value = result.flags[flag];
			return value?.enabled === true && value.variant == null;
		} catch {
			entry.expiresAt = Date.now() + 5_000;
			return false;
		}
	})();
	cache.set(key, entry);
	return entry.value;
};

export const organizationCreationAllowed = (accountId: string) =>
	Effect.flatMap(ApiConfiguration, (config) =>
		Effect.promise(() => evaluate(config, "creation", accountId)),
	);

const creators = new WeakMap<
	ApiConfig,
	Map<string, Effect.Effect<string | null, ApiError, ApiConfiguration>>
>();

/** Creator identity comes from WorkOS metadata, never from the requesting member. */
export const organizationAccessAllowed = Effect.fn("organizationAccessAllowed")(
	function* (organizationId: string) {
		const config = yield* ApiConfiguration;
		if (yield* Effect.promise(() => evaluate(config, "access", organizationId)))
			return true;
		if (
			!config.organizationWorkspacesEnabled ||
			!config.organizationRolloutEnabled ||
			!config.organizationPosthog
		)
			return false;
		let cache = creators.get(config);
		if (!cache) {
			cache = new Map();
			creators.set(config, cache);
		}
		let lookup = cache.get(organizationId);
		if (!lookup) {
			lookup = yield* Effect.cachedWithTTL(
				requestWorkos(
					`/organizations/${encodeURIComponent(organizationId)}`,
					WorkosOrganization,
				).pipe(
					Effect.map(
						(organization) => organization.metadata?.zuse_creator ?? null,
					),
				),
				"30 seconds",
			);
			if (cache.size >= 512) cache.delete(cache.keys().next().value ?? "");
			cache.set(organizationId, lookup);
		}
		const creator = yield* lookup.pipe(
			Effect.catch(() => Effect.succeed(null)),
		);
		return creator !== null && (yield* organizationCreationAllowed(creator));
	},
);

export const requireOrganizationRollout = (organizationId: string) =>
	organizationAccessAllowed(organizationId).pipe(
		Effect.flatMap((allowed) =>
			allowed
				? Effect.void
				: Effect.fail(forbidden("organization_workspaces_disabled")),
		),
	);
