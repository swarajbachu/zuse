import type {
	ModelOption,
	OpencodeInventory,
	OptionDescriptor,
	ProviderId,
	SelectOptionDescriptor,
} from "../agent.ts";
import { PROVIDER_IDS } from "../agent.ts";
import {
	booleanDescriptor,
	CLAUDE_FULL_EFFORT_OPTIONS,
	claudeEffortDescriptor,
	reasoningSelectDescriptorFromIds,
	staticContextWindowDescriptor,
} from "./authoring.ts";
import { BUNDLED_MODEL_CATALOG } from "./bundled.ts";
import { humanizeModelId } from "./helpers.ts";
import type {
	LiveListingStatus,
	ModelLiveMeta,
	ResolvedCatalogSource,
	ResolvedModelCatalog,
	ResolvedModelCatalogProvider,
	ResolvedModelOption,
} from "./resolved.ts";
import type { ModelCatalog, ModelCatalogProvider } from "./schema.ts";

/**
 * One model as reported by a provider's live inventory. `label` is optional:
 * curated labels win, and unknown models are humanized from the id.
 */
export interface LiveModel {
	readonly id: string;
	readonly label?: string;
	readonly isDefault?: boolean;
	readonly liveMeta?: ModelLiveMeta;
}

/**
 * A provider's live inventory plus how much to trust it. `authoritative`
 * providers (Codex, Cursor, Kiro, OpenCode) enumerate exactly what the
 * account can use, so curated entries missing from `models` are marked
 * unavailable. Non-authoritative listings (Claude) only add.
 */
export interface LiveListing {
	readonly status: LiveListingStatus["status"];
	readonly authoritative: boolean;
	readonly fetchedAt: number | null;
	readonly error: string | null;
	readonly models: ReadonlyArray<LiveModel>;
	readonly opencode?: OpencodeInventory;
}

export type LiveListingsByProvider = Partial<Record<ProviderId, LiveListing>>;

/**
 * Ids a live inventory may still report that we never want in a picker
 * (retired upstream, superseded, or non-coding models).
 */
export const RETIRED_MODEL_IDS_BY_PROVIDER: Readonly<
	Partial<Record<ProviderId, ReadonlySet<string>>>
> = {
	kiro: new Set([
		"claude-opus-4.8",
		"claude-opus-4.7",
		"claude-opus-4.6",
		"claude-sonnet-4.6",
		"claude-sonnet-4.5",
		"claude-haiku-4.5",
		"minimax-m2.5",
		"glm-5",
		"deepseek-3.2",
		"qwen3-coder-next",
	]),
	opencode: new Set(["claude-opus-4-5"]),
};

const NO_LIVE: LiveListing = {
	status: "unsupported",
	authoritative: false,
	fetchedAt: null,
	error: null,
	models: [],
};

const EMPTY_PROVIDER: ModelCatalogProvider = { models: [], aliases: {} };

const isRetired = (providerId: ProviderId, id: string): boolean => {
	const set = RETIRED_MODEL_IDS_BY_PROVIDER[providerId];
	if (set === undefined) return false;
	if (set.has(id)) return true;
	// OpenCode ids are `<provider>/<model>`; retire on the model half too.
	const slash = id.indexOf("/");
	return slash >= 0 && set.has(id.slice(slash + 1));
};

const withoutDescriptor = (
	descriptors: ReadonlyArray<OptionDescriptor> | undefined,
	id: string,
): OptionDescriptor[] => (descriptors ?? []).filter((d) => d.id !== id);

const hasDescriptor = (
	descriptors: ReadonlyArray<OptionDescriptor> | undefined,
	id: string,
): boolean => (descriptors ?? []).some((d) => d.id === id);

const oneMillionContext = (meta: ModelLiveMeta | undefined): boolean =>
	typeof meta?.contextWindowTokens === "number" &&
	meta.contextWindowTokens >= 1_000_000;

/**
 * Descriptors for a model the curated catalog doesn't know, derived from
 * what the provider reported. Keeps the composer usable for brand-new
 * models on day one.
 */
const liveOnlyDescriptors = (
	providerId: ProviderId,
	meta: ModelLiveMeta | undefined,
): OptionDescriptor[] => {
	const out: OptionDescriptor[] = [];
	switch (providerId) {
		case "codex": {
			const reasoning = reasoningSelectDescriptorFromIds(
				meta?.reasoningEfforts ?? ["low", "medium", "high"],
			);
			if (reasoning !== undefined) out.push(reasoning);
			if (meta?.fastTier === true) {
				out.push(booleanDescriptor("fastMode", "Fast Mode"));
			}
			break;
		}
		case "claude":
			out.push(
				claudeEffortDescriptor({
					options: CLAUDE_FULL_EFFORT_OPTIONS,
					defaultId: "high",
				}),
			);
			break;
		case "opencode": {
			const variants = reasoningSelectDescriptorFromIds(meta?.variants ?? []);
			if (variants !== undefined) out.push(variants);
			break;
		}
		default:
			break;
	}
	if (oneMillionContext(meta) && !hasDescriptor(out, "contextWindow")) {
		out.push(staticContextWindowDescriptor("1m", "1M"));
	}
	return out;
};

/**
 * Overlay live facts onto a curated entry's descriptors: Codex reasoning
 * tiers and fast tier, OpenCode variants, and the 1M context pill.
 */
const mergeDescriptors = (
	providerId: ProviderId,
	curated: ReadonlyArray<OptionDescriptor> | undefined,
	meta: ModelLiveMeta | undefined,
): ReadonlyArray<OptionDescriptor> | undefined => {
	if (meta === undefined) return curated;
	let out: OptionDescriptor[] = [...(curated ?? [])];
	if (providerId === "codex" && meta.reasoningEfforts !== undefined) {
		const existing = out.find(
			(d): d is SelectOptionDescriptor =>
				d.kind === "select" && d.id === "reasoning",
		);
		const live = reasoningSelectDescriptorFromIds(
			meta.reasoningEfforts,
			existing?.defaultId,
		);
		if (live !== undefined) {
			// Keep curated labels for tiers we already know.
			const labels = new Map(existing?.options.map((o) => [o.id, o.label]));
			out = [
				...withoutDescriptor(out, "reasoning"),
				{
					...live,
					options: live.options.map((o) => ({
						id: o.id,
						label: labels.get(o.id) ?? o.label,
					})),
				},
			];
		}
	}
	if (providerId === "codex" && meta.fastTier === false) {
		out = withoutDescriptor(out, "fastMode");
	}
	if (
		providerId === "codex" &&
		meta.fastTier === true &&
		!hasDescriptor(out, "fastMode")
	) {
		out.push(booleanDescriptor("fastMode", "Fast Mode"));
	}
	if (providerId === "opencode" && meta.variants !== undefined) {
		const variants = reasoningSelectDescriptorFromIds(meta.variants);
		out = withoutDescriptor(out, "reasoning");
		if (variants !== undefined) out.push(variants);
	}
	if (oneMillionContext(meta) && !hasDescriptor(out, "contextWindow")) {
		out.push(staticContextWindowDescriptor("1m", "1M"));
	}
	return out.length === 0 && curated === undefined ? undefined : out;
};

/** Kiro's live inventory owns the badge column: credit multipliers only. */
const liveBadge = (
	providerId: ProviderId,
	curated: string | undefined,
	meta: ModelLiveMeta | undefined,
): string | undefined => {
	if (providerId === "kiro" && meta !== undefined) {
		return meta.rateMultiplier !== undefined && meta.rateMultiplier !== 1
			? `${meta.rateMultiplier}×`
			: undefined;
	}
	return curated;
};

const providerDefaultWebSearch = (
	providerId: ProviderId,
): ModelOption["supportsWebSearch"] => {
	switch (providerId) {
		case "claude":
		case "codex":
			return "native";
		case "grok":
		case "gemini":
			return "queryOnly";
		default:
			return undefined;
	}
};

const resolveProvider = (
	providerId: ProviderId,
	curated: ModelCatalogProvider,
	listing: LiveListing,
): ResolvedModelCatalogProvider => {
	const liveOk = listing.status === "ok";
	const liveById = new Map<string, LiveModel>();
	if (liveOk) {
		for (const model of listing.models) {
			if (!isRetired(providerId, model.id)) liveById.set(model.id, model);
		}
	}
	const authoritative = liveOk && listing.authoritative;
	const models: ResolvedModelOption[] = [];
	for (const entry of curated.models) {
		const live = liveById.get(entry.id);
		const badgeLabel = liveBadge(providerId, entry.badgeLabel, live?.liveMeta);
		const optionDescriptors = mergeDescriptors(
			providerId,
			entry.optionDescriptors,
			live?.liveMeta,
		);
		const { badgeLabel: _curatedBadge, ...rest } = entry;
		models.push({
			...rest,
			...(badgeLabel !== undefined ? { badgeLabel } : {}),
			...(optionDescriptors !== undefined ? { optionDescriptors } : {}),
			origin: live !== undefined ? "both" : "curated",
			available: authoritative ? live !== undefined : true,
			...(live?.liveMeta !== undefined ? { liveMeta: live.liveMeta } : {}),
		});
	}
	const curatedIds = new Set(curated.models.map((m) => m.id));
	for (const live of liveById.values()) {
		if (curatedIds.has(live.id)) continue;
		const descriptors = liveOnlyDescriptors(providerId, live.liveMeta);
		const badgeLabel = liveBadge(providerId, undefined, live.liveMeta);
		const webSearch = providerDefaultWebSearch(providerId);
		models.push({
			id: live.id,
			label: live.label ?? humanizeModelId(live.id),
			...(badgeLabel !== undefined ? { badgeLabel } : {}),
			...(descriptors.length > 0 ? { optionDescriptors: descriptors } : {}),
			supportsPlanMode: true,
			...(webSearch !== undefined ? { supportsWebSearch: webSearch } : {}),
			origin: "live",
			available: true,
			...(live.liveMeta !== undefined ? { liveMeta: live.liveMeta } : {}),
		});
	}
	const usable = (m: ResolvedModelOption) =>
		m.available && m.defaultVisible !== false;
	const liveDefaultId = liveOk
		? listing.models.find((m) => m.isDefault === true)?.id
		: undefined;
	const defaultModelId =
		models.find((m) => m.defaultModel === true && usable(m))?.id ??
		(liveDefaultId !== undefined &&
		models.some((m) => m.id === liveDefaultId && usable(m))
			? liveDefaultId
			: undefined) ??
		models.find(usable)?.id ??
		models[0]?.id ??
		"";
	return {
		models,
		aliases: curated.aliases,
		defaultModelId,
		live: {
			status: listing.status,
			authoritative: listing.authoritative,
			fetchedAt: listing.fetchedAt,
			error: listing.error,
		},
		...(listing.opencode !== undefined ? { opencode: listing.opencode } : {}),
	};
};

/**
 * Fill providers a (possibly older) remote document lacks from the bundled
 * snapshot, and ignore providers this build doesn't know.
 */
export const normalizeModelCatalog = (
	document: ModelCatalog,
	fallback: ModelCatalog = BUNDLED_MODEL_CATALOG,
): ModelCatalog => {
	const providers: Record<string, ModelCatalogProvider> = {};
	for (const providerId of PROVIDER_IDS) {
		providers[providerId] =
			document.providers[providerId] ??
			fallback.providers[providerId] ??
			EMPTY_PROVIDER;
	}
	return {
		schemaVersion: document.schemaVersion,
		revision: document.revision,
		generatedAt: document.generatedAt,
		providers,
		pricing: { ...fallback.pricing, ...document.pricing },
	};
};

/** Higher revision wins; ties keep the first argument. */
export const pickNewerModelCatalog = (
	a: ModelCatalog,
	b: ModelCatalog,
): ModelCatalog => (b.revision > a.revision ? b : a);

/**
 * Pure merge of the curated catalog with live provider inventories. No IO;
 * the server, renderer, and mobile all call this (the clients with an empty
 * `live` map for their instant bundled first paint).
 */
export const resolveModelCatalog = (
	curated: ModelCatalog,
	live: LiveListingsByProvider = {},
	meta: {
		readonly source?: ResolvedCatalogSource;
		readonly fetchedAt?: number | null;
	} = {},
): ResolvedModelCatalog => {
	const normalized = normalizeModelCatalog(curated);
	const providers = {} as Record<ProviderId, ResolvedModelCatalogProvider>;
	for (const providerId of PROVIDER_IDS) {
		providers[providerId] = resolveProvider(
			providerId,
			normalized.providers[providerId] ?? EMPTY_PROVIDER,
			live[providerId] ?? NO_LIVE,
		);
	}
	return {
		schemaVersion: 1,
		revision: normalized.revision,
		generatedAt: normalized.generatedAt,
		source: meta.source ?? "bundled",
		fetchedAt: meta.fetchedAt ?? null,
		providers,
		pricing: normalized.pricing,
	};
};

/** The catalog every client shows before the server answers. */
export const bundledResolvedModelCatalog = (): ResolvedModelCatalog =>
	resolveModelCatalog(BUNDLED_MODEL_CATALOG);
