import type { ChatId, Folder, FolderId } from "@zuse/contracts";

import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import {
	type ActivateEnvironmentSeed,
	activateEnvironmentState,
} from "../store/environment-state-coordinator.ts";
import { setActiveEnvironment } from "./rpc-client.ts";

export type SwitchEnvironmentResult = {
	readonly switched: boolean;
	readonly selectedFolderId: FolderId | null;
};

/**
 * Overlapping switches would interleave snapshot capture/restore and corrupt
 * both environments' state, so while one switch is in flight every other call
 * is dropped. Module-level because the composer, sidebar, and dialogs can all
 * trigger a switch.
 */
let switchInFlight = false;

/**
 * Shared entry point for switching the active environment. Resolves the
 * catalog entry, refuses anything that is not connected, and hands off to
 * `activateEnvironmentState` — optionally seeding a chat that was just
 * created on the target environment so it can be selected immediately.
 */
export const switchToEnvironment = async (input: {
	readonly environmentId: string;
	readonly folderId?: FolderId;
	readonly chatId?: ChatId;
	readonly seed?: ActivateEnvironmentSeed;
}): Promise<SwitchEnvironmentResult> => {
	if (switchInFlight) return { switched: false, selectedFolderId: null };
	const state = useEnvironmentCatalogStore.getState();
	const entry = state.entries.find(
		(candidate) => candidate.environmentId === input.environmentId,
	);
	if (entry === undefined || entry.status !== "connected") {
		return { switched: false, selectedFolderId: null };
	}
	switchInFlight = true;
	try {
		const selectedFolderId = await activateEnvironmentState({
			fromEnvironmentId: state.activeEnvironmentId,
			entry,
			folderId: input.folderId,
			chatId: input.chatId,
			seed: input.seed,
			activateConnection: state.activate,
			resolveEntry: (environmentId) =>
				useEnvironmentCatalogStore
					.getState()
					.entries.find(
						(candidate) => candidate.environmentId === environmentId,
					),
		});
		return { switched: true, selectedFolderId };
	} finally {
		switchInFlight = false;
	}
};

/**
 * Activates a cloud workspace connection without adding it to the computer
 * catalog. The shared state coordinator is transport-agnostic; the synthetic
 * entry only supplies the freshly hydrated workspace state for this switch.
 */
export const switchToCloudWorkspace = async (input: {
	readonly workspaceId: string;
	readonly folder: Folder;
	readonly chatId: ChatId;
	readonly seed?: ActivateEnvironmentSeed;
}): Promise<SwitchEnvironmentResult> => {
	if (switchInFlight) return { switched: false, selectedFolderId: null };
	const catalog = useEnvironmentCatalogStore.getState();
	const entry = {
		connectionKind: "relay" as const,
		environmentId: input.workspaceId,
		profileId: null,
		label: "Cloud workspace",
		target: null,
		descriptor: null,
		status: "connected" as const,
		error: null,
		folders: [input.folder],
		originsByFolder: {},
		chatsByProject: {},
		sessionsByProject: {},
	};
	switchInFlight = true;
	try {
		const selectedFolderId = await activateEnvironmentState({
			fromEnvironmentId: catalog.activeEnvironmentId,
			entry,
			folderId: input.folder.id,
			chatId: input.chatId,
			seed: input.seed,
			activateConnection: async () => {
				setActiveEnvironment(input.workspaceId);
				useEnvironmentCatalogStore.setState({
					activeEnvironmentId: input.workspaceId,
				});
			},
			resolveEntry: () => entry,
		});
		return { switched: true, selectedFolderId };
	} finally {
		switchInFlight = false;
	}
};
