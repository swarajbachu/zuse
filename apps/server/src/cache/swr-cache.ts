import {
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Option,
	PubSub,
	Schema,
	Scope,
	Stream,
} from "effect";

/**
 * Stale-while-revalidate cache for one slow-to-produce value (a remote
 * document, a provider inventory that needs a process spawn, …).
 *
 * Semantics:
 *   - `get` never fails and never blocks on the loader: it returns whatever
 *     is held (fresh or stale) and, when stale with nothing in flight, forks
 *     one background refresh into the cache's scope.
 *   - `refresh` forces a load, sharing any in-flight load (single flight).
 *   - Errors are remembered for `errorTtlMs` so a failing loader is not
 *     retried on every read (respawn storms), but they never evict a value.
 *   - A `fingerprint` (CLI version, credential hash, …) recorded with the
 *     entry marks it stale as soon as the caller's fingerprint differs.
 *   - With `persist`, the last good entry is written to disk as a JSON
 *     envelope and read back on construction, so restarts start warm. A
 *     corrupt or incompatible file is deleted and ignored.
 *
 * This is the shared replacement for the ad-hoc `Map` + TTL + in-flight
 * caches scattered around the server; new caches should use it.
 */
export interface SwrCacheEntry<A> {
	readonly value: A;
	readonly storedAt: number;
	readonly fingerprint: string | null;
	readonly etag: string | null;
}

export interface SwrLoadInput<A> {
	readonly previous: SwrCacheEntry<A> | null;
	readonly fingerprint: string | null;
}

export type SwrLoadResult<A> =
	| { readonly _tag: "value"; readonly value: A; readonly etag?: string | null }
	/** Keep the previous value, only bump `storedAt` (HTTP 304 and friends). */
	| { readonly _tag: "notModified" };

export interface SwrCacheOptions<A, E> {
	readonly name: string;
	readonly ttlMs: number;
	readonly errorTtlMs?: number;
	readonly load: (input: SwrLoadInput<A>) => Effect.Effect<SwrLoadResult<A>, E>;
	readonly persist?: {
		readonly path: string;
		readonly schema: Schema.Codec<A, unknown>;
	};
	readonly now?: () => number;
}

export interface SwrCacheState<A> {
	readonly entry: SwrCacheEntry<A> | null;
	readonly lastError: { readonly at: number; readonly message: string } | null;
	readonly inFlight: boolean;
}

export interface SwrCache<A, E> {
	readonly state: () => Effect.Effect<SwrCacheState<A>>;
	readonly isStale: (fingerprint?: string | null) => Effect.Effect<boolean>;
	readonly get: (
		fingerprint?: string | null,
	) => Effect.Effect<Option.Option<SwrCacheEntry<A>>>;
	readonly refresh: (
		fingerprint?: string | null,
	) => Effect.Effect<SwrCacheEntry<A>, E>;
	readonly invalidate: () => Effect.Effect<void>;
	readonly changes: Stream.Stream<SwrCacheEntry<A>>;
}

const DEFAULT_ERROR_TTL_MS = 5 * 60 * 1000;

const PersistedEnvelope = Schema.Struct({
	storedAt: Schema.Number,
	fingerprint: Schema.NullOr(Schema.String),
	etag: Schema.NullOr(Schema.String),
	value: Schema.Unknown,
});

const errorMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const readPersisted = <A>(
	persist: NonNullable<SwrCacheOptions<A, unknown>["persist"]>,
): SwrCacheEntry<A> | null => {
	let raw: string;
	try {
		raw = readFileSync(persist.path, "utf8");
	} catch {
		return null;
	}
	try {
		const envelope = Schema.decodeUnknownSync(PersistedEnvelope)(
			JSON.parse(raw),
		);
		const value = Schema.decodeUnknownSync(persist.schema)(envelope.value);
		return {
			value,
			storedAt: envelope.storedAt,
			fingerprint: envelope.fingerprint,
			etag: envelope.etag,
		};
	} catch {
		try {
			unlinkSync(persist.path);
		} catch {
			// best-effort cleanup
		}
		return null;
	}
};

const writePersisted = <A>(
	persist: NonNullable<SwrCacheOptions<A, unknown>["persist"]>,
	entry: SwrCacheEntry<A>,
): void => {
	try {
		mkdirSync(dirname(persist.path), { recursive: true });
		const payload = JSON.stringify({
			storedAt: entry.storedAt,
			fingerprint: entry.fingerprint,
			etag: entry.etag,
			value: Schema.encodeSync(persist.schema)(entry.value),
		});
		const tmp = `${persist.path}.${process.pid}.tmp`;
		writeFileSync(tmp, payload);
		renameSync(tmp, persist.path);
	} catch {
		// Cache writes are best-effort; failure just means a cold start later.
	}
};

export const makeSwrCache = <A, E>(
	options: SwrCacheOptions<A, E>,
): Effect.Effect<SwrCache<A, E>, never, Scope.Scope> =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const hub = yield* PubSub.unbounded<SwrCacheEntry<A>>();
		const now = options.now ?? (() => Date.now());
		const errorTtlMs = options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS;

		let entry: SwrCacheEntry<A> | null =
			options.persist === undefined ? null : readPersisted(options.persist);
		let lastError: SwrCacheState<A>["lastError"] = null;
		let inFlight: Deferred.Deferred<SwrCacheEntry<A>, E> | null = null;
		let invalidated = entry === null;

		const staleNow = (fingerprint: string | null): boolean => {
			if (entry === null || invalidated) return true;
			if (fingerprint !== null && entry.fingerprint !== fingerprint)
				return true;
			return now() - entry.storedAt >= options.ttlMs;
		};

		const errorSuppressed = (): boolean =>
			lastError !== null && now() - lastError.at < errorTtlMs;

		const commit = (next: SwrCacheEntry<A>) =>
			Effect.gen(function* () {
				entry = next;
				invalidated = false;
				lastError = null;
				if (options.persist !== undefined)
					writePersisted(options.persist, next);
				yield* PubSub.publish(hub, next);
			});

		const runLoad = (
			fingerprint: string | null,
		): Effect.Effect<SwrCacheEntry<A>, E> =>
			Effect.gen(function* () {
				const previous = entry;
				const result = yield* options.load({ previous, fingerprint });
				const next: SwrCacheEntry<A> =
					result._tag === "notModified" && previous !== null
						? { ...previous, storedAt: now(), fingerprint }
						: result._tag === "notModified"
							? yield* Effect.die(
									new Error(
										`[swr:${options.name}] loader returned notModified with no previous value`,
									),
								)
							: {
									value: result.value,
									storedAt: now(),
									fingerprint,
									etag: result.etag ?? null,
								};
				yield* commit(next);
				return next;
			});

		const refresh = (
			fingerprint: string | null = null,
		): Effect.Effect<SwrCacheEntry<A>, E> =>
			Effect.gen(function* () {
				if (inFlight !== null) return yield* Deferred.await(inFlight);
				const deferred = yield* Deferred.make<SwrCacheEntry<A>, E>();
				inFlight = deferred;
				const exit = yield* Effect.exit(runLoad(fingerprint));
				inFlight = null;
				if (Exit.isFailure(exit)) {
					lastError = {
						at: now(),
						message: errorMessage(Cause.squash(exit.cause)),
					};
				}
				yield* Deferred.done(deferred, exit);
				return yield* exit;
			});

		const get = (
			fingerprint: string | null = null,
		): Effect.Effect<Option.Option<SwrCacheEntry<A>>> =>
			Effect.gen(function* () {
				if (staleNow(fingerprint) && inFlight === null && !errorSuppressed()) {
					yield* refresh(fingerprint).pipe(Effect.ignore, Effect.forkIn(scope));
				}
				return entry === null ? Option.none() : Option.some(entry);
			});

		return {
			state: () =>
				Effect.sync(() => ({ entry, lastError, inFlight: inFlight !== null })),
			isStale: (fingerprint = null) => Effect.sync(() => staleNow(fingerprint)),
			get,
			refresh,
			invalidate: () =>
				Effect.sync(() => {
					invalidated = true;
					lastError = null;
				}),
			changes: Stream.unwrap(
				Effect.map(PubSub.subscribe(hub), (sub) =>
					Stream.fromSubscription(sub),
				),
			),
		};
	});

export interface KeyedSwrCacheOptions<K extends string, A, E> {
	readonly name: string;
	readonly ttlMs: number;
	readonly errorTtlMs?: number;
	readonly load: (
		key: K,
		input: SwrLoadInput<A>,
	) => Effect.Effect<SwrLoadResult<A>, E>;
	readonly persist?: {
		readonly pathFor: (key: K) => string;
		readonly schema: Schema.Codec<A, unknown>;
	};
	readonly now?: () => number;
}

export interface KeyedSwrCache<K extends string, A, E> {
	readonly forKey: (key: K) => Effect.Effect<SwrCache<A, E>>;
	readonly changes: Stream.Stream<{
		readonly key: K;
		readonly entry: SwrCacheEntry<A>;
	}>;
}

/** One `SwrCache` per key, created lazily and sharing one change stream. */
export const makeKeyedSwrCache = <K extends string, A, E>(
	options: KeyedSwrCacheOptions<K, A, E>,
): Effect.Effect<KeyedSwrCache<K, A, E>, never, Scope.Scope> =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const hub = yield* PubSub.unbounded<{
			readonly key: K;
			readonly entry: SwrCacheEntry<A>;
		}>();
		const caches = new Map<K, SwrCache<A, E>>();
		const forKey = (key: K): Effect.Effect<SwrCache<A, E>> =>
			Effect.gen(function* () {
				const existing = caches.get(key);
				if (existing !== undefined) return existing;
				const cache = yield* makeSwrCache<A, E>({
					name: `${options.name}:${key}`,
					ttlMs: options.ttlMs,
					...(options.errorTtlMs !== undefined
						? { errorTtlMs: options.errorTtlMs }
						: {}),
					load: (input) => options.load(key, input),
					...(options.persist !== undefined
						? {
								persist: {
									path: options.persist.pathFor(key),
									schema: options.persist.schema,
								},
							}
						: {}),
					...(options.now !== undefined ? { now: options.now } : {}),
				}).pipe(Effect.provideService(Scope.Scope, scope));
				caches.set(key, cache);
				yield* cache.changes.pipe(
					Stream.runForEach((entry) => PubSub.publish(hub, { key, entry })),
					Effect.forkIn(scope),
				);
				return cache;
			});
		return {
			forKey,
			changes: Stream.unwrap(
				Effect.map(PubSub.subscribe(hub), (sub) =>
					Stream.fromSubscription(sub),
				),
			),
		};
	});
