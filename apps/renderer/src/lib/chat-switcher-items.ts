import type { Chat, Command } from "@zuse/contracts";
import fuzzysort from "fuzzysort";
import {
	type ChatSwitcherCommandRow,
	commandRowsForQuery,
	commandSearchQuery,
} from "./chat-switcher-commands.ts";

export interface ChatSwitcherChatRow {
	readonly kind: "chat";
	readonly chat: Chat;
	readonly projectName: string;
	readonly title: string;
}

export type ChatSwitcherRow = ChatSwitcherChatRow | ChatSwitcherCommandRow;

export interface ChatSwitcherSection {
	readonly label: string;
	readonly rows: ReadonlyArray<ChatSwitcherRow>;
}

const RECENT_LIMIT = 5;
const SEARCH_LIMIT = 20;
const QUICK_ACTIONS: ReadonlySet<Command> = new Set([
	"new-chat",
	"open-project",
	"toggle-terminal",
]);

const recencyOf = ({ chat }: ChatSwitcherChatRow): number =>
	(chat.lastMessageAt ?? chat.updatedAt ?? chat.createdAt).getTime();

/** Keep the landing view small without excluding older chats from search. */
export function chatSwitcherSections(
	chats: ReadonlyArray<ChatSwitcherChatRow>,
	query: string,
): ReadonlyArray<ChatSwitcherSection> {
	const commandQuery = commandSearchQuery(query);
	if (commandQuery !== null) {
		return [{ label: "Commands", rows: commandRowsForQuery(query) }];
	}
	const availableChats = chats.filter((row) => row.chat.archivedAt === null);
	const search = query.trim();
	if (search.length > 0) {
		return [
			{
				label: "Chats",
				rows: fuzzysort
					.go(search, availableChats, {
						keys: ["title", "projectName"],
						threshold: 0.3,
						limit: SEARCH_LIMIT,
					})
					.map((result) => result.obj),
			},
			{ label: "Commands", rows: commandRowsForQuery(`>${search}`) },
		];
	}

	const commands = commandRowsForQuery(">");
	return [
		{
			label: "Recent chats",
			rows: availableChats
				.sort((a, b) => recencyOf(b) - recencyOf(a))
				.slice(0, RECENT_LIMIT),
		},
		{
			label: "Quick actions",
			rows: commands.filter((row) => QUICK_ACTIONS.has(row.command)),
		},
		{
			label: "Settings",
			rows: commands.filter((row) => row.command === "settings"),
		},
	];
}
