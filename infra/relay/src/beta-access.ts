import { analyticsAccountId } from "@zuse/analytics/identity";
import { Context, Effect, Layer, Schema } from "effect";
import { forbidden, type RelayError, serviceUnavailable } from "./errors.ts";

export class BetaAccessDenied extends Schema.TaggedErrorClass<BetaAccessDenied>()(
	"BetaAccessDenied",
	{},
) {}

export class BetaAccessUnavailable extends Schema.TaggedErrorClass<BetaAccessUnavailable>()(
	"BetaAccessUnavailable",
	{},
) {}

export interface BetaAccessApi {
	readonly check: (
		accountId: string,
	) => Effect.Effect<void, BetaAccessDenied | BetaAccessUnavailable>;
}

export class BetaAccess extends Context.Service<BetaAccess, BetaAccessApi>()(
	"@zuse/relay/BetaAccess",
) {}

export interface PostHogBetaAccessConfig {
	readonly host: string;
	readonly projectToken: string;
	readonly flagKey: string;
	readonly timeoutMs?: number;
	readonly cache?: Pick<Cache, "match" | "put">;
}

const FlagResponse = Schema.Struct({
	flags: Schema.Record(
		Schema.String,
		Schema.Struct({
			enabled: Schema.Boolean,
			failed: Schema.optional(Schema.Boolean),
		}),
	),
	errorsWhileComputingFlags: Schema.optional(Schema.Boolean),
	quotaLimited: Schema.optional(Schema.Array(Schema.String)),
});

export const makePostHogBetaAccess = (
	config: PostHogBetaAccessConfig,
	fetcher: typeof fetch = globalThis.fetch,
): BetaAccessApi => {
	const cacheKey = (accountId: string) =>
		new Request(
			`https://beta-access.zuse.internal/${encodeURIComponent(config.flagKey)}/${analyticsAccountId(accountId)}`,
		);
	const readCache = async (accountId: string) => {
		try {
			const response = await config.cache?.match(cacheKey(accountId));
			return response === undefined
				? undefined
				: (await response.text()) === "1";
		} catch {
			return undefined;
		}
	};
	const writeCache = async (accountId: string, allowed: boolean) => {
		try {
			await config.cache?.put(
				cacheKey(accountId),
				new Response(allowed ? "1" : "0", {
					headers: { "cache-control": "max-age=60" },
				}),
			);
		} catch {}
	};
	const evaluate = Effect.fn("BetaAccess.evaluate")(function* (
		accountId: string,
	) {
		const response = yield* Effect.tryPromise({
			try: () =>
				fetcher(`${config.host.replace(/\/+$/u, "")}/flags/?v=2`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						token: config.projectToken,
						distinct_id: analyticsAccountId(accountId),
						groups: {},
						person_properties: { workos_account_id: accountId },
						group_properties: {},
						geoip_disable: true,
						flag_keys_to_evaluate: [config.flagKey],
					}),
					signal: AbortSignal.timeout(config.timeoutMs ?? 5_000),
				}),
			catch: () => new BetaAccessUnavailable(),
		});
		if (!response.ok) return yield* new BetaAccessUnavailable();
		const payload = yield* Effect.tryPromise({
			try: () => response.json(),
			catch: () => new BetaAccessUnavailable(),
		}).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(FlagResponse)),
			Effect.mapError(() => new BetaAccessUnavailable()),
		);
		if (
			payload.errorsWhileComputingFlags === true ||
			(payload.quotaLimited?.length ?? 0) > 0 ||
			payload.flags[config.flagKey]?.failed === true
		)
			return yield* new BetaAccessUnavailable();
		const allowed = payload.flags[config.flagKey]?.enabled === true;
		yield* Effect.promise(() => writeCache(accountId, allowed));
		if (!allowed) return yield* new BetaAccessDenied();
	});
	return {
		check: Effect.fn("BetaAccess.check")(function* (accountId: string) {
			const cached = yield* Effect.promise(() => readCache(accountId));
			if (cached !== undefined)
				return cached ? undefined : yield* new BetaAccessDenied();
			return yield* evaluate(accountId).pipe(
				Effect.catchTag("BetaAccessUnavailable", () =>
					Effect.promise(() => readCache(accountId)).pipe(
						Effect.flatMap((decision) =>
							decision === true
								? Effect.void
								: Effect.fail(new BetaAccessUnavailable()),
						),
					),
				),
			);
		}),
	};
};

export const PostHogBetaAccessLayer = (
	config: PostHogBetaAccessConfig,
): Layer.Layer<BetaAccess> =>
	Layer.succeed(BetaAccess, makePostHogBetaAccess(config));

export const BetaAccessAllowAll = Layer.succeed(
	BetaAccess,
	BetaAccess.of({ check: () => Effect.void }),
);

export const requireCloudBetaAccess = Effect.fn("requireCloudBetaAccess")(
	function* (
		accountId: string,
	): Effect.fn.Return<void, RelayError, BetaAccess> {
		return yield* (yield* BetaAccess).check(accountId).pipe(
			Effect.catchTags({
				BetaAccessDenied: () =>
					Effect.fail(forbidden("cloud_beta_access_required")),
				BetaAccessUnavailable: () =>
					Effect.fail(serviceUnavailable("cloud_beta_access_unavailable")),
			}),
		);
	},
);
