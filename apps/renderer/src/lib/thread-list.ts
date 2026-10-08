import { compareChatRecency } from "@zuse/client-runtime/chat-recency";
import type { Chat, Folder } from "@zuse/contracts";

export type ThreadListEntry = {
	readonly chat: Chat;
	readonly projectName: string;
	readonly projectRoot: string;
};

/**
 * Flattens every non-archived chat across the sidebar's projects into one
 * list, newest user activity first. Chats whose project is not in the sidebar
 * are skipped, so the list never shows threads the tree would hide.
 */
export const buildThreadList = (
	chatsByProject: Readonly<Record<string, ReadonlyArray<Chat>>>,
	folders: ReadonlyArray<Pick<Folder, "id" | "name" | "path">>,
): ReadonlyArray<ThreadListEntry> => {
	const entries: Array<ThreadListEntry> = [];
	for (const folder of folders) {
		for (const chat of chatsByProject[folder.id] ?? []) {
			if (chat.archivedAt !== null) continue;
			entries.push({
				chat,
				projectName: folder.name,
				projectRoot: folder.path,
			});
		}
	}
	return entries.sort((left, right) =>
		compareChatRecency(left.chat, right.chat),
	);
};
