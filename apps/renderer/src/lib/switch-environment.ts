import type { ChatId, FolderId } from "@zuse/contracts";

import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { activateEnvironmentState } from "../store/environment-state-coordinator.ts";

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
 * `activateEnvironmentState` — optionally carrying the current composer text
 * into the landing draft of the folder that ends up selected.
 */
export const switchToEnvironment = async (input: {
	readonly environmentId: string;
	readonly folderId?: FolderId;
	readonly chatId?: ChatId;
	readonly carryComposerDraft?: { readonly doc: string };
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
			carryComposerDraft: input.carryComposerDraft,
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
