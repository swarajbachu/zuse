import type {
	EnvironmentId,
	FolderId,
	RepositorySettings,
	RuntimeMode,
} from "@zuse/contracts";

import {
	repositorySettingsKey,
	useRepositorySettingsStore,
} from "../store/repository-settings.ts";
import { useSettingsStore } from "./settings-client-bus.ts";

const repositorySettingsFor = async (
	environmentId: EnvironmentId,
	projectId: FolderId,
): Promise<RepositorySettings | null> => {
	const repositorySettings = useRepositorySettingsStore.getState();
	return (
		repositorySettings.byProject[
			repositorySettingsKey(environmentId, projectId)
		] ?? (await repositorySettings.refresh(environmentId, projectId))
	);
};

export const effectiveChatRuntimeMode = (
	globalDefault: RuntimeMode,
	repositorySettings: Pick<RepositorySettings, "defaultRuntimeMode"> | null,
): RuntimeMode => repositorySettings?.defaultRuntimeMode ?? globalDefault;

/** Resolve the repository override before creating a new chat/session. */
export async function resolveChatRuntimeMode(
	environmentId: EnvironmentId,
	projectId: FolderId,
): Promise<RuntimeMode> {
	return effectiveChatRuntimeMode(
		useSettingsStore.getState().defaultRuntimeMode,
		await repositorySettingsFor(environmentId, projectId),
	);
}
