import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelListResponse } from "@zuse/agents/codex-generated/v2/ModelListResponse";
import { listClaudeModels } from "@zuse/agents/drivers/claude-models";
import { withCodexControlClient } from "@zuse/agents/drivers/codex-control-client";
import { listCursorModels } from "@zuse/agents/drivers/cursor-models";
import { loadKiroInventory } from "@zuse/agents/drivers/kiro-inventory";
import { loadMuseInventory } from "@zuse/agents/drivers/muse-client";
import { loadOpencodeInventory } from "@zuse/agents/drivers/opencode";
import { loadOpencode2Inventory } from "@zuse/agents/drivers/opencode2";
import { loadPiInventory } from "@zuse/agents/drivers/pi-inventory";
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
	providerCapabilities,
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
import { HarnessProvider } from "../../harness/provider.ts";
import { AcpAgentService } from "../../provider/acp/service.ts";
import { resolveCliPath } from "../../provider/availability.ts";
import { CredentialsService } from "../../provider/services/credentials-service.ts";
import { ModelCatalogService } from "../services/model-catalog-service.ts";

const CURATED_TTL_MS = 6 * 60 * 60 * 1000;
const CURATED_FETCH_TIMEOUT_MS = 5_000;

const LIVE_TTL_MS = 24 * 60 * 60 * 1000;
const LIVE_ERROR_TTL_MS = 5 * 60 * 1000;
const LIVE_TIMEOUT_MS = 15_000;

const LIVE_CONCURRENCY = 2;

const LIVE_PROVIDERS: ReadonlyArray<ProviderId> = [
	"zuse",
	"pi",
	"muse",
	"codex",
	"claude",
	"cursor",
	"kiro",
	"opencode",
	"opencode2",
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
	opencode2: Schema.optional(OpencodeInventory),
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
	providerCapabilities(providerId).authoritativeModels;

export const ModelCatalogServiceLive = Layer.effect(
	ModelCatalogService,
	Effect.gen(function* () {
		const { userData } = yield* AppPaths;
		const harness = yield* Effect.serviceOption(HarnessProvider);
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const credentials = yield* CredentialsService;
		const configStore = yield* ConfigStoreService;
		const cacheDir = join(userData, "model-catalog");
		const listerPermits = yield* Semaphore.make(LIVE_CONCURRENCY);

		const cliPath = (binary: string): Effect.Effect<string | null> =>
			configStore.getSettings().pipe(
				Effect.flatMap((settings) =>
					resolveCliPath(binary, settings.providerBinaryPaths ?? {}),
				),
				Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
			);

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

		const listMuse = (): Effect.Effect<LiveListingDocument> =>
			Effect.gen(function* () {
				const binary = yield* cliPath("muse");
				if (!binary) return unsupportedListing;
				const models = yield* loadMuseInventory(binary, userData);
				return {
					status: "ok" as const,
					authoritative: true,
					fetchedAt: Date.now(),
					error: null,
					models,
				};
			}).pipe(
				Effect.catchCause((cause) => Effect.succeed(listingError(true, cause))),
			);

		const listPi = (): Effect.Effect<LiveListingDocument> =>
			Effect.gen(function* () {
				const binary = yield* cliPath("pi");
				if (!binary) return unsupportedListing;
				const models = yield* loadPiInventory(binary);
				return {
					status: "ok" as const,
					authoritative: false,
					fetchedAt: Date.now(),
					error: null,
					models,
				};
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.succeed(listingError(false, cause)),
				),
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

		const listOpencode2 = (): Effect.Effect<LiveListingDocument> =>
			Effect.gen(function* () {
				const opencode2Path = yield* cliPath("opencode2");
				if (opencode2Path === null) return unsupportedListing;
				const settings = yield* configStore.getSettings();
				const inventory = yield* loadOpencode2Inventory(
					opencode2Path,
					process.cwd(),
					settings.opencode2CustomProviders,
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
					opencode2: inventory,
				};
				return listing;
			}).pipe(
				Effect.catchCause((cause) => Effect.succeed(listingError(true, cause))),
			);

		const listProvider = (
			providerId: ProviderId,
		): Effect.Effect<LiveListingDocument> => {
			switch (providerId) {
				case "zuse":
					return Option.isSome(harness)
						? harness.value.inventory().pipe(
								Effect.map((models) => ({
									status: "ok" as const,
									authoritative: true,
									fetchedAt: Date.now(),
									error: null,
									models,
								})),
								Effect.catch(() =>
									Effect.succeed(
										listingError(
											true,
											new Error("Could not load connected models"),
										),
									),
								),
							)
						: Effect.succeed(unsupportedListing);
				case "codex":
					return listCodex();
				case "claude":
					return listClaude();
				case "cursor":
					return listCursor();
				case "muse":
					return listMuse();
				case "pi":
					return listPi();
				case "kiro":
					return listKiro();
				case "opencode":
					return listOpencode();
				case "opencode2":
					return listOpencode2();
				default:
					return Effect.succeed(unsupportedListing);
			}
		};

		const liveFingerprint = (providerId: ProviderId): Effect.Effect<string> =>
			Effect.gen(function* () {
				switch (providerId) {
					case "zuse":
						return Option.isSome(harness)
							? yield* harness.value.fingerprint()
							: "unavailable";
					case "codex":
						return cliFingerprint(yield* cliPath("codex"));
					case "muse":
						return cliFingerprint(yield* cliPath("muse"));
					case "pi":
						return `${cliFingerprint(yield* cliPath("pi"))}:${process.env.PI_CODING_AGENT_DIR ?? process.env.HOME ?? ""}`;
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
					case "opencode2": {
						const settings = yield* configStore.getSettings();
						return `${cliFingerprint(yield* cliPath("opencode2"))}:${sha(
							JSON.stringify(settings.opencode2CustomProviders),
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
				const sourceDocument =
					curatedState.entry?.value ?? BUNDLED_MODEL_CATALOG;
				const base = pickNewerModelCatalog(
					sourceDocument,
					BUNDLED_MODEL_CATALOG,
				);
				const document = {
					...base,
					providers: {
						...base.providers,
						zuse: {
							aliases: {},
							models: (
								[
									["chatgpt", "codex"],
									["supergrok", "grok"],
								] as const
							).flatMap(([prefix, provider]) =>
								(base.providers[provider]?.models ?? []).map((model) => ({
									...model,
									id: `${prefix}/${model.id}`,
									supportsPlanMode: false,
									optionDescriptors: model.optionDescriptors?.filter(
										(option) => option.id === "reasoning",
									),
								})),
							),
						},
					},
				};
				return resolveModelCatalog(document, yield* liveListings(), {
					source: curatedState.entry === null ? "bundled" : curatedSource,
					fetchedAt: curatedState.entry?.storedAt ?? null,
				});
			});

		const acpAgents = yield* Effect.serviceOption(AcpAgentService);
		const withAcp = (
			catalog: ResolvedModelCatalog,
		): Effect.Effect<ResolvedModelCatalog> =>
			Effect.gen(function* () {
				if (acpAgents._tag === "None") return catalog;

				const definitions = yield* Effect.tryPromise(() =>
					acpAgents.value.list(),
				).pipe(
					Effect.catch((error) =>
						Effect.as(
							Effect.logWarning(
								`[model-catalog] ACP agents unavailable: ${error}`,
							),
							[],
						),
					),
				);
				const providers = { ...catalog.providers };
				for (const id of Object.keys(providers))
					if (id.startsWith("acp-")) delete providers[id as `acp-${string}`];
				for (const entry of definitions) {
					const models = entry.probe?.models.length
						? entry.probe.models
						: [{ id: "default", name: "Agent default" }];
					providers[entry.id] = {
						displayName: entry.name,
						...(entry.icon ? { icon: entry.icon } : {}),
						commands: entry.probe?.commands ?? [],
						models: models.map((model) => ({
							id: model.id,
							label: model.name,
							origin: "live" as const,
							available: entry.enabled,
							supportsPlanMode: false,
							optionDescriptors: entry.probe?.modes.length
								? [
										{
											kind: "select" as const,
											id: "acpMode",
											label: "Mode",
											defaultId: entry.probe.currentModeId,
											options: entry.probe.modes.map((mode) => ({
												id: mode.id,
												label: mode.name,
											})),
										},
									]
								: [],
						})),
						aliases: {},
						defaultModelId:
							entry.probe?.currentModelId ?? models[0]?.id ?? "default",
						live: {
							status: entry.probe?.status === "ready" ? "ok" : "pending",
							authoritative: true,
							fetchedAt: null,
							error: null,
						},
					};
				}
				return { ...catalog, providers };
			});
		const currentRef = yield* Ref.make<ResolvedModelCatalog>(
			yield* withAcp(yield* compute()),
		);
		const hub = yield* PubSub.unbounded<ResolvedModelCatalog>();
		const publish = (): Effect.Effect<ResolvedModelCatalog> =>
			Effect.gen(function* () {
				const next = yield* withAcp(yield* compute());
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
			current: () => Effect.flatMap(Ref.get(currentRef), withAcp),
			refresh,
			changes: () =>
				Stream.unwrap(
					Effect.gen(function* () {
						const sub = yield* PubSub.subscribe(hub);
						const cur = yield* Effect.flatMap(Ref.get(currentRef), withAcp);
						return Stream.concat(
							Stream.make(cur),
							Stream.fromSubscription(sub),
						);
					}),
				),
			findModel: (providerId, modelId) =>
				Effect.map(Effect.flatMap(Ref.get(currentRef), withAcp), (catalog) =>
					findModelDescriptor(catalog, providerId, modelId),
				),
			resolveSlug: (providerId, slug) =>
				Effect.map(Effect.flatMap(Ref.get(currentRef), withAcp), (catalog) =>
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
