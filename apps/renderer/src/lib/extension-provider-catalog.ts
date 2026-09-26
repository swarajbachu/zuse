import type { ExtensionCatalog, ModelCatalogView } from "@zuse/contracts";
import { useMemo } from "react";
import { useModelCatalogStore } from "../store/model-catalog.ts";
import { useExtensionCatalog } from "./extension-client-bus.ts";

export const extensionProvidersById = (items: ExtensionCatalog["items"]) =>
	new Map(
		items.flatMap((item) =>
			item.providers.map((provider) => [provider.id, provider] as const),
		),
	);

export function withExtensionProviders(
	catalog: ModelCatalogView,
	items: ExtensionCatalog["items"],
): ModelCatalogView {
	const providers = { ...catalog.providers };
	for (const [id, provider] of extensionProvidersById(items)) {
		providers[id] = {
			aliases: {},
			models: provider.models.map(({ supportsWebSearch, ...model }) => ({
				...model,
				...(supportsWebSearch === null ? {} : { supportsWebSearch }),
			})),
		};
	}
	return { ...catalog, providers };
}

/** Retains unavailable providers so persisted selections keep their identity. */
export function useExtensionProviderCatalog() {
	const { items } = useExtensionCatalog();
	const catalog = useModelCatalogStore((state) => state.catalog);
	return useMemo(
		() => ({
			providers: extensionProvidersById(items),
			catalog: withExtensionProviders(catalog, items),
		}),
		[catalog, items],
	);
}
