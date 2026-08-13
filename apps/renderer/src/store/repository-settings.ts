import type {
	EnvironmentId,
	FolderId,
	RepositorySettings,
	RepositorySettingsPatch,
} from "@zuse/contracts";
import { CommandId } from "@zuse/contracts";
import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

export const repositorySettingsKey = (
	environmentId: EnvironmentId,
	projectId: FolderId,
): string => `${environmentId}:${projectId}`;

type RepoSettingsState = {
	readonly byProject: Readonly<Record<string, RepositorySettings>>;
	readonly error: string | null;
	readonly refresh: (
		environmentId: EnvironmentId,
		projectId: FolderId,
	) => Promise<RepositorySettings | null>;
	readonly update: (
		environmentId: EnvironmentId,
		projectId: FolderId,
		patch: RepositorySettingsPatch,
	) => Promise<RepositorySettings | null>;
};

const formatError = (err: unknown): string => {
	if (err instanceof Error) return err.message;
	if (typeof err === "object" && err !== null && "_tag" in err) {
		return String((err as { _tag: unknown })._tag);
	}
	return String(err);
};

export const useRepositorySettingsStore = create<RepoSettingsState>((set) => ({
	byProject: {},
	error: null,
	refresh: async (environmentId, projectId) => {
		try {
			const { result: settings } = await dispatchEnvironmentShellCommand<
				{ readonly projectId: FolderId },
				RepositorySettings
			>({
				environmentId,
				kind: "repositorySettings.get",
				commandId: CommandId.make(
					`repository-settings-get:${crypto.randomUUID()}`,
				),
				payload: { projectId },
			});
			set((s) => ({
				byProject: {
					...s.byProject,
					[repositorySettingsKey(environmentId, projectId)]: settings,
				},
				error: null,
			}));
			return settings;
		} catch (err) {
			set({ error: formatError(err) });
			return null;
		}
	},
	update: async (environmentId, projectId, patch) => {
		try {
			const { result: settings } = await dispatchEnvironmentShellCommand<
				{
					readonly projectId: FolderId;
					readonly patch: RepositorySettingsPatch;
				},
				RepositorySettings
			>({
				environmentId,
				kind: "repositorySettings.update",
				commandId: CommandId.make(
					`repository-settings-update:${crypto.randomUUID()}`,
				),
				payload: { projectId, patch },
			});
			set((s) => ({
				byProject: {
					...s.byProject,
					[repositorySettingsKey(environmentId, projectId)]: settings,
				},
				error: null,
			}));
			return settings;
		} catch (err) {
			set({ error: formatError(err) });
			return null;
		}
	},
}));
