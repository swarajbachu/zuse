import {
	defaultModelFor,
	type ModelCatalogView,
	type ProviderId,
} from "@zuse/contracts";

/** Drivers without a catalog accept the protocol's default model sentinel. */
export const runtimeDefaultModelFor = (
	catalog: ModelCatalogView,
	providerId: ProviderId,
): string => defaultModelFor(catalog, providerId) ?? "default";
