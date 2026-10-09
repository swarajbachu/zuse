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

/** Shared preparation for adding a tab and replacing the final tab. */
export const prepareChatTab = async (
	environmentId: EnvironmentId,
	projectId: FolderId | null,
): Promise<{
	readonly providerId: ProviderId;
	readonly model: string;
	readonly runtimeMode: RuntimeMode;
} | null> => {
	const settings = useSettingsStore.getState();
	const [, runtimeMode] = await Promise.all([
		useProvidersStore.getState().loadFor(environmentId),
		projectId === null
			? Promise.resolve(settings.defaultRuntimeMode)
			: resolveChatRuntimeMode(environmentId, projectId),
	]);
	const providerId = selectAuthenticatedProvider({
		preferredProviderId: settings.defaultProviderId,
		providerIds: PROVIDER_IDS,
		availability:
			useProvidersStore.getState().availabilityByEnvironment[environmentId]
				?.availability ?? [],
		providerEnabled: settings.providerEnabled ?? {},
	});
	if (providerId === null) return null;
	return {
		providerId,
		model:
			settings.defaultModelByProvider[providerId] ??
			defaultModelFor(currentModelCatalog(), providerId),
		runtimeMode,
	};
};
