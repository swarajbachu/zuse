import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ChatId, Command, FolderId } from "@zuse/contracts";
import {
	Add01Icon,
	BubbleChatIcon,
	CommandIcon,
	ComputerTerminal01Icon,
	FolderOpenIcon,
	Layout01Icon,
	Search01Icon,
	Settings01Icon,
} from "@zuse/icons/solid-rounded";
import { useMemo, useState } from "react";
import {
	type ChatSwitcherChatRow,
	type ChatSwitcherRow,
	chatSwitcherSections,
} from "~/lib/chat-switcher-items.ts";
import { formatShortcut } from "~/lib/shortcuts";
import { dispatchCommand } from "../lib/commands.ts";
import { useActiveEnvironmentEntities } from "../lib/environment-entity-hooks.ts";
import { useChatsStore } from "../store/chats.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import {
	CommandPaletteDialog,
	type CommandPaletteGroup,
} from "./ui/command-palette.tsx";

const COMMAND_ICONS: Partial<Record<Command, IconSvgElement>> = {
	"new-chat": Add01Icon,
	"open-project": FolderOpenIcon,
	"new-tab": Layout01Icon,
	"toggle-terminal": ComputerTerminal01Icon,
	"search-files": Search01Icon,
	settings: Settings01Icon,
};

/** Cross-project quick open with bounded recents and shared application commands. */
export function ChatSwitcher() {
	const open = useUiStore((s) => s.chatSwitcherOpen);
	if (!open) return null;
	return <ChatSwitcherInner />;
}

function ChatSwitcherInner() {
	const folders = useWorkspaceStore((s) => s.folders);
	const { chatsByProject } = useActiveEnvironmentEntities();
	const selectedChatId = useChatsStore((s) => s.selectedChatId);
	const chats = useMemo<ReadonlyArray<ChatSwitcherChatRow>>(() => {
		const projectNames = new Map<FolderId, string>(
			folders.map((folder) => [folder.id, folder.name]),
		);
		return Object.entries(chatsByProject).flatMap(([projectId, entries]) =>
			entries.map((chat) => ({
				kind: "chat" as const,
				chat,
				projectName:
					projectNames.get(projectId as FolderId) ?? "Unknown project",
				title: chat.title.length > 0 ? chat.title : "New chat",
			})),
		);
	}, [folders, chatsByProject]);

	return (
		<ChatSwitcherDialog
			chats={chats}
			selectedChatId={selectedChatId}
			onClose={() => useUiStore.getState().setChatSwitcherOpen(false)}
			onSelect={(row) => {
				if (row.kind === "command") dispatchCommand(row.command);
				else if (row.kind === "settings")
					useUiStore.setState({
						view: "settings",
						settingsSection: row.section,
					});
				else useChatsStore.getState().select(row.chat.id);
			}}
		/>
	);
}

export function ChatSwitcherDialog({
	chats,
	selectedChatId,
	onClose,
	onSelect,
}: {
	chats: ReadonlyArray<ChatSwitcherChatRow>;
	selectedChatId: ChatId | null;
	onClose: () => void;
	onSelect: (row: ChatSwitcherRow) => void;
}) {
	const [query, setQuery] = useState("");
	const groups = useMemo<ReadonlyArray<CommandPaletteGroup<ChatSwitcherRow>>>(
		() =>
			chatSwitcherSections(chats, query).map((section) => ({
				label: section.label,
				items: section.rows.map((row) => ({
					id:
						row.kind === "chat"
							? row.chat.id
							: row.kind === "settings"
								? `settings:${row.section.kind}`
								: row.command,
					value: row,
					label: row.kind === "chat" ? row.title : row.label,
					icon: (
						<HugeiconsIcon
							icon={
								row.kind === "chat"
									? BubbleChatIcon
									: row.kind === "settings"
										? row.icon
										: (COMMAND_ICONS[row.command] ?? CommandIcon)
							}
							aria-hidden
							className="size-4 shrink-0 text-muted-foreground"
						/>
					),
					shortcut:
						row.kind === "command" ? formatShortcut(row.command) : undefined,
					detail:
						row.kind === "chat" ? (
							<>
								{row.chat.id === selectedChatId && (
									<span className="shrink-0 text-[11px] text-muted-foreground">
										Current
									</span>
								)}
								<span className="max-w-[30%] truncate text-xs text-muted-foreground">
									{row.projectName}
								</span>
							</>
						) : undefined,
				})),
			})),
		[chats, query, selectedChatId],
	);
	return (
		<CommandPaletteDialog
			label="Quick open"
			inputLabel="Search chats and commands"
			placeholder="Search chats or run a command…"
			query={query}
			onQueryChange={setQuery}
			groups={groups}
			onClose={onClose}
			onSelect={onSelect}
			emptyMessage="No results found. Try another chat, project, or command name."
		/>
	);
}
