import type { ChatId, Folder, FolderId } from "@zuse/contracts";

import {
	type EnvironmentShellSeed,
	useEnvironmentCatalogStore,
} from "../store/environment-catalog.ts";

export type SwitchEnvironmentResult = {
	readonly switched: boolean;
	readonly selectedFolderId: FolderId | null;
};

/**
 * Environment activation is serialized so selection cannot be applied to a
 * different environment than the shell generation it came from.
 */
let switchInFlight = false;

/**
 * Shared entry point for switching the active environment. Resolves the
 * catalog entry and activates its one qualified environment-shell resource.
 * A newly-created chat/session may be overlaid while the durable stream catches
 * up; messages and every other canonical resource remain in ClientBus.
 */
export const switchToEnvironment = async (input: {
	readonly environmentId: string;
	readonly folderId?: FolderId;
	readonly chatId?: ChatId;
	readonly seed?: EnvironmentShellSeed;
}): Promise<SwitchEnvironmentResult> => {
	if (switchInFlight) return { switched: false, selectedFolderId: null };
	const state = useEnvironmentCatalogStore.getState();
	const entry = state.entries.find(
		(candidate) => candidate.environmentId === input.environmentId,
	);
	if (entry === undefined) {
		return { switched: false, selectedFolderId: null };
	}
	switchInFlight = true;
	try {
		const selectedFolderId = await state.activate(input.environmentId, {
			folderId: input.folderId,
			chatId: input.chatId,
			seed: input.seed,
		});
		return { switched: true, selectedFolderId };
	} finally {
		switchInFlight = false;
	}
};

/**
 * Activates a cloud workspace connection without adding it to the computer
 * catalog. The transient shell lease uses the same ClientBus driver and keeps
 * the supplied folder only as a bounded fallback until synchronization.
 */
export const switchToCloudWorkspace = async (input: {
	readonly workspaceId: string;
	readonly folder: Folder;
	readonly chatId: ChatId;
	readonly seed?: EnvironmentShellSeed;
}): Promise<SwitchEnvironmentResult> => {
	if (switchInFlight) return { switched: false, selectedFolderId: null };
	const catalog = useEnvironmentCatalogStore.getState();
	const fallback = {
		folders: [input.folder],
		originsByFolder: {},
		chatsByProject:
			input.seed === undefined ? {} : { [input.folder.id]: [input.seed.chat] },
		sessionsByProject:
			input.seed === undefined
				? {}
				: { [input.folder.id]: [input.seed.initialSession] },
		creationOperationsByProject: {},
	};
	switchInFlight = true;
	try {
		const selectedFolderId = await catalog.activateTransient(
			input.workspaceId,
			fallback,
			{
				folderId: input.folder.id,
				chatId: input.chatId,
				seed: input.seed,
			},
		);
		return { switched: true, selectedFolderId };
	} finally {
		switchInFlight = false;
	}
};
