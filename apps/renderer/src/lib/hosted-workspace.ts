import {
	type CloudProject,
	EnvironmentId,
	Folder,
	FolderId,
} from "@zuse/contracts";
import { batchAtomUpdates } from "../state/registry.tsx";
import { useChatsStore } from "../store/chats.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { loadCloudProjects } from "./cloud-workspace-session-cache.ts";
import { environmentShellResourceKey } from "./environment-shell-client-bus.ts";
import { openNewChatLanding } from "./open-new-chat-landing.ts";
import { setActiveEnvironment } from "./rpc-client.ts";
import { getRendererClientBus } from "./session-timeline-client-bus.ts";

export const hostedProjectFolderId = (projectId: string): FolderId =>
	FolderId.make(`cloud-project:${projectId}`);
export const seedHostedProjects = (
	projects: ReadonlyArray<CloudProject>,
): void => {
	const folders = projects.map((p) =>
		Folder.make({
			id: hostedProjectFolderId(p.projectId),
			name: p.displayName,
			path: p.repositoryUrl,
			addedAt: new Date(p.createdAt),
		}),
	);
	const key = environmentShellResourceKey({
		environmentId: EnvironmentId.make("local"),
	});
	const bus = getRendererClientBus();
	bus.snapshot(key);
	bus.overlay(key, {
		initialData: {
			folders: [],
			originsByFolder: {},
			chatsByProject: {},
			sessionsByProject: {},
			creationOperationsByProject: {},
		},
		update: (shell) => ({
			...shell,
			folders,
			originsByFolder: Object.fromEntries(
				projects.map((p) => {
					const [host, owner, ...repo] = p.repositoryIdentity.split("/");
					return [
						hostedProjectFolderId(p.projectId),
						{
							host: host ?? "github.com",
							owner: owner ?? "",
							repo: repo.join("/"),
							cloneUrl: p.repositoryUrl,
						},
					];
				}),
			),
		}),
	});
	if (useEnvironmentCatalogStore.getState().activeEnvironmentId === "local") {
		const previous = useWorkspaceStore.getState().selectedFolderId;
		useWorkspaceStore.setState({
			folders,
			selectedFolderId: folders.some((f) => f.id === previous)
				? previous
				: (folders[0]?.id ?? null),
			loading: false,
		});
	}
};
export const refreshHostedProjects = async (refresh = false): Promise<void> =>
	seedHostedProjects((await loadCloudProjects(refresh)).projects);
export const selectHostedCloudHome = (projectId?: FolderId): void => {
	batchAtomUpdates(() => {
		setActiveEnvironment("local");
		useEnvironmentCatalogStore.setState({ activeEnvironmentId: "local" });
		const shell = getRendererClientBus().snapshot(
			environmentShellResourceKey({
				environmentId: EnvironmentId.make("local"),
			}),
		).data;
		const preferred =
			projectId ?? useWorkspaceStore.getState().selectedFolderId;
		const selectedFolderId =
			shell?.folders.find((f) => f.id === preferred)?.id ??
			shell?.folders[0]?.id ??
			null;
		useWorkspaceStore.setState({
			folders: shell?.folders ?? [],
			selectedFolderId,
			loading: false,
		});
		if (selectedFolderId !== null) openNewChatLanding(selectedFolderId);
		else {
			useChatsStore.getState().select(null);
			useUiStore.getState().setSettingsSection({ kind: "machines" });
			useUiStore.getState().setView("settings");
		}
	});
};
