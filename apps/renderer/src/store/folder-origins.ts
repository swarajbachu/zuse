import type { FolderId, GitOriginInfo } from "@zuse/contracts";
import { Effect } from "effect";

import { getRpcClient } from "../lib/rpc-client.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

type FolderOriginsState = {
	/**
	 * Git origin per ACTIVE-environment folder id. `null` = no origin (or the
	 * lookup failed) — callers fall back to initials/name rendering. Folder ids
	 * are globally unique, so entries from previously active environments can
	 * stay cached without colliding.
	 */
	readonly byFolder: Readonly<Record<string, GitOriginInfo | null>>;
	readonly hydrate: (folderIds: ReadonlyArray<FolderId>) => Promise<void>;
};

const inFlight = new Set<string>();

/**
 * Single source of truth for "which repo is this folder" on the active
 * environment — shared by the projects sidebar (avatars, logical grouping)
 * and the chat-landing pickers.
 */
export const useFolderOriginsStore = create<FolderOriginsState>((set, get) => ({
	byFolder: {},
	hydrate: async (folderIds) => {
		const missing = folderIds.filter(
			(id) => !(id in get().byFolder) && !inFlight.has(id),
		);
		if (missing.length === 0) return;
		for (const id of missing) inFlight.add(id);
		try {
			const client = await getRpcClient();
			for (const id of missing) {
				try {
					const info = await Effect.runPromise(
						client["git.origin"]({ folderId: id }),
					);
					set((state) => ({ byFolder: { ...state.byFolder, [id]: info } }));
				} catch {
					set((state) => ({ byFolder: { ...state.byFolder, [id]: null } }));
				}
			}
		} finally {
			for (const id of missing) inFlight.delete(id);
		}
	},
}));
