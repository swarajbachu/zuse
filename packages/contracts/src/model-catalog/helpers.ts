import type { ModelOption, ProviderId } from "../agent.ts";
import { PROVIDER_IDS } from "../agent.ts";
import { BUNDLED_MODEL_CATALOG } from "./bundled.ts";
import type { ModelPricing } from "./schema.ts";

/**
 * Minimal structural view every catalog flavour satisfies: the bundled
 * snapshot, a decoded remote document, and the server-resolved catalog.
 * Helpers are written against this so callers never care which one they
 * hold. `available` only exists on resolved entries; `undefined` means
 * "assume available".
 */
export type CatalogModel = ModelOption & { readonly available?: boolean };

export interface ModelCatalogProviderView<
	M extends CatalogModel = CatalogModel,
> {
	readonly models: ReadonlyArray<M>;
	readonly aliases: Readonly<Record<string, string>>;
}

export interface ModelCatalogView<M extends CatalogModel = CatalogModel> {
	readonly providers: Readonly<
		Partial<Record<string, ModelCatalogProviderView<M>>>
	>;
	readonly pricing: Readonly<Record<string, ModelPricing>>;
}

export type ModelEnabledByProvider = Record<
	ProviderId,
	Record<string, boolean>
>;
export type ModelEnabledOverrides = Partial<
	Record<ProviderId, Partial<Record<string, boolean>>>
>;

const EMPTY_MODELS: ReadonlyArray<never> = [];

export const modelsForProvider = <M extends CatalogModel>(
	catalog: ModelCatalogView<M>,
	providerId: ProviderId,
): ReadonlyArray<M> => catalog.providers[providerId]?.models ?? EMPTY_MODELS;

/**
 * Look up a model's descriptor by `(providerId, modelId)`. Returns
 * `undefined` when the slug isn't in the catalog (e.g. user typed a custom
 * slug), in which case the caller should fall through to provider-level
 * defaults.
 */
export const findModelDescriptor = <M extends CatalogModel>(
	catalog: ModelCatalogView<M>,
	providerId: ProviderId,
	modelId: string,
): M | undefined =>
	modelsForProvider(catalog, providerId).find((m) => m.id === modelId);

/**
 * Route a retired / shorthand slug to its canonical id. Unknown slugs pass
 * through untouched so user-typed custom ids keep working.
 */
export const resolveModelSlug = (
	catalog: ModelCatalogView,
	providerId: ProviderId,
	slug: string,
): string => catalog.providers[providerId]?.aliases[slug] ?? slug;

export const isModelVisible = (
	catalog: ModelCatalogView,
	providerId: ProviderId,
	modelId: string,
	modelEnabledByProvider?: ModelEnabledOverrides,
): boolean => {
	const override = modelEnabledByProvider?.[providerId]?.[modelId];
	if (typeof override === "boolean") return override;
	const descriptor = findModelDescriptor(catalog, providerId, modelId);
	if (descriptor === undefined) return true;
	return descriptor.defaultVisible !== false;
};

export const visibleModelsForProvider = <M extends CatalogModel>(
	catalog: ModelCatalogView<M>,
	providerId: ProviderId,
	modelEnabledByProvider?: ModelEnabledOverrides,
	options?: { readonly includeModelId?: string | null },
): ReadonlyArray<M> => {
	const includeModelId = options?.includeModelId ?? null;
	return modelsForProvider(catalog, providerId).filter(
		(model) =>
			(model.available !== false &&
				isModelVisible(
					catalog,
					providerId,
					model.id,
					modelEnabledByProvider,
				)) ||
			model.id === includeModelId,
	);
};

/**
 * Preferred default for a provider: the flagged `defaultModel` when it is
 * visible and available, else the first visible available model, else the
 * first model, else the bundled snapshot's answer (so an empty live-only
 * provider never yields an empty string).
 */
export const defaultModelFor = (
	catalog: ModelCatalogView,
	providerId: ProviderId,
): string => {
	const models = modelsForProvider(catalog, providerId);
	const usable = (m: CatalogModel) =>
		m.defaultVisible !== false && m.available !== false;
	const pick =
		models.find((m) => m.defaultModel === true && usable(m)) ??
		models.find(usable) ??
		models[0];
	if (pick !== undefined) return pick.id;
	if (catalog === (BUNDLED_MODEL_CATALOG as ModelCatalogView)) return "";
	return defaultModelFor(BUNDLED_MODEL_CATALOG, providerId);
};

export const defaultModelEnabledByProvider = (
	catalog: ModelCatalogView = BUNDLED_MODEL_CATALOG,
): ModelEnabledByProvider => {
	const out = {} as ModelEnabledByProvider;
	for (const providerId of PROVIDER_IDS) {
		out[providerId] = {};
		for (const model of modelsForProvider(catalog, providerId)) {
			out[providerId][model.id] = model.defaultVisible !== false;
		}
	}
	return out;
};

export const pricingFor = (
	catalog: ModelCatalogView,
	modelId: string,
): ModelPricing | undefined => catalog.pricing[modelId];

/** Providers present in this catalog, in canonical `ProviderId` order. */
export const catalogProviderIds = (
	catalog: ModelCatalogView,
): ReadonlyArray<ProviderId> =>
	PROVIDER_IDS.filter(
		(providerId) => catalog.providers[providerId] !== undefined,
	);

/**
 * Best-effort display label for a model id when the catalog has no entry:
 * `claude-opus-4.8` → "Claude Opus 4.8", `gpt-5.6-sol` → "GPT-5.6 Sol".
 * Slash-scoped ids (`opencode/gpt-6-astra`) humanize the model half only.
 */
export const humanizeModelId = (id: string): string => {
	const bare = id.includes("/") ? (id.split("/").pop() ?? id) : id;
	const acronyms = new Set(["gpt", "glm"]);
	const parts = bare.split(/[-_]/).filter((part) => part.length > 0);
	const words: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === undefined) continue;
		if (acronyms.has(part.toLowerCase())) {
			const next = parts[i + 1];
			// Keep "GPT-5.6" as one token when the next segment is a version.
			if (next !== undefined && /^\d/.test(next)) {
				words.push(`${part.toUpperCase()}-${next}`);
				i += 1;
				continue;
			}
			words.push(part.toUpperCase());
			continue;
		}
		if (/^\d/.test(part)) {
			words.push(part);
			continue;
		}
		words.push(part.charAt(0).toUpperCase() + part.slice(1));
	}
	return words.join(" ");
};

/**
 * Label for a model id searched across every provider (sub-agent rows and
 * cost footers only know the id). Falls back to a humanized id.
 */
export const labelForModelId = (
	catalog: ModelCatalogView,
	modelId: string,
	providerId?: ProviderId,
): string => {
	if (providerId !== undefined) {
		const direct = findModelDescriptor(catalog, providerId, modelId);
		if (direct !== undefined) return direct.label;
	}
	for (const pid of PROVIDER_IDS) {
		const found = findModelDescriptor(catalog, pid, modelId);
		if (found !== undefined) return found.label;
	}
	return humanizeModelId(modelId);
};
