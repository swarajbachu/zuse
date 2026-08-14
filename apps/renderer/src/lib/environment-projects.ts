import type {
	EnvironmentId,
	Folder,
	GithubRepoSummary,
	ProjectTemplate,
	WorkspaceDirectoryListing,
} from "@zuse/contracts";
import {
	CommandId,
	EnvironmentId as EnvironmentIdSchema,
} from "@zuse/contracts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { registerFolder, useWorkspaceStore } from "../store/workspace.ts";
import { dispatchEnvironmentShellCommand } from "./environment-shell-client-bus.ts";

const messageOf = (cause: unknown): string => {
	if (typeof cause === "object" && cause !== null) {
		const record = cause as Record<string, unknown>;
		if (typeof record.reason === "string") return record.reason;
	}
	if (cause instanceof Error) return cause.message;
	return String(cause);
};

const run = async <Payload, Result>(
	environmentId: EnvironmentId | string,
	kind: string,
	payload: Payload,
): Promise<Result> => {
	try {
		return (
			await dispatchEnvironmentShellCommand<Payload, Result>({
				environmentId: EnvironmentIdSchema.make(environmentId),
				kind,
				commandId: CommandId.make(`environment-project:${crypto.randomUUID()}`),
				payload,
			})
		).result;
	} catch (cause) {
		throw new Error(messageOf(cause));
	}
};

const registerResult = async (
	environmentId: string,
	folder: Folder,
): Promise<void> => {
	const catalog = useEnvironmentCatalogStore.getState();
	if (catalog.activeEnvironmentId === environmentId) {
		useWorkspaceStore.setState((state) => registerFolder(state, folder));
		await run(environmentId, "workspace.setSelected", {
			folderId: folder.id,
		}).catch(() => undefined);
	}
};

export const browseEnvironmentDirectory = (
	environmentId: string,
	path: string,
): Promise<WorkspaceDirectoryListing> =>
	run(environmentId, "workspace.browseDirectory", { path });

export const pickEnvironmentFolder = async (
	environmentId: string,
): Promise<string | null> => run(environmentId, "workspace.pickFolder", {});

export const addEnvironmentFolder = async (
	environmentId: string,
	path: string,
): Promise<Folder> => {
	const folder = await run<{ readonly path: string }, Folder>(
		environmentId,
		"workspace.add",
		{ path },
	);
	await registerResult(environmentId, folder);
	return folder;
};

export const cloneEnvironmentProject = async (
	environmentId: string,
	url: string,
	parent: string,
): Promise<Folder> => {
	const folder = await run<
		{ readonly url: string; readonly parent: string },
		Folder
	>(environmentId, "workspace.cloneRepo", { url, parent });
	await registerResult(environmentId, folder);
	return folder;
};

export const createEnvironmentProject = async (
	environmentId: string,
	input: {
		readonly name: string;
		readonly parent: string;
		readonly template: ProjectTemplate;
		readonly alsoCreateGithubRepo: boolean;
	},
): Promise<Folder> => {
	const folder = await run<typeof input, Folder>(
		environmentId,
		"workspace.createProject",
		input,
	);
	await registerResult(environmentId, folder);
	return folder;
};

export const listEnvironmentGithubRepos = (
	environmentId: string,
	limit = 30,
): Promise<{
	readonly repos: ReadonlyArray<GithubRepoSummary>;
	readonly authenticated: boolean;
}> =>
	Promise.all([
		run<{ readonly limit: number }, ReadonlyArray<GithubRepoSummary>>(
			environmentId,
			"workspace.listGithubRepos",
			{ limit },
		),
		run<Record<string, never>, { readonly authenticated: boolean }>(
			environmentId,
			"workspace.ghAuthStatus",
			{},
		),
	]).then(([repos, auth]) => ({ repos, authenticated: auth.authenticated }));
