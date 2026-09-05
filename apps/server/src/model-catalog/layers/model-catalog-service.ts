import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelListResponse } from "@zuse/agents/codex-generated/v2/ModelListResponse";
import { listClaudeModels } from "@zuse/agents/drivers/claude-models";
import { withCodexControlClient } from "@zuse/agents/drivers/codex-control-client";
import { listCursorModels } from "@zuse/agents/drivers/cursor-models";
import { loadKiroInventory } from "@zuse/agents/drivers/kiro-inventory";
import { loadOpencodeInventory } from "@zuse/agents/drivers/opencode";
import {
	BUNDLED_MODEL_CATALOG,
	findModelDescriptor,
	type LiveListing,
	type LiveListingsByProvider,
	MODEL_CATALOG_URL,
	ModelCatalog,
	ModelLiveMeta,
	normalizeModelCatalog,
	OpencodeInventory,
	type ProviderId,
	pickNewerModelCatalog,
	type ResolvedCatalogSource,
	type ResolvedModelCatalog,
	resolveModelCatalog,
	resolveModelSlug,
} from "@zuse/contracts";
import {
	Effect,
	Layer,
	Option,
	PubSub,
	Ref,
	Schema,
	Semaphore,
	Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { AppPaths } from "../../app-paths.ts";
import { makeKeyedSwrCache, makeSwrCache } from "../../cache/swr-cache.ts";
import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { resolveCliPath } from "../../provider/availability.ts";
import { CredentialsService } from "../../provider/services/credentials-service.ts";
import { ModelCatalogService } from "../services/model-catalog-service.ts";

/** Curated document: re-check zuse.sh every 6 hours (ETag makes it cheap). */
const CURATED_TTL_MS = 6 * 60 * 60 * 1000;
const CURATED_FETCH_TIMEOUT_MS = 5_000;
/** Live inventories need a process/network round-trip; once a day is plenty. */
const LIVE_TTL_MS = 24 * 60 * 60 * 1000;
const LIVE_ERROR_TTL_MS = 5 * 60 * 1000;
const LIVE_TIMEOUT_MS = 15_000;
/** At most two provider processes spawn concurrently for listing. */
const LIVE_CONCURRENCY = 2;

const LIVE_PROVIDERS: ReadonlyArray<ProviderId> = [
	"codex",
	"claude",
	"cursor",
	"kiro",
	"opencode",
];

const LiveModelDocument = Schema.Struct({
	id: Schema.String,
	label: Schema.optional(Schema.String),
	isDefault: Schema.optional(Schema.Boolean),
	liveMeta: Schema.optional(ModelLiveMeta),
});

const LiveListingDocument = Schema.Struct({
	status: Schema.Literals(["unsupported", "pending", "ok", "error"]),
	authoritative: Schema.Boolean,
	fetchedAt: Schema.NullOr(Schema.Number),
	error: Schema.NullOr(Schema.String),
	models: Schema.Array(LiveModelDocument),
	opencode: Schema.optional(OpencodeInventory),
});
type LiveListingDocument = typeof LiveListingDocument.Type;

const catalogUrl = (): string =>
	process.env.ZUSE_MODEL_CATALOG_URL?.trim() || MODEL_CATALOG_URL;

const offline = (): boolean =>
	process.env.ZUSE_MODEL_CATALOG_OFFLINE === "1" ||
	process.env.VITEST !== undefined ||
	process.env.NODE_ENV === "test";

const errorText = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const sha = (value: string): string =>
	createHash("sha256").update(value).digest("hex").slice(0, 16);

/** Cheap identity for an installed CLI: path + size + mtime, no spawn. */
const cliFingerprint = (cliPath: string | null): string => {
	if (cliPath === null) return "missing";
	try {
		const stat = statSync(cliPath);
		return `${cliPath}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
	} catch {
		return `${cliPath}:unstat`;
	}
};

const listingError = (
	authoritative: boolean,
	cause: unknown,
): LiveListingDocument => ({
	status: "error",
	authoritative,
	fetchedAt: null,
	error: errorText(cause),
	models: [],
});

const unsupportedListing: LiveListingDocument = {
	status: "unsupported",
	authoritative: false,
	fetchedAt: null,
	error: null,
	models: [],
};

const pendingListing = (authoritative: boolean): LiveListingDocument => ({
	status: "pending",
	authoritative,
	fetchedAt: null,
	error: null,
	models: [],
});

const isAuthoritative = (providerId: ProviderId): boolean =>
	providerId === "codex" ||
	providerId === "cursor" ||
	providerId === "kiro" ||
	providerId === "opencode";

export const ModelCatalogServiceLive = Layer.effect(
	ModelCatalogService,
	Effect.gen(function* () {
		const { userData } = yield* AppPaths;
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const credentials = yield* CredentialsService;
		const configStore = yield* ConfigStoreService;
		const cacheDir = join(userData, "model-catalog");
		const listerPermits = yield* Semaphore.make(LIVE_CONCURRENCY);

		const cliPath = (binary: string): Effect.Effect<string | null> =>
			resolveCliPath(binary).pipe(
				Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
			);

		// ---------------------------------------------------------------------
		// Curated document: bundled ⟶ disk ⟶ zuse.sh, highest revision wins.
		// ---------------------------------------------------------------------
		let curatedSource: ResolvedCatalogSource = "bundled";
		const curated = yield* makeSwrCache<ModelCatalog, Error>({
			name: "model-catalog:curated",
			ttlMs: CURATED_TTL_MS,
			errorTtlMs: LIVE_ERROR_TTL_MS,
			persist: { path: join(cacheDir, "curated.json"), schema: ModelCatalog },
			load: ({ previous }) =>
				Effect.gen(function* () {
					if (offline()) {
						return {
							_tag: "value" as const,
							value: previous?.value ?? BUNDLED_MODEL_CATALOG,
						};
					}
					const response = yield* Effect.tryPromise({
						try: () =>
							fetch(catalogUrl(), {
								headers: {
									accept: "application/json",
									...(previous?.etag ? { "if-none-match": previous.etag } : {}),
								},
								signal: AbortSignal.timeout(CURATED_FETCH_TIMEOUT_MS),
							}),
						catch: (cause) =>
							new Error(`model catalog fetch: ${errorText(cause)}`),
					});
					if (response.status === 304 && previous !== null) {
						return { _tag: "notModified" as const };
					}
					if (!response.ok) {
						return yield* Effect.fail(
							new Error(`model catalog fetch: HTTP ${response.status}`),
						);
					}
					const json = yield* Effect.tryPromise({
						try: () => response.json(),
						catch: (cause) =>
							new Error(`model catalog parse: ${errorText(cause)}`),
					});
					const decoded = yield* Schema.decodeUnknownEffect(ModelCatalog)(
						json,
					).pipe(
						Effect.mapError(
							(cause) => new Error(`model catalog schema: ${errorText(cause)}`),
						),
					);
					// Never downgrade: a stale CDN copy loses to what we ship.
					const value = pickNewerModelCatalog(
						normalizeModelCatalog(decoded),
						BUNDLED_MODEL_CATALOG,
					);
					curatedSource = "remote";
					return {
						_tag: "value" as const,
						value,
						etag: response.headers.get("etag"),
					};
				}),
		});
		{
			const initial = yield* curated.state();
			if (initial.entry !== null) curatedSource = "cached";
		}

		// ---------------------------------------------------------------------
		// Live inventories, one cache per provider, keyed by a fingerprint of
		// the installed CLI / credential so upgrades and logins re-probe.
		// ---------------------------------------------------------------------
		const listCodex = (): Effect.Effect<LiveListingDocument> =>
			Effect.gen(function* () {
				const codexPath = yield* cliPath("codex");
				if (codexPath === null) return unsupportedListing;
				const response = yield* Effect.tryPromise(() =>
					withCodexControlClient(codexPath, (client) =>
						client.request<ModelListResponse>("model/list", {
							includeHidden: false,
						}),
					),
				);
				const listing: LiveListingDocument = {
					status: "ok",
					authoritative: true,
					fetchedAt: Date.now(),
					error: null,
					models: response.data
						.filter((model) => !model.hidden)
						.map((model) => ({
							id: model.model || model.id,
							label: model.displayName,
							isDefault: model.isDefault,
							liveMeta: {
								reasoningEfforts: model.supportedReasoningEfforts.map(
									(option) => option.reasoningEffort,
								),
								fastTier: [
									...model.serviceTiers.flatMap((tier) => [tier.id, tier.name]),
									...model.additionalSpeedTiers,
								].some((label) => label.toLowerCase().includes("fast")),
								...(model.description.length > 0
									? { description: model.description }
									: {}),
							},
						})),
				};
				return listing;
			}).pipe(
				Effect.catchCause((cause) => Effect.succeed(listingError(true, cause))),
			);

		const listClaude = (): Effect.Effect<LiveListingDocument> =>
			Effect.gen(function* () {
				const claudePath = yield* cliPath("claude");
				const credential = yield* credentials
					.getProviderCredential("claude")
					.pipe(Effect.catch(() => Effect.succeed(null)));
				const models = yield* Effect.tryPromise(() =>
					listClaudeModels({
						claudeExecutablePath: claudePath,
						credential:
							credential === null
								? null
								: {
										kind:
											credential.kind === "oauth-token"
												? "oauth-token"
												: "api-key",
										secret: credential.secret,
									},
						cwd: tmpdir(),
						timeoutMs: LIVE_TIMEOUT_MS,
					}),
				);
				const listing: LiveListingDocument = {
					status: "ok",
					authoritative: false,
					fetchedAt: Date.now(),
					error: null,
					models: models.map((model) => ({
						id: model.id,
						label: model.label,
						liveMeta: {
							...(model.effortLevels !== null
								? { reasoningEfforts: model.effortLevels }
								: {}),
							...(model.supportsFastMode !== null
								? { fastTier: model.supportsFastMode }
								: {}),
							...(model.description !== null
								? { description: model.description }
								: {}),
						},
					})),
				};
				return listing;
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.succeed(listingError(false, cause)),
				),
			);

		const listCursor = (): Effect.Effect<LiveListingDocument> =>
			Effect.gen(function* () {
				const credential = yield* credentials
					.getProviderCredential("cursor")
					.pipe(Effect.catch(() => Effect.succeed(null)));
				if (credential === null || credential.secret.trim().length === 0) {
					return unsupportedListing;
				}
				const models = yield* Effect.tryPromise(() =>
					listCursorModels(credential.secret),
				);
				const listing: LiveListingDocument = {
					status: "ok",
					authoritative: true,
					fetchedAt: Date.now(),
					error: null,
					models: models.map((model) => ({
						id: model.id,
						...(model.label !== null ? { label: model.label } : {}),
					})),
				};
				return listing;
			}).pipe(
				Effect.catchCause((cause) => Effect.succeed(listingError(true, cause))),
			);

		const listKiro = (): Effect.Effect<LiveListingDocument> =>
			Effect.gen(function* () {
				const kiroPath = yield* cliPath("kiro-cli");
				if (kiroPath === null) return unsupportedListing;
				const inventory = yield* loadKiroInventory(kiroPath);
				const listing: LiveListingDocument = {
					status: "ok",
					authoritative: true,
					fetchedAt: Date.now(),
					error: null,
					models: inventory.models.map((model) => ({
						id: model.id,
						label: model.label,
						isDefault: model.id === inventory.defaultModelId,
						liveMeta: {
							...(model.contextWindow !== null
								? { contextWindowTokens: model.contextWindow }
								: {}),
							...(model.rateMultiplier !== null
								? { rateMultiplier: model.rateMultiplier }
								: {}),
							...(model.description !== null
								? { description: model.description }
								: {}),
						},
					})),
				};
				return listing;
			}).pipe(
				Effect.catchCause((cause) => Effect.succeed(listingError(true, cause))),
			);

		const listOpencode = (): Effect.Effect<LiveListingDocument> =>
			Effect.gen(function* () {
				const opencodePath = yield* cliPath("opencode");
				if (opencodePath === null) return unsupportedListing;
				const settings = yield* configStore.getSettings();
				const inventory = yield* loadOpencodeInventory(
					opencodePath,
					process.cwd(),
					settings.opencodeCustomProviders,
				);
				const listing: LiveListingDocument = {
					status: "ok",
					authoritative: true,
					fetchedAt: Date.now(),
					error: null,
					models: inventory.providers
						.filter((provider) => provider.connected)
						.flatMap((provider) =>
							provider.models.map((model) => ({
								id: model.id,
								label: model.label,
								liveMeta: { variants: model.variants },
							})),
						),
					opencode: inventory,
				};
				return listing;
			}).pipe(
				Effect.catchCause((cause) => Effect.succeed(listingError(true, cause))),
			);

		const listProvider = (
			providerId: ProviderId,
		): Effect.Effect<LiveListingDocument> => {
			switch (providerId) {
				case "codex":
					return listCodex();
				case "claude":
					return listClaude();
				case "cursor":
					return listCursor();
				case "kiro":
					return listKiro();
				case "opencode":
					return listOpencode();
				default:
					return Effect.succeed(unsupportedListing);
			}
		};

		const liveFingerprint = (providerId: ProviderId): Effect.Effect<string> =>
			Effect.gen(function* () {
				switch (providerId) {
					case "codex":
						return cliFingerprint(yield* cliPath("codex"));
					case "kiro":
						return cliFingerprint(yield* cliPath("kiro-cli"));
					case "claude": {
						const credential = yield* credentials
							.getProviderCredential("claude")
							.pipe(Effect.catch(() => Effect.succeed(null)));
						return `${cliFingerprint(yield* cliPath("claude"))}:${
							credential === null ? "login" : sha(credential.secret)
						}`;
					}
					case "cursor": {
						const credential = yield* credentials
							.getProviderCredential("cursor")
							.pipe(Effect.catch(() => Effect.succeed(null)));
						return credential === null ? "none" : sha(credential.secret);
					}
					case "opencode": {
						const settings = yield* configStore.getSettings();
						return `${cliFingerprint(yield* cliPath("opencode"))}:${sha(
							JSON.stringify(settings.opencodeCustomProviders),
						)}`;
					}
					default:
						return "static";
				}
			});

		const live = yield* makeKeyedSwrCache<
			ProviderId,
			LiveListingDocument,
			never
		>({
			name: "model-catalog:live",
			ttlMs: LIVE_TTL_MS,
			errorTtlMs: LIVE_ERROR_TTL_MS,
			persist: {
				pathFor: (providerId) => join(cacheDir, `live-${providerId}.json`),
				schema: LiveListingDocument,
			},
			load: (providerId) =>
				listerPermits
					.withPermits(1)(
						listProvider(providerId).pipe(
							Effect.timeoutOption(LIVE_TIMEOUT_MS + 1_000),
							Effect.map((result) =>
								Option.isSome(result)
									? result.value
									: listingError(
											isAuthoritative(providerId),
											new Error("Model listing timed out."),
										),
							),
						),
					)
					.pipe(Effect.map((value) => ({ _tag: "value" as const, value }))),
		});

		// ---------------------------------------------------------------------
		// Resolved catalog: recomputed on every change, always in memory.
		// ---------------------------------------------------------------------
		const liveListings = (): Effect.Effect<LiveListingsByProvider> =>
			Effect.gen(function* () {
				const out: Partial<Record<ProviderId, LiveListing>> = {};
				for (const providerId of LIVE_PROVIDERS) {
					const cache = yield* live.forKey(providerId);
					const state = yield* cache.state();
					out[providerId] =
						state.entry?.value ?? pendingListing(isAuthoritative(providerId));
				}
				return out;
			});

		const compute = (): Effect.Effect<ResolvedModelCatalog> =>
			Effect.gen(function* () {
				const curatedState = yield* curated.state();
				const document = curatedState.entry?.value ?? BUNDLED_MODEL_CATALOG;
				return resolveModelCatalog(
					pickNewerModelCatalog(document, BUNDLED_MODEL_CATALOG),
					yield* liveListings(),
					{
						source: curatedState.entry === null ? "bundled" : curatedSource,
						fetchedAt: curatedState.entry?.storedAt ?? null,
					},
				);
			});

		const currentRef = yield* Ref.make<ResolvedModelCatalog>(yield* compute());
		const hub = yield* PubSub.unbounded<ResolvedModelCatalog>();
		const publish = (): Effect.Effect<ResolvedModelCatalog> =>
			Effect.gen(function* () {
				const next = yield* compute();
				yield* Ref.set(currentRef, next);
				yield* PubSub.publish(hub, next);
				return next;
			});

		yield* curated.changes.pipe(
			Stream.runForEach(() => publish()),
			Effect.forkScoped,
		);
		yield* live.changes.pipe(
			Stream.runForEach(() => publish()),
			Effect.forkScoped,
		);

		const refreshLive = (
			providerIds: ReadonlyArray<ProviderId>,
			force: boolean,
		): Effect.Effect<void> =>
			Effect.forEach(
				providerIds.filter((providerId) => LIVE_PROVIDERS.includes(providerId)),
				(providerId) =>
					Effect.gen(function* () {
						const cache = yield* live.forKey(providerId);
						const fingerprint = yield* liveFingerprint(providerId);
						if (force) {
							yield* cache.refresh(fingerprint).pipe(Effect.ignore);
						} else {
							yield* cache.get(fingerprint);
						}
					}),
				{ concurrency: "unbounded", discard: true },
			);

		const refresh: ModelCatalogService["Service"]["refresh"] = (options = {}) =>
			Effect.gen(function* () {
				if (options.remote === true) {
					yield* curated
						.refresh()
						.pipe(
							Effect.catchCause((cause) =>
								Effect.logDebug(
									`[model-catalog] curated refresh failed: ${cause}`,
								),
							),
						);
				}
				if (options.live !== undefined) {
					yield* refreshLive(
						options.live === "all" ? LIVE_PROVIDERS : options.live,
						true,
					);
				}
				return yield* publish();
			});

		return ModelCatalogService.of({
			current: () => Ref.get(currentRef),
			refresh,
			changes: () =>
				Stream.unwrap(
					Effect.gen(function* () {
						const sub = yield* PubSub.subscribe(hub);
						const cur = yield* Ref.get(currentRef);
						return Stream.concat(
							Stream.make(cur),
							Stream.fromSubscription(sub),
						);
					}),
				),
			findModel: (providerId, modelId) =>
				Effect.map(Ref.get(currentRef), (catalog) =>
					findModelDescriptor(catalog, providerId, modelId),
				),
			resolveSlug: (providerId, slug) =>
				Effect.map(Ref.get(currentRef), (catalog) =>
					resolveModelSlug(catalog, providerId, slug),
				),
			invalidateLive: (providerId) =>
				Effect.gen(function* () {
					if (!LIVE_PROVIDERS.includes(providerId)) return;
					const cache = yield* live.forKey(providerId);
					yield* cache.invalidate();
				}),
		});
	}),
);
