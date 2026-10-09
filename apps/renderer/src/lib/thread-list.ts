import { chatRecency } from "@zuse/client-runtime/chat-recency";
import type { Chat, CloudChatSummary, Folder } from "@zuse/contracts";
import type { LogicalChatRef } from "./project-groups.ts";

/** A chat from another computer, as the project tree renders it. */
export type ThreadListRemoteChat = {
	readonly ref: LogicalChatRef;
	readonly connected: boolean;
	readonly repositoryName: string;
};

export type ThreadListEntry =
	| {
			readonly kind: "local";
			readonly id: string;
			readonly recency: number;
			readonly chat: Chat;
			readonly projectName: string;
			readonly projectRoot: string;
	  }
	| {
			readonly kind: "remote";
			readonly id: string;
			readonly recency: number;
			readonly remote: ThreadListRemoteChat;
	  }
	| {
			readonly kind: "cloud";
			readonly id: string;
			readonly recency: number;
			readonly summary: CloudChatSummary;
	  };

const cloudChatVisible = (summary: CloudChatSummary): boolean =>
	summary.archivedAt === undefined &&
	summary.desiredState !== "archived" &&
	summary.desiredState !== "deleted" &&
	summary.state !== "archived" &&
	summary.state !== "deleted";

/**
 * Every chat the project tree would show, flattened into one list, newest
 * user activity first: live chats from the sidebar's projects, chats on other
 * computers, and cloud chats. Mirrors the tree's per-project merge, including
 * its rule that a local chat backed by a cloud workspace renders as the cloud
 * row. Chats whose project is not in the sidebar are skipped.
 */
export const buildThreadList = ({
	chatsByProject,
	folders,
	remoteChats = [],
	cloudChats = [],
	hiddenChatIds = new Set<string>(),
}: {
	readonly chatsByProject: Readonly<Record<string, ReadonlyArray<Chat>>>;
	readonly folders: ReadonlyArray<Pick<Folder, "id" | "name" | "path">>;
	readonly remoteChats?: ReadonlyArray<ThreadListRemoteChat>;
	readonly cloudChats?: ReadonlyArray<CloudChatSummary>;
	readonly hiddenChatIds?: ReadonlySet<string>;
}): ReadonlyArray<ThreadListEntry> => {
	const entries: Array<ThreadListEntry> = [];
	const seen = new Set<string>();
	for (const summary of cloudChats) {
		if (!cloudChatVisible(summary) || hiddenChatIds.has(summary.chatId))
			continue;
		if (seen.has(summary.chatId)) continue;
		seen.add(summary.chatId);
		entries.push({
			kind: "cloud",
			id: summary.chatId,
			recency: chatRecency(summary),
			summary,
		});
	}
	const cloudIds = new Set(cloudChats.map((summary) => summary.chatId));
	for (const folder of folders) {
		for (const chat of chatsByProject[folder.id] ?? []) {
			if (chat.archivedAt !== null) continue;
			if (cloudIds.has(chat.id) || hiddenChatIds.has(chat.id)) continue;
			entries.push({
				kind: "local",
				id: chat.id,
				recency: chatRecency(chat).getTime(),
				chat,
				projectName: folder.name,
				projectRoot: folder.path,
			});
		}
	}
	for (const remote of remoteChats) {
		if (remote.ref.chat.archivedAt !== null) continue;
		entries.push({
			kind: "remote",
			id: `${remote.ref.environmentId}:${remote.ref.chat.id}`,
			recency: chatRecency(remote.ref.chat).getTime(),
			remote,
		});
	}
	return entries.sort(
		(left, right) =>
			right.recency - left.recency || left.id.localeCompare(right.id),
	);
};
