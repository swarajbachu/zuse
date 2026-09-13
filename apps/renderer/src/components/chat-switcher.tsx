import "@zuse/i18n/english/chat";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ChatId, Command, FolderId } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
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
import { Schema } from "effect";
import { useMemo, useState } from "react";
import {
	type ChatSwitcherChatRow,
	type ChatSwitcherExtensionRow,
	type ChatSwitcherRow,
	chatSwitcherSections,
} from "~/lib/chat-switcher-items.ts";
import { formatShortcut } from "~/lib/shortcuts";
import { dispatchCommand } from "../lib/commands.ts";
import { useActiveEnvironmentEntities } from "../lib/environment-entity-hooks.ts";
import { extensionActions } from "../lib/extension-client-bus.ts";
import { useExtensionContributions } from "../lib/extension-registry.tsx";
import { getLocalEnvironmentId } from "../lib/rpc-client.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { useChatsStore } from "../store/chats.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import {
	CommandPaletteDialog,
	type CommandPaletteGroup,
} from "./ui/command-palette.tsx";
import { toastManager } from "./ui/toast.tsx";

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
	const contributions = useExtensionContributions();
	const workspace = useActiveContext();
	const environmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	const extensionCommands = useMemo<
		ReadonlyArray<ChatSwitcherExtensionRow>
	>(() => {
		if (environmentId !== getLocalEnvironmentId()) return [];
		const context =
			workspace.status === "ready" && !workspace.worktreePending
				? workspace
				: null;
		return contributions.flatMap((extension) =>
			extension.contributions.commands
				.filter(
					(command) =>
						command.context === "global" ||
						(context !== null &&
							(command.context !== "session" || context.sessionId !== null)),
				)
				.map((command) => ({
					kind: "extension" as const,
					id: `${extension.extensionId}:${command.id}`,
					label: command.title,
					run: async () => {
						await command.run({
							projectId: context?.folderId ?? null,
							sessionId: context?.sessionId ?? null,
							invoke: async (contract, input) =>
								Schema.decodeUnknownSync(contract.output)(
									await extensionActions.invoke(
										extension.extensionId,
										contract.name,
										Schema.decodeUnknownSync(contract.input)(input),
										context === null
											? undefined
											: {
													projectId: context.folderId,
													worktreeId: context.worktreeId,
													sessionId: context.sessionId,
												},
									),
								),
							openSurface: (surfaceId) =>
								window.dispatchEvent(
									new CustomEvent("zuse:extension-open-surface", {
										detail: { extensionId: extension.extensionId, surfaceId },
									}),
								),
							openWorkspacePanel: (panelId) =>
								window.dispatchEvent(
									new CustomEvent("zuse:extension-open-workspace-panel", {
										detail: { extensionId: extension.extensionId, panelId },
									}),
								),
						});
					},
				})),
		);
	}, [contributions, workspace, environmentId]);
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
			extensionCommands={extensionCommands}
			selectedChatId={selectedChatId}
			onClose={() => useUiStore.getState().setChatSwitcherOpen(false)}
			onSelect={(row) => {
				if (row.kind === "extension")
					void row.run().catch((error) =>
						toastManager.add({
							type: "error",
							title: "Extension command failed",
							description:
								error instanceof Error ? error.message : String(error),
						}),
					);
				else if (row.kind === "command") dispatchCommand(row.command);
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

const NO_EXTENSION_COMMANDS: ReadonlyArray<ChatSwitcherExtensionRow> = [];

export function ChatSwitcherDialog({
	extensionCommands = NO_EXTENSION_COMMANDS,
	chats,
	selectedChatId,
	onClose,
	onSelect,
}: {
	chats: ReadonlyArray<ChatSwitcherChatRow>;
	extensionCommands?: ReadonlyArray<ChatSwitcherExtensionRow>;
	selectedChatId: ChatId | null;
	onClose: () => void;
	onSelect: (row: ChatSwitcherRow) => void;
}) {
	const { message: uiMessage } = useUiMessages([
		"chat",
		"shell",
		"commands",
		"settings",
		"extensions",
	]);

	const [query, setQuery] = useState("");
	const groups = useMemo<ReadonlyArray<CommandPaletteGroup<ChatSwitcherRow>>>(
		() =>
			chatSwitcherSections(chats, query, extensionCommands).map((section) => ({
				label: section.label,
				items: section.rows.map((row) => ({
					id:
						row.kind === "chat"
							? row.chat.id
							: row.kind === "settings"
								? `settings:${row.section.kind}`
								: row.kind === "extension"
									? row.id
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
										: row.kind === "extension"
											? CommandIcon
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
										{uiMessage("chat:chat_switcher_current")}
									</span>
								)}
								<span className="max-w-[30%] truncate text-xs text-muted-foreground">
									{row.projectName}
								</span>
							</>
						) : undefined,
				})),
			})),
		[chats, query, selectedChatId, extensionCommands, uiMessage],
	);
	return (
		<CommandPaletteDialog
			label={uiMessage("chat:chat_switcher_quick_open")}
			inputLabel="Search chats and commands"
			placeholder={uiMessage(
				"chat:chat_switcher_search_chats_or_run_a_command",
			)}
			query={query}
			onQueryChange={setQuery}
			groups={groups}
			onClose={onClose}
			onSelect={onSelect}
			emptyMessage={uiMessage(
				"chat:chat_switcher_no_results_found_try_another_chat_project_or_command_name",
			)}
		/>
	);
}
