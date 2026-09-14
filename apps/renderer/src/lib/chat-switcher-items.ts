import "@zuse/i18n/english/shell";
import type { IconSvgElement } from "@hugeicons/react";
import type { Chat, Command } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import fuzzysort from "fuzzysort";
import type { SettingsSection } from "../store/ui.ts";
import {
	type ChatSwitcherCommandRow,
	commandRowsForQuery,
	commandSearchQuery,
} from "./chat-switcher-commands.ts";
import { SETTINGS_NAVIGATION } from "./settings-navigation.ts";

export interface ChatSwitcherChatRow {
	readonly kind: "chat";
	readonly chat: Chat;
	readonly projectName: string;
	readonly title: string;
}

export interface ChatSwitcherSettingsRow {
	readonly kind: "settings";
	readonly label: string;
	readonly icon: IconSvgElement;
	readonly section: SettingsSection;
}
export type ChatSwitcherRow =
	| ChatSwitcherChatRow
	| ChatSwitcherCommandRow
	| ChatSwitcherSettingsRow;

export interface ChatSwitcherSection {
	readonly label: string;
	readonly rows: ReadonlyArray<ChatSwitcherRow>;
}

const RECENT_LIMIT = 5;
const SEARCH_LIMIT = 20;
const QUICK_ACTIONS: ReadonlySet<Command> = new Set([
	"new-chat",
	"open-project",
	"search-files",
	"new-tab",
	"toggle-terminal",
]);

const SETTINGS_ROWS: ReadonlyArray<ChatSwitcherSettingsRow> =
	SETTINGS_NAVIGATION.map((item) => ({
		kind: "settings",
		label: item.label,
		icon: item.Icon,
		section: item.section,
	}));

const recencyOf = ({ chat }: ChatSwitcherChatRow): number =>
	(chat.lastMessageAt ?? chat.updatedAt ?? chat.createdAt).getTime();

/** Keep the landing view small without excluding older chats from search. */
export function chatSwitcherSections(
	chats: ReadonlyArray<ChatSwitcherChatRow>,
	query: string,
): ReadonlyArray<ChatSwitcherSection> {
	const commandQuery = commandSearchQuery(query);
	if (commandQuery !== null) {
		return [
			{
				label: uiMessage("shell:chat_switcher_items_commands"),
				rows: commandRowsForQuery(query),
			},
		];
	}
	const availableChats = chats.filter((row) => row.chat.archivedAt === null);
	const search = query.trim();
	if (search.length > 0) {
		return [
			{
				label: uiMessage("shell:chat_switcher_items_chats"),
				rows: fuzzysort
					.go(search, availableChats, {
						keys: ["title", "projectName"],
						threshold: 0.3,
						limit: SEARCH_LIMIT,
					})
					.map((result) => result.obj),
			},
			{
				label: uiMessage("shell:chat_switcher_items_commands"),
				rows: commandRowsForQuery(`>${search}`),
			},
			{
				label: uiMessage("shell:chat_switcher_items_settings"),
				rows: fuzzysort
					.go(search, SETTINGS_ROWS, { key: "label", threshold: 0.3 })
					.map((result) => result.obj),
			},
		];
	}

	const commands = commandRowsForQuery(">");
	return [
		{
			label: uiMessage("shell:chat_switcher_items_recent_chats"),
			rows: availableChats
				.sort((a, b) => recencyOf(b) - recencyOf(a))
				.slice(0, RECENT_LIMIT),
		},
		{
			label: uiMessage("shell:chat_switcher_items_quick_actions"),
			rows: commands.filter((row) => QUICK_ACTIONS.has(row.command)),
		},
		{
			label: uiMessage("shell:chat_switcher_items_settings"),
			rows: SETTINGS_ROWS,
		},
		{
			label: uiMessage("shell:chat_switcher_items_workspace"),
			rows: commands.filter(
				(row) =>
					row.group === "Application" &&
					!QUICK_ACTIONS.has(row.command) &&
					row.command !== "settings",
			),
		},
		{
			label: uiMessage("shell:chat_switcher_items_navigation"),
			rows: commands.filter(
				(row) => row.group === "Navigation" && !QUICK_ACTIONS.has(row.command),
			),
		},
	];
}
