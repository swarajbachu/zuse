import * as NodePath from "node:path";

import {
	type AnalyticsEventName,
	analyticsAccountId,
	createAnonymousAnalyticsId,
	sanitizeAnalyticsProperties,
} from "@zuse/analytics";
import {
	AnalyticsContext,
	type AnalyticsContext as SharedAnalyticsContext,
} from "@zuse/contracts";
import {
	Effect,
	FileSystem,
	Layer,
	PubSub,
	Ref,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/unstable/sql";

import { AppPaths } from "../../app-paths.ts";
import { AuthService } from "../../auth/services/auth-service.ts";
import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { AnalyticsService } from "../services/analytics-service.ts";

const POSTHOG_KEY = (process.env.ZUSE_POSTHOG_KEY ?? "").trim();
const POSTHOG_HOST = (
	process.env.ZUSE_POSTHOG_HOST ?? "https://us.i.posthog.com"
)
	.trim()
	.replace(/\/$/, "");
const ALLOW_NON_PRODUCTION = process.env.ZUSE_POSTHOG_ENABLE_DEV === "1";
const DELIVERY_CONFIGURED =
	POSTHOG_KEY.length > 0 &&
	(process.env.NODE_ENV === "production" || ALLOW_NON_PRODUCTION);
const IDENTITY_FILENAME = "analytics-anonymous-id";
const BATCH_SIZE = 50;
const MAX_OUTBOX_SIZE = 5_000;

interface OutboxRow {
	readonly id: string;
	readonly distinct_id: string;
	readonly event: string;
	readonly properties_json: string;
	readonly captured_at: string;
	readonly attempts: number;
}

const sameContext = (
	left: SharedAnalyticsContext,
	right: SharedAnalyticsContext,
): boolean =>
	left.enabled === right.enabled &&
	left.distinctId === right.distinctId &&
	left.identityKind === right.identityKind;

const commonProperties = (context: SharedAnalyticsContext) => {
	const now = new Date();
	return {
		surface: "desktop",
		os: process.platform,
		architecture: process.arch,
		app_version: process.env.ZUSE_APP_VERSION ?? "unknown",
		release_channel: process.env.ZUSE_RELEASE_CHANNEL ?? "unknown",
		identity_kind: context.identityKind,
		authenticated: context.identityKind === "account",
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
		local_hour: now.getHours(),
		local_weekday: now.getDay(),
	} as const;
};

export const AnalyticsServiceLive = Layer.effect(
	AnalyticsService,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const fileSystem = yield* FileSystem.FileSystem;
		const paths = yield* AppPaths;
		const settings = yield* ConfigStoreService;
		const auth = yield* AuthService;
		const contextPubSub = yield* PubSub.unbounded<SharedAnalyticsContext>();
		const flushLock = yield* Semaphore.make(1);
		const anonymousIdPath = NodePath.join(paths.userData, IDENTITY_FILENAME);

		const persistAnonymousId = (id: string) =>
			fileSystem
				.writeFileString(anonymousIdPath, id)
				.pipe(Effect.catch(() => Effect.void));

		const loadAnonymousId = fileSystem.readFileString(anonymousIdPath).pipe(
			Effect.map((id) => id.trim()),
			Effect.flatMap((id) =>
				id.startsWith("anonymous_") && id.length > 20
					? Effect.succeed(id)
					: Effect.fail(new Error("invalid analytics identity")),
			),
			Effect.catch(() =>
				Effect.sync(createAnonymousAnalyticsId).pipe(
					Effect.tap(persistAnonymousId),
				),
			),
		);

		const initialSettings = yield* settings.getSettings();
		const initialAuth = yield* auth.getSession();
		const initialAnonymousId = yield* loadAnonymousId;
		const initialContext = AnalyticsContext.make({
			enabled: initialSettings.analyticsEnabled,
			distinctId:
				initialAuth._tag === "SignedIn"
					? analyticsAccountId(initialAuth.session.user.id)
					: initialAnonymousId,
			identityKind: initialAuth._tag === "SignedIn" ? "account" : "anonymous",
		});
		const contextRef = yield* Ref.make<SharedAnalyticsContext>(initialContext);

		const publishContext = (next: SharedAnalyticsContext) =>
			Ref.modify(
				contextRef,
				(current) => [!sameContext(current, next), next] as const,
			).pipe(
				Effect.flatMap((changed) =>
					changed
						? PubSub.publish(contextPubSub, next).pipe(Effect.asVoid)
						: Effect.void,
				),
			);

		const purge = sql`DELETE FROM analytics_outbox`.pipe(
			Effect.asVoid,
			Effect.catch(() => Effect.void),
		);

		yield* Stream.runForEach(settings.settingsChanges(), (nextSettings) =>
			Effect.gen(function* () {
				const current = yield* Ref.get(contextRef);
				const next = AnalyticsContext.make({
					...current,
					enabled: nextSettings.analyticsEnabled,
				});
				yield* publishContext(next);
				if (!next.enabled) yield* purge;
			}),
		).pipe(Effect.forkScoped);

		yield* Stream.runForEach(auth.sessionChanges(), (authState) =>
			Effect.gen(function* () {
				const current = yield* Ref.get(contextRef);
				if (authState._tag === "SignedIn") {
					yield* publishContext(
						AnalyticsContext.make({
							...current,
							distinctId: analyticsAccountId(authState.session.user.id),
							identityKind: "account",
						}),
					);
					return;
				}
				// `sessionChanges` begins with the current state. Preserve an existing
				// installation identity on startup and rotate only on a real sign-out.
				if (current.identityKind === "anonymous") return;
				const anonymousId = createAnonymousAnalyticsId();
				yield* persistAnonymousId(anonymousId);
				yield* publishContext(
					AnalyticsContext.make({
						...current,
						distinctId: anonymousId,
						identityKind: "anonymous",
					}),
				);
			}),
		).pipe(Effect.forkScoped);

		const capture = (
			event: AnalyticsEventName,
			properties: Readonly<Record<string, string | number | boolean>> = {},
		) =>
			Effect.gen(function* () {
				const context = yield* Ref.get(contextRef);
				if (!context.enabled || !DELIVERY_CONFIGURED) return;
				const now = new Date().toISOString();
				const safe = sanitizeAnalyticsProperties(event, {
					...commonProperties(context),
					...properties,
				});
				yield* sql`INSERT INTO analytics_outbox
          (id, distinct_id, event, properties_json, captured_at, attempts, next_attempt_at)
          VALUES (
            ${crypto.randomUUID()}, ${context.distinctId}, ${event},
            ${JSON.stringify(safe)}, ${now}, 0, ${now}
          )`;
				yield* sql`DELETE FROM analytics_outbox WHERE id IN (
          SELECT id FROM analytics_outbox ORDER BY captured_at ASC
          LIMIT MAX(0, (SELECT COUNT(*) FROM analytics_outbox) - ${MAX_OUTBOX_SIZE})
        )`;
			}).pipe(Effect.catch(() => Effect.void));

		const flush = flushLock.withPermits(1)(
			Effect.gen(function* () {
				const context = yield* Ref.get(contextRef);
				if (!context.enabled || !DELIVERY_CONFIGURED) return;
				const now = new Date().toISOString();
				const rows = yield* sql<OutboxRow>`SELECT
          id, distinct_id, event, properties_json, captured_at, attempts
          FROM analytics_outbox
          WHERE next_attempt_at <= ${now}
          ORDER BY captured_at ASC
          LIMIT ${BATCH_SIZE}`;
				if (rows.length === 0) return;

				const payload = {
					api_key: POSTHOG_KEY,
					batch: rows.map((row) => ({
						event: row.event,
						timestamp: row.captured_at,
						properties: {
							...(JSON.parse(row.properties_json) as Record<string, unknown>),
							distinct_id: row.distinct_id,
							$insert_id: row.id,
							$process_person_profile: false,
						},
					})),
				};

				const delivered = yield* Effect.tryPromise({
					try: async () => {
						const response = await fetch(`${POSTHOG_HOST}/batch/`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(payload),
							signal: AbortSignal.timeout(10_000),
						});
						return response.ok;
					},
					catch: () => false,
				});

				if (delivered) {
					for (const row of rows) {
						yield* sql`DELETE FROM analytics_outbox WHERE id = ${row.id}`;
					}
					return;
				}

				for (const row of rows) {
					const attempts = row.attempts + 1;
					const delayMs = Math.min(
						5 * 60_000,
						2 ** Math.min(attempts, 8) * 1_000,
					);
					const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
					yield* sql`UPDATE analytics_outbox
            SET attempts = ${attempts}, next_attempt_at = ${nextAttemptAt}
            WHERE id = ${row.id}`;
				}
			}).pipe(Effect.catch(() => Effect.void)),
		);
		const drain = Effect.gen(function* () {
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				const now = new Date().toISOString();
				const before = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
					FROM analytics_outbox WHERE next_attempt_at <= ${now}`;
				if ((before[0]?.count ?? 0) === 0) return;
				yield* flush;
				const after = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
					FROM analytics_outbox WHERE next_attempt_at <= ${new Date().toISOString()}`;
				// A failed batch is deferred by `flush`; do not spin during shutdown.
				if ((after[0]?.count ?? 0) >= (before[0]?.count ?? 0)) return;
			}
		}).pipe(Effect.catch(() => Effect.void));

		yield* Effect.forever(
			Effect.sleep("5 seconds").pipe(Effect.andThen(flush)),
		).pipe(Effect.forkScoped);
		yield* Effect.addFinalizer(() => drain);

		return AnalyticsService.of({
			getContext: () => Ref.get(contextRef),
			contextChanges: () =>
				Stream.unwrap(
					Effect.gen(function* () {
						const subscription = yield* PubSub.subscribe(contextPubSub);
						const current = yield* Ref.get(contextRef);
						return Stream.concat(
							Stream.make(current),
							Stream.fromSubscription(subscription),
						);
					}),
				),
			capture,
			flush,
		});
	}),
);

export const AnalyticsServiceTest = Layer.succeed(
	AnalyticsService,
	AnalyticsService.of({
		getContext: () =>
			Effect.succeed(
				AnalyticsContext.make({
					enabled: false,
					distinctId: "anonymous_test",
					identityKind: "anonymous",
				}),
			),
		contextChanges: () => Stream.empty,
		capture: () => Effect.void,
		flush: Effect.void,
	}),
);
