import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	BUNDLED_MODEL_CATALOG,
	bundledResolvedModelCatalog,
	catalogProviderIds,
	defaultModelEnabledByProvider,
	defaultModelFor,
	findModelDescriptor,
	humanizeModelId,
	isModelVisible,
	labelForModelId,
	ModelCatalog,
	modelsForProvider,
	normalizeModelCatalog,
	PROVIDER_IDS,
	pickNewerModelCatalog,
	providerCapabilities,
	ResolvedModelCatalog,
	resolveModelCatalog,
	resolveModelSlug,
	visibleModelsForProvider,
} from "../../src/index.ts";

const catalog = BUNDLED_MODEL_CATALOG;

const reasoningOptions = (
	providerId: "codex" | "claude",
	modelId: string,
	knob: "reasoning" | "effort",
) => {
	const descriptor = findModelDescriptor(
		catalog,
		providerId,
		modelId,
	)?.optionDescriptors?.find(
		(option) => option.kind === "select" && option.id === knob,
	);
	return descriptor?.kind === "select"
		? descriptor.options.map(({ id, label }) => ({ id, label }))
		: [];
};

describe("bundled model catalog", () => {
	it("discovers Muse models and reasoning controls without a speculative bundled model", () => {
		expect(modelsForProvider(catalog, "muse")).toEqual([]);
		const resolved = resolveModelCatalog(catalog, {
			muse: {
				status: "ok",
				authoritative: true,
				fetchedAt: 1,
				error: null,
				models: [
					{
						id: "muse-test",
						label: "Muse Test",
						isDefault: true,
						liveMeta: { reasoningEfforts: ["high", "max"] },
					},
				],
			},
		});
		expect(resolved.providers.muse.defaultModelId).toBe("muse-test");
		expect(resolved.providers.muse.models[0]).toMatchObject({
			id: "muse-test",
			supportsPlanMode: false,
			available: true,
			optionDescriptors: [
				{
					id: "reasoning",
					options: [
						{ id: "high", label: "High" },
						{ id: "max", label: "Max" },
					],
				},
			],
		});
	});
	it("round-trips through the wire schema", () => {
		const encoded = Schema.encodeSync(ModelCatalog)(catalog);
		const decoded = Schema.decodeUnknownSync(ModelCatalog)(
			JSON.parse(JSON.stringify(encoded)),
		);
		expect(decoded).toEqual(catalog);
		expect(decoded.revision).toBeGreaterThan(2026_01_01_00);
	});

	it("covers provider catalogs; connection-backed models come from live inventory", () => {
		const bundledProviders = PROVIDER_IDS.filter(
			(providerId) =>
				providerCapabilities(providerId).credentialSource === "provider",
		);
		expect(catalogProviderIds(catalog)).toEqual(bundledProviders);
		expect(modelsForProvider(catalog, "zuse")).toEqual([]);
		for (const providerId of bundledProviders) {
			if (providerId !== "muse")
				expect(modelsForProvider(catalog, providerId).length).toBeGreaterThan(
					0,
				);
		}
	});

	it("makes GPT-6 Astra the Codex default with the full reasoning ladder", () => {
		expect(modelsForProvider(catalog, "codex").map((m) => m.id)).toEqual([
			"gpt-6.1-sol",
			"gpt-6-astra",
			"gpt-6-sol",
			"gpt-6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		]);
		expect(defaultModelFor(catalog, "codex")).toBe("gpt-6-astra");
		const ladder = [
			{ id: "low", label: "Low" },
			{ id: "medium", label: "Medium" },
			{ id: "high", label: "High" },
			{ id: "xhigh", label: "Extra High" },
			{ id: "max", label: "Max" },
			{ id: "ultra", label: "Ultra" },
		];
		for (const modelId of ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol"]) {
			expect(reasoningOptions("codex", modelId, "reasoning")).toEqual(ladder);
		}
		expect(resolveModelSlug(catalog, "codex", "gpt-6")).toBe("gpt-6-astra");
		expect(
			findModelDescriptor(catalog, "codex", "gpt-6-astra")?.badgeLabel,
		).toBe("New");
		expect(reasoningOptions("codex", "gpt-6-luna", "reasoning")).toEqual(
			ladder.slice(0, -1),
		);
	});

	it("offers GPT-6.1 Sol with its supported reasoning tiers and pricing", () => {
		expect(findModelDescriptor(catalog, "codex", "gpt-6.1-sol")).toMatchObject({
			label: "GPT-6.1 Sol",
			badgeLabel: "New",
			supportsPlanMode: true,
			supportsWebSearch: "native",
			optionDescriptors: [expect.objectContaining({ defaultId: "medium" })],
		});
		expect(reasoningOptions("codex", "gpt-6.1-sol", "reasoning")).toEqual([
			{ id: "low", label: "Low" },
			{ id: "medium", label: "Medium" },
			{ id: "high", label: "High" },
			{ id: "xhigh", label: "Extra High" },
			{ id: "max", label: "Max" },
		]);
		expect(visibleModelsForProvider(catalog, "codex")[0]?.id).toBe(
			"gpt-6.1-sol",
		);
		expect(catalog.pricing["gpt-6.1-sol"]).toEqual({
			input: 2,
			output: 10,
			cacheRead: 0.1,
			cacheCreate: 2.5,
		});
	});

	it("makes Fable 5.1 the Claude default and keeps aliases routed", () => {
		expect(modelsForProvider(catalog, "claude").map((m) => m.id)).toEqual([
			"claude-sonnet-5-5",
			"claude-opus-5-5",
			"claude-fable-5-1",
			"claude-fable-5",
			"claude-opus-5",
			"claude-sonnet-5",
		]);
		expect(defaultModelFor(catalog, "claude")).toBe("claude-fable-5-1");
		expect(visibleModelsForProvider(catalog, "claude")[0]?.id).toBe(
			"claude-sonnet-5-5",
		);
		expect(isModelVisible(catalog, "claude", "claude-sonnet-5")).toBe(true);
		expect(resolveModelSlug(catalog, "claude", "fable")).toBe(
			"claude-fable-5-1",
		);
		expect(resolveModelSlug(catalog, "claude", "fable-5.1")).toBe(
			"claude-fable-5-1",
		);
		expect(resolveModelSlug(catalog, "claude", "fable-5")).toBe(
			"claude-fable-5",
		);
		expect(resolveModelSlug(catalog, "claude", "opus")).toBe("claude-opus-5-5");
		expect(reasoningOptions("claude", "claude-fable-5-1", "effort")).toEqual(
			reasoningOptions("claude", "claude-fable-5", "effort"),
		);
		expect(
			findModelDescriptor(catalog, "claude", "claude-fable-5-1")?.badgeLabel,
		).toBe("New");
		expect(
			findModelDescriptor(catalog, "claude", "claude-sonnet-5")?.badgeLabel,
		).toBeUndefined();
		expect(catalog.pricing["claude-fable-5-1"]).toEqual(
			catalog.pricing["claude-fable-5"],
		);
	});

	it("mirrors the new models into Cursor, OpenCode, and Kiro seeds", () => {
		expect(modelsForProvider(catalog, "cursor").map((m) => m.id)).toContain(
			"claude-fable-5-1",
		);
		expect(modelsForProvider(catalog, "cursor").map((m) => m.id)).toContain(
			"gpt-6-astra",
		);
		expect(defaultModelFor(catalog, "cursor")).toBe("composer-2.5");
		expect(modelsForProvider(catalog, "opencode").map((m) => m.id)).toContain(
			"opencode/claude-fable-5-1",
		);
		expect(modelsForProvider(catalog, "opencode").map((m) => m.id)).toContain(
			"opencode/gpt-6-astra",
		);
		expect(defaultModelFor(catalog, "opencode")).toBe(
			"opencode/claude-sonnet-5",
		);
		expect(modelsForProvider(catalog, "kiro").map((m) => m.id)).toEqual([
			"auto",
			"claude-fable-5.1",
			"claude-opus-5.5",
			"claude-opus-5",
			"claude-sonnet-5.5",
			"claude-sonnet-5",
			"gpt-6-astra",
			"gpt-6-sol",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-6-luna",
			"gpt-5.6-luna",
		]);
		expect(resolveModelSlug(catalog, "kiro", "claude-fable-5-1")).toBe(
			"claude-fable-5.1",
		);
	});

	it("routes the September releases and preserves their supported controls", () => {
		for (const alias of [
			"sonnet",
			"sonnet-5.5",
			"sonnet-5-5",
			"claude-sonnet-5.5",
		]) {
			expect(resolveModelSlug(catalog, "claude", alias)).toBe(
				"claude-sonnet-5-5",
			);
		}
		expect(resolveModelSlug(catalog, "claude", "sonnet-5")).toBe(
			"claude-sonnet-5",
		);
		expect(resolveModelSlug(catalog, "kiro", "claude-sonnet-5-5")).toBe(
			"claude-sonnet-5.5",
		);
		for (const alias of ["opus", "opus-5.5", "opus-5-5", "claude-opus-5.5"]) {
			expect(resolveModelSlug(catalog, "claude", alias)).toBe(
				"claude-opus-5-5",
			);
		}
		expect(resolveModelSlug(catalog, "claude", "opus-5")).toBe("claude-opus-5");
		expect(resolveModelSlug(catalog, "kiro", "claude-opus-5-5")).toBe(
			"claude-opus-5.5",
		);
		const opus = findModelDescriptor(catalog, "claude", "claude-opus-5-5");
		expect(opus?.optionDescriptors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "effort", defaultId: "medium" }),
				expect.objectContaining({
					id: "contextWindow",
					options: [{ id: "1m", label: "1M" }],
				}),
			]),
		);
		for (const provider of ["cursor", "opencode", "opencode2"] as const) {
			const prefix = provider === "cursor" ? "" : "opencode/";
			for (const model of [
				"gpt-6-sol",
				"gpt-6-luna",
				"claude-opus-5-5",
				"claude-sonnet-5-5",
				"grok-4.7",
			]) {
				expect(
					findModelDescriptor(catalog, provider, `${prefix}${model}`)
						?.badgeLabel,
				).toBe("New");
			}
		}
		expect(
			findModelDescriptor(catalog, "grok", "grok-4.7")?.supportsWebSearch,
		).toBe("queryOnly");
	});

	it("keeps retired models out of every built-in catalog", () => {
		for (const providerId of PROVIDER_IDS) {
			expect(
				modelsForProvider(catalog, providerId).every(
					(model) => model.defaultVisible !== false,
				),
			).toBe(true);
		}
		expect(defaultModelFor(catalog, "grok")).toBe("grok-build");
		expect(resolveModelSlug(catalog, "grok", "grok-build-latest")).toBe(
			"grok-4.7",
		);
		const enabled = defaultModelEnabledByProvider(catalog);
		expect(enabled.claude["claude-fable-5-1"]).toBe(true);
	});
});

describe("resolveModelCatalog", () => {
	it("merges Claude live aliases into canonical entries and names the automatic default", () => {
		const resolved = resolveModelCatalog(catalog, {
			claude: {
				status: "ok",
				authoritative: false,
				fetchedAt: 1,
				error: null,
				models: [
					{ id: "default", label: "Default (recommended)" },
					{ id: "opus", label: "Opus 5.5", liveMeta: { fastTier: true } },
					{ id: "sonnet", label: "Sonnet 5.5" },
					{ id: "haiku", label: "Haiku 4.5" },
					{ id: "claude-haiku-4-5", label: "Haiku 4.5" },
					{ id: "future-model", label: "Future model" },
				],
			},
		});
		const models = resolved.providers.claude.models;
		for (const label of ["Opus 5.5", "Sonnet 5.5", "Haiku 4.5"]) {
			expect(models.filter((model) => model.label === label)).toHaveLength(1);
		}
		for (const alias of ["opus", "sonnet", "haiku"]) {
			expect(models.map((model) => model.id)).not.toContain(alias);
		}
		expect(
			findModelDescriptor(resolved, "claude", "claude-opus-5-5"),
		).toMatchObject({
			origin: "both",
			badgeLabel: "New",
			liveMeta: { fastTier: true },
		});
		expect(findModelDescriptor(resolved, "claude", "default")?.label).toBe(
			"Claude Code default (automatic)",
		);
		expect(findModelDescriptor(resolved, "claude", "future-model")?.label).toBe(
			"Future model",
		);
	});

	it.each([
		false,
		true,
	])("prefers canonical live metadata over alias metadata (reversed: %s)", (reversed) => {
		const models = [
			{
				id: "haiku",
				label: "Alias label",
				isDefault: true,
				liveMeta: { fastTier: true },
			},
			{
				id: "claude-haiku-4-5",
				label: "Haiku 4.5",
				liveMeta: { fastTier: false },
			},
		];
		if (reversed) models.reverse();
		const resolved = resolveModelCatalog(
			{
				...catalog,
				providers: {
					claude: { ...catalog.providers.claude, models: [] },
				},
			},
			{
				claude: {
					status: "ok",
					authoritative: true,
					fetchedAt: 1,
					error: null,
					models: [{ id: "fallback-model" }, ...models],
				},
			},
		);
		expect(resolved.providers.claude.models).toHaveLength(2);
		expect(
			findModelDescriptor(resolved, "claude", "claude-haiku-4-5"),
		).toMatchObject({
			id: "claude-haiku-4-5",
			label: "Haiku 4.5",
			available: true,
			liveMeta: { fastTier: false },
		});
		expect(resolved.providers.claude.defaultModelId).toBe("claude-haiku-4-5");
	});

	it("returns the curated catalog untouched when no live listings exist", () => {
		const resolved = bundledResolvedModelCatalog();
		expect(resolved.source).toBe("bundled");
		expect(resolved.revision).toBe(catalog.revision);
		for (const providerId of PROVIDER_IDS) {
			const provider = resolved.providers[providerId];
			expect(provider.live.status).toBe("unsupported");
			expect(provider.models.map((m) => m.id)).toEqual(
				modelsForProvider(catalog, providerId).map((m) => m.id),
			);
			expect(provider.models.every((m) => m.available)).toBe(true);
			expect(provider.models.every((m) => m.origin === "curated")).toBe(true);
			expect(provider.defaultModelId).toBe(
				defaultModelFor(catalog, providerId),
			);
		}
		Schema.decodeUnknownSync(ResolvedModelCatalog)(
			JSON.parse(
				JSON.stringify(Schema.encodeSync(ResolvedModelCatalog)(resolved)),
			),
		);
	});

	it("appends live-only models with humanized labels and provider defaults", () => {
		const resolved = resolveModelCatalog(
			catalog,
			{
				codex: {
					status: "ok",
					authoritative: true,
					fetchedAt: 1,
					error: null,
					models: [
						{
							id: "gpt-6-astra",
							liveMeta: {
								reasoningEfforts: ["none", "low", "medium", "high", "ultra"],
								fastTier: true,
							},
						},
						{
							id: "gpt-7-nova",
							label: "GPT-7 Nova",
							liveMeta: { reasoningEfforts: ["low", "high"], fastTier: false },
						},
						{ id: "daybreak-blue-latest" },
					],
				},
			},
			{ source: "remote", fetchedAt: 42 },
		);
		const codex = resolved.providers.codex;
		expect(resolved.source).toBe("remote");
		expect(codex.live.status).toBe("ok");
		const ids = codex.models.map((m) => m.id);
		expect(ids.slice(0, 7)).toEqual([
			"gpt-6.1-sol",
			"gpt-6-astra",
			"gpt-6-sol",
			"gpt-6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		]);
		expect(ids).toContain("gpt-7-nova");
		expect(ids).toContain("daybreak-blue-latest");

		const astra = codex.models.find((m) => m.id === "gpt-6-astra");
		expect(astra?.origin).toBe("both");
		expect(astra?.available).toBe(true);
		const astraReasoning = astra?.optionDescriptors?.find(
			(d) => d.kind === "select" && d.id === "reasoning",
		);
		expect(
			astraReasoning?.kind === "select"
				? astraReasoning.options.map((o) => o.id)
				: [],
		).toEqual(["none", "low", "medium", "high", "ultra"]);
		expect(
			astraReasoning?.kind === "select"
				? astraReasoning.options.find((o) => o.id === "none")?.label
				: undefined,
		).toBe("None");
		expect(
			astra?.optionDescriptors?.some(
				(d) => d.kind === "boolean" && d.id === "fastMode",
			),
		).toBe(true);

		const sol = codex.models.find((m) => m.id === "gpt-5.6-sol");
		expect(sol?.available).toBe(false);
		expect(sol?.origin).toBe("curated");

		const nova = codex.models.find((m) => m.id === "gpt-7-nova");
		expect(nova?.origin).toBe("live");
		expect(nova?.label).toBe("GPT-7 Nova");
		expect(nova?.supportsWebSearch).toBe("native");
		expect(
			nova?.optionDescriptors?.some(
				(d) => d.kind === "boolean" && d.id === "fastMode",
			),
		).toBe(false);

		const daybreak = codex.models.find((m) => m.id === "daybreak-blue-latest");
		expect(daybreak?.label).toBe("Daybreak Blue Latest");
		expect(codex.defaultModelId).toBe("gpt-6-astra");
	});

	it("falls back to the live default when the curated default is unavailable", () => {
		const resolved = resolveModelCatalog(catalog, {
			codex: {
				status: "ok",
				authoritative: true,
				fetchedAt: 1,
				error: null,
				models: [
					{ id: "gpt-5.6-terra" },
					{ id: "gpt-5.6-luna", isDefault: true },
				],
			},
		});
		expect(resolved.providers.codex.defaultModelId).toBe("gpt-5.6-luna");
		expect(
			visibleModelsForProvider(resolved, "codex").map((m) => m.id),
		).toEqual(["gpt-5.6-terra", "gpt-5.6-luna"]);
		expect(defaultModelFor(resolved, "codex")).toBe("gpt-5.6-terra");
	});

	it("does not hide curated models for non-authoritative listings", () => {
		const resolved = resolveModelCatalog(catalog, {
			claude: {
				status: "ok",
				authoritative: false,
				fetchedAt: 1,
				error: null,
				models: [{ id: "claude-haiku-4-5", label: "Haiku 4.5" }],
			},
		});
		const claude = resolved.providers.claude;
		expect(claude.models.every((m) => m.available)).toBe(true);
		const haiku = claude.models.find((m) => m.id === "claude-haiku-4-5");
		expect(haiku?.origin).toBe("live");
		expect(
			haiku?.optionDescriptors?.some(
				(d) => d.kind === "select" && d.id === "effort",
			),
		).toBe(true);
	});

	it("keeps errors from touching availability and drops retired ids", () => {
		const resolved = resolveModelCatalog(catalog, {
			kiro: {
				status: "error",
				authoritative: true,
				fetchedAt: null,
				error: "boom",
				models: [],
			},
			opencode: {
				status: "ok",
				authoritative: true,
				fetchedAt: 2,
				error: null,
				models: [
					{ id: "anthropic/claude-opus-4-5" },
					{
						id: "opencode/claude-sonnet-5",
						liveMeta: { variants: ["high", "low"] },
					},
				],
			},
		});
		expect(resolved.providers.kiro.live).toEqual({
			status: "error",
			authoritative: true,
			fetchedAt: null,
			error: "boom",
		});
		expect(resolved.providers.kiro.models.every((m) => m.available)).toBe(true);
		const opencode = resolved.providers.opencode;
		expect(opencode.models.map((m) => m.id)).not.toContain(
			"anthropic/claude-opus-4-5",
		);
		const sonnet = opencode.models.find(
			(m) => m.id === "opencode/claude-sonnet-5",
		);
		expect(sonnet?.available).toBe(true);
		expect(sonnet?.label).toBe("OpenCode · Claude Sonnet 5");
		const variants = sonnet?.optionDescriptors?.find(
			(d) => d.kind === "select" && d.id === "reasoning",
		);
		expect(
			variants?.kind === "select" ? variants.options.map((o) => o.id) : [],
		).toEqual(["high", "low"]);
		expect(
			opencode.models.find((m) => m.id === "opencode/gpt-6-astra")?.available,
		).toBe(false);
	});

	it("uses Kiro live badges and 1M pills", () => {
		const resolved = resolveModelCatalog(catalog, {
			kiro: {
				status: "ok",
				authoritative: true,
				fetchedAt: 1,
				error: null,
				models: [
					{ id: "auto" },
					{
						id: "claude-opus-5",
						liveMeta: { rateMultiplier: 2.4, contextWindowTokens: 1_000_000 },
					},
					{
						id: "claude-opus-4.8",
						liveMeta: { rateMultiplier: 2 },
					},
				],
			},
		});
		const kiro = resolved.providers.kiro;
		expect(kiro.models.map((m) => m.id)).not.toContain("claude-opus-4.8");
		const opus = kiro.models.find((m) => m.id === "claude-opus-5");
		expect(opus?.badgeLabel).toBe("2.4×");
		expect(kiro.models.find((m) => m.id === "gpt-6-astra")?.badgeLabel).toBe(
			"Experimental",
		);
		expect(kiro.models.find((m) => m.id === "gpt-6-astra")?.available).toBe(
			false,
		);
	});
});

describe("catalog document normalization", () => {
	it("fills providers a stale remote document lacks and ignores unknown ones", () => {
		const document = {
			schemaVersion: 1 as const,
			revision: catalog.revision + 1,
			generatedAt: "2026-09-05T00:00:00.000Z",
			providers: {
				codex: catalog.providers.codex,
				futureProvider: { models: [{ id: "x", label: "X" }], aliases: {} },
			},
			pricing: {
				"gpt-6-astra": { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
			},
		};
		const normalized = normalizeModelCatalog(document);
		expect(catalogProviderIds(normalized)).toEqual(PROVIDER_IDS);
		expect(normalized.providers.claude).toEqual(catalog.providers.claude);
		expect(normalized.providers.futureProvider).toBeUndefined();
		expect(normalized.pricing["gpt-6-astra"]?.input).toBe(1);
		expect(normalized.pricing["claude-fable-5-1"]).toEqual(
			catalog.pricing["claude-fable-5-1"],
		);
		expect(pickNewerModelCatalog(catalog, document).revision).toBe(
			catalog.revision + 1,
		);
		expect(
			pickNewerModelCatalog(catalog, { ...document, revision: 1 }).revision,
		).toBe(catalog.revision);
	});
});

describe("model labels", () => {
	it("humanizes unknown ids and prefers catalog labels", () => {
		expect(humanizeModelId("claude-opus-4.8")).toBe("Claude Opus 4.8");
		expect(humanizeModelId("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
		expect(humanizeModelId("opencode/gpt-6-astra")).toBe("GPT-6 Astra");
		expect(labelForModelId(catalog, "claude-fable-5-1")).toBe("Fable 5.1");
		expect(labelForModelId(catalog, "claude-haiku-4-5")).toBe(
			"Claude Haiku 4 5",
		);
	});
});
