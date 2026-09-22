import {
	EnvironmentId,
	type FolderId,
	type RepositorySettings,
	type RuntimeMode,
} from "@zuse/contracts";

import {
	repositorySettingsKey,
	useRepositorySettingsStore,
} from "../store/repository-settings.ts";
import { getActiveEnvironment } from "./rpc-client.ts";
import { resolveEnvironmentSettings } from "./settings-client-bus.ts";

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
	const [settings, repositorySettings] = await Promise.all([
		// Global preferences belong to the settings surface the user configured,
		// not the destination sandbox's image. Capture that owner before awaiting.
		resolveEnvironmentSettings(EnvironmentId.make(getActiveEnvironment())),
		repositorySettingsFor(environmentId, projectId),
	]);
	return effectiveChatRuntimeMode(
		settings.defaultRuntimeMode,
		repositorySettings,
	);
}
