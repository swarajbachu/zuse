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
import { isCloudProjectFolder } from "./cloud-project-folders.ts";
import { getActiveEnvironment } from "./rpc-client.ts";
import { resolveEnvironmentSettings } from "./settings-client-bus.ts";

const repositorySettingsFor = async (
	environmentId: EnvironmentId,
	projectId: FolderId,
): Promise<RepositorySettings | null> => {
	if (isCloudProjectFolder(projectId)) return null;
	const repositorySettings = useRepositorySettingsStore.getState();
	return (
		repositorySettings.byProject[
			repositorySettingsKey(environmentId, projectId)
		] ?? (await repositorySettings.refresh(environmentId, projectId))
	);
};

// Runtime modes ordered by how much they auto-approve. A repository may
// tighten the user's default but must never raise it — otherwise a cloned
// repo could silently disable the permission prompts the user relies on.
const RUNTIME_MODE_RANK: Record<RuntimeMode, number> = {
	"approval-required": 0,
	"auto-accept-edits": 1,
	"auto-accept-edits-and-bash": 2,
	auto: 3,
	"full-access": 4,
};

export const effectiveChatRuntimeMode = (
	globalDefault: RuntimeMode,
	repositorySettings: Pick<RepositorySettings, "defaultRuntimeMode"> | null,
): RuntimeMode => {
	const repositoryMode = repositorySettings?.defaultRuntimeMode;
	if (repositoryMode === null || repositoryMode === undefined) {
		return globalDefault;
	}
	return RUNTIME_MODE_RANK[repositoryMode] <= RUNTIME_MODE_RANK[globalDefault]
		? repositoryMode
		: globalDefault;
};

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
