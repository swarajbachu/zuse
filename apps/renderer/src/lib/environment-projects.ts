import type {
	Folder,
	GithubRepoSummary,
	ProjectTemplate,
	WorkspaceDirectoryListing,
} from "@zuse/contracts";
import { Effect } from "effect";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { getRpcClient } from "./rpc-client.ts";

const messageOf = (cause: unknown): string => {
	if (cause instanceof Error) return cause.message;
	if (typeof cause === "object" && cause !== null) {
		const record = cause as Record<string, unknown>;
		if (typeof record.reason === "string") return record.reason;
	}
	return String(cause);
};

const run = async <A>(
	environmentId: string,
	operation: (
		client: Awaited<ReturnType<typeof getRpcClient>>,
	) => Effect.Effect<A, unknown>,
): Promise<A> => {
	try {
		const client = await getRpcClient(environmentId);
		return await Effect.runPromise(operation(client));
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
		useWorkspaceStore.setState((state) => ({
			folders: state.folders.some((item) => item.id === folder.id)
				? state.folders
				: [...state.folders, folder],
			selectedFolderId: folder.id,
		}));
		await run(environmentId, (client) =>
			client["workspace.setSelected"]({ folderId: folder.id }),
		).catch(() => undefined);
	}
	await catalog.refreshEnvironment(environmentId);
};

export const browseEnvironmentDirectory = (
	environmentId: string,
	path: string,
): Promise<WorkspaceDirectoryListing> =>
	run(environmentId, (client) => client["workspace.browseDirectory"]({ path }));

export const pickEnvironmentFolder = async (
	environmentId: string,
): Promise<string | null> =>
	run(environmentId, (client) => client["workspace.pickFolder"]({}));

export const addEnvironmentFolder = async (
	environmentId: string,
	path: string,
): Promise<Folder> => {
	const folder = await run(environmentId, (client) =>
		client["workspace.add"]({ path }),
	);
	await registerResult(environmentId, folder);
	return folder;
};

export const cloneEnvironmentProject = async (
	environmentId: string,
	url: string,
	parent: string,
): Promise<Folder> => {
	const folder = await run(environmentId, (client) =>
		client["workspace.cloneRepo"]({ url, parent }),
	);
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
	const folder = await run(environmentId, (client) =>
		client["workspace.createProject"](input),
	);
	await registerResult(environmentId, folder);
	return folder;
};

export const listEnvironmentGithubRepos = (
	environmentId: string,
): Promise<{
	readonly repos: ReadonlyArray<GithubRepoSummary>;
	readonly authenticated: boolean;
}> =>
	Promise.all([
		run(environmentId, (client) =>
			client["workspace.listGithubRepos"]({ limit: 30 }),
		),
		run(environmentId, (client) => client["workspace.ghAuthStatus"]({})),
	]).then(([repos, auth]) => ({ repos, authenticated: auth.authenticated }));
