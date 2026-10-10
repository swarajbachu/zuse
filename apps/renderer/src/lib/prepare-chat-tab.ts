import {
	defaultModelFor,
	type EnvironmentId,
	type FolderId,
	PROVIDER_IDS,
	type ProviderId,
	type RuntimeMode,
} from "@zuse/contracts";
import { currentModelCatalog } from "../store/model-catalog.ts";
import { useProvidersStore } from "../store/providers.ts";
import { resolveChatRuntimeMode } from "./auto-worktree.ts";
import { selectAuthenticatedProvider } from "./model-picker-availability.ts";
import { useSettingsStore } from "./settings-client-bus.ts";

/** Prepare tab defaults concurrently; missing provider feedback takes precedence over runtime errors. */
export const prepareChatTab = async (
	environmentId: EnvironmentId,
	projectId: FolderId | null,
): Promise<{
	readonly providerId: ProviderId;
	readonly model: string;
	readonly runtimeMode: RuntimeMode;
} | null> => {
	const settings = useSettingsStore.getState();
	const providersPromise = useProvidersStore.getState().loadFor(environmentId);
	const runtimeModePromise =
		projectId === null
			? Promise.resolve(settings.defaultRuntimeMode)
			: resolveChatRuntimeMode(environmentId, projectId);
	// Observe errors even when provider discovery fails or finds no usable provider.
	void runtimeModePromise.catch(() => undefined);
	await providersPromise;
	const providerId = selectAuthenticatedProvider({
		preferredProviderId: settings.defaultProviderId,
		providerIds: PROVIDER_IDS,
		availability:
			useProvidersStore.getState().availabilityByEnvironment[environmentId]
				?.availability ?? [],
		providerEnabled: settings.providerEnabled ?? {},
	});
	if (providerId === null) return null;
	const runtimeMode = await runtimeModePromise;
	return {
		providerId,
		model:
			settings.defaultModelByProvider[providerId] ??
			defaultModelFor(currentModelCatalog(), providerId),
		runtimeMode,
	};
};
