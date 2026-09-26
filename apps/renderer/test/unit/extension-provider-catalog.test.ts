import { runtimeDefaultModelFor } from "@zuse/client-runtime/provider-selection";
import {
	BUNDLED_MODEL_CATALOG,
	catalogProviderIds,
	ExtensionId,
	ExtensionListItem,
	ProviderId,
	visibleModelsForProvider,
} from "@zuse/contracts";
import { Schema } from "effect";
import { expect, it, vi } from "vitest";
import { withExtensionProviders } from "../../src/lib/extension-provider-catalog.ts";

vi.mock("../../src/lib/extension-client-bus.ts", () => ({
	useExtensionCatalog: vi.fn(),
}));
vi.mock("../../src/store/model-catalog.ts", () => ({
	useModelCatalogStore: vi.fn(),
}));

it("keeps extension provider models and defaults available to repository settings without changing the built-in catalog", () => {
	const id = ExtensionId.make("fixture");
	const providerId = Schema.decodeUnknownSync(ProviderId)("fixture.agent");
	const item = ExtensionListItem.make({
		id,
		manifest: {
			schemaVersion: 1,
			id,
			name: "Fixture",
			description: "Fixture",
			version: "1.0.0",
			entry: "index.ts",
			zuseApi: "^1.0.0",
			capabilities: [],
			contributions: [],
			publisher: { name: "Tests" },
		},
		source: { _tag: "directory", path: "/fixture" },
		status: "disabled",
		enabled: false,
		grantedCapabilities: [],
		activeCommit: null,
		availableCommit: null,
		error: null,
		clientBundle: null,
		clientCss: "",
		providers: [
			{
				id: providerId,
				displayName: "Fixture Agent",
				iconAssetUrl: null,
				order: 100,
				authentication: { _tag: "none" },
				capabilities: [],
				models: [
					{
						id: "hidden",
						label: "Hidden",
						defaultVisible: false,
						defaultModel: false,
						supportsPlanMode: false,
						supportsWebSearch: null,
					},
					{
						id: "preferred",
						label: "Preferred",
						defaultVisible: true,
						defaultModel: true,
						supportsPlanMode: true,
						supportsWebSearch: null,
					},
				],
			},
		],
	});
	const catalog = withExtensionProviders(BUNDLED_MODEL_CATALOG, [item]);
	expect(catalogProviderIds(catalog)).toContain(providerId);
	expect(
		visibleModelsForProvider(catalog, providerId, {}).map((model) => model.id),
	).toEqual(["preferred"]);
	expect(runtimeDefaultModelFor(catalog, providerId)).toBe("preferred");
	expect(runtimeDefaultModelFor(BUNDLED_MODEL_CATALOG, providerId)).toBe(
		"default",
	);
	expect(catalogProviderIds(BUNDLED_MODEL_CATALOG)).not.toContain(providerId);
});
