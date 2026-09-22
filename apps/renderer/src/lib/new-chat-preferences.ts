import type { ComposerWorkspaceMode } from "../components/composer/workspace-picker.tsx";

type StoredPreferences = {
	readonly lastProjectKey?: string;
	readonly environmentByProject?: Readonly<Record<string, string>>;
	readonly workspaceByProject?: Readonly<Record<string, ComposerWorkspaceMode>>;
};

const STORAGE_KEY = "zuse.newChatPreferences.v1";

const read = (): StoredPreferences => {
	if (typeof window === "undefined") return {};
	try {
		const value: unknown = JSON.parse(
			window.localStorage.getItem(STORAGE_KEY) ?? "{}",
		);
		if (typeof value !== "object" || value === null) return {};
		const candidate = value as Record<string, unknown>;
		const stringRecord = (input: unknown): Readonly<Record<string, string>> =>
			typeof input === "object" && input !== null
				? Object.fromEntries(
						Object.entries(input).filter(
							(entry): entry is [string, string] =>
								typeof entry[1] === "string",
						),
					)
				: {};
		const workspaceByProject = Object.fromEntries(
			Object.entries(stringRecord(candidate.workspaceByProject)).filter(
				([, mode]) => mode === "local" || mode === "worktree",
			),
		) as Readonly<Record<string, ComposerWorkspaceMode>>;
		return {
			...(typeof candidate.lastProjectKey === "string"
				? { lastProjectKey: candidate.lastProjectKey }
				: {}),
			environmentByProject: stringRecord(candidate.environmentByProject),
			workspaceByProject,
		};
	} catch {
		return {};
	}
};

const write = (value: StoredPreferences): void => {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
	} catch {
		// The choices remain usable for this session when storage is unavailable.
	}
};

export const newChatPreferences = {
	lastProjectKey: (): string | null => read().lastProjectKey ?? null,
	environmentFor: (projectKey: string): string | null =>
		read().environmentByProject?.[projectKey] ?? null,
	workspaceFor: (projectKey: string): ComposerWorkspaceMode =>
		read().workspaceByProject?.[projectKey] === "local" ? "local" : "worktree",
	rememberProject: (projectKey: string): void =>
		write({ ...read(), lastProjectKey: projectKey }),
	rememberEnvironment: (projectKey: string, environmentId: string): void => {
		const current = read();
		write({
			...current,
			lastProjectKey: projectKey,
			environmentByProject: {
				...current.environmentByProject,
				[projectKey]: environmentId,
			},
		});
	},
	rememberWorkspace: (
		projectKey: string,
		mode: ComposerWorkspaceMode,
	): void => {
		const current = read();
		write({
			...current,
			lastProjectKey: projectKey,
			workspaceByProject: {
				...current.workspaceByProject,
				[projectKey]: mode,
			},
		});
	},
};
