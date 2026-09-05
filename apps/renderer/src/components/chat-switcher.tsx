import type { ChatId, Command, FolderId } from "@zuse/contracts";
import {
	ArrowDown,
	ArrowUp,
	Command as CommandIcon,
	CornerDownLeft,
	FolderOpen,
	MessageSquare,
	PanelTop,
	Plus,
	Search,
	Settings,
	Terminal,
} from "lucide-react";
import {
	type KeyboardEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { Dialog, DialogPopup } from "~/components/ui/dialog";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import {
	type ChatSwitcherChatRow,
	type ChatSwitcherRow,
	chatSwitcherSections,
} from "~/lib/chat-switcher-items.ts";
import { formatShortcut } from "~/lib/shortcuts";
import { cn } from "~/lib/utils";
import { dispatchCommand } from "../lib/commands.ts";
import { useActiveEnvironmentEntities } from "../lib/environment-entity-hooks.ts";
import { useChatsStore } from "../store/chats.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";

const COMMAND_ICONS: Partial<Record<Command, typeof Plus>> = {
	"new-chat": Plus,
	"open-project": FolderOpen,
	"new-tab": PanelTop,
	"toggle-terminal": Terminal,
	settings: Settings,
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
				else useChatsStore.getState().select(row.chat.id);
			}}
		/>
	);
}

/** The dialog owns search and keyboard navigation; its caller owns navigation. */
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
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const listId = useId();
	const confirmedRef = useRef(false);
	const [query, setQuery] = useState("");
	const sections = useMemo(
		() =>
			chatSwitcherSections(chats, query).filter(
				(group) => group.rows.length > 0,
			),
		[chats, query],
	);
	const rows = useMemo(
		() => sections.flatMap((group) => group.rows),
		[sections],
	);
	const [highlight, setHighlight] = useState(0);
	useEffect(() => {
		setHighlight(0);
		listRef.current?.scrollTo({ top: 0 });
	}, [rows]);

	const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
	useEffect(() => {
		itemRefs.current[highlight]?.scrollIntoView({ block: "nearest" });
	}, [highlight]);

	const confirm = (row: ChatSwitcherRow | undefined) => {
		if (row === undefined) return;
		confirmedRef.current = true;
		// Focus commands target content made inert by the modal. Unmount the
		// dialog before dispatch so its focus guard cannot steal the handoff.
		flushSync(onClose);
		onSelect(row);
	};

	const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.nativeEvent.isComposing || rows.length === 0) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			const direction = event.key === "ArrowDown" ? 1 : -1;
			setHighlight((index) => (index + direction + rows.length) % rows.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			confirm(rows[highlight]);
		}
	};

	let rowIndex = 0;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogPopup
				aria-label="Quick open"
				className="max-h-[min(440px,calc(100dvh-64px))] max-w-xl overflow-hidden"
				showCloseButton={false}
				bottomStickOnMobile={false}
				initialFocus={inputRef}
				finalFocus={() => !confirmedRef.current}
			>
				<div className="flex shrink-0 items-center gap-2.5 border-b border-border/50 px-4 py-2.5 focus-within:border-ring/60">
					<Search
						aria-hidden
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<input
						ref={inputRef}
						role="combobox"
						aria-expanded
						aria-controls={listId}
						aria-autocomplete="list"
						aria-activedescendant={
							rows[highlight] === undefined
								? undefined
								: `${listId}-${highlight}`
						}
						onKeyDown={onKey}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						aria-label="Search chats and commands"
						placeholder="Search chats or run a command…"
						className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
					/>
				</div>
				<div
					ref={listRef}
					id={listId}
					role="listbox"
					tabIndex={-1}
					aria-label="Chats and commands"
					className="min-h-0 overflow-y-auto overscroll-contain p-1.5"
				>
					{sections.length === 0 ? (
						<div className="px-4 py-8 text-center text-sm">
							<p>No results found</p>
							<p className="mt-1 text-xs text-muted-foreground">
								Try another chat, project, or command name.
							</p>
						</div>
					) : (
						sections.map((section, sectionIndex) => (
							<fieldset
								key={section.label}
								aria-labelledby={`${listId}-group-${sectionIndex}`}
								className="min-w-0 pb-1 last:pb-0 [&+&]:border-t [&+&]:border-border/40 [&+&]:pt-1"
							>
								<div
									id={`${listId}-group-${sectionIndex}`}
									className="px-2.5 py-1 text-[11px] font-medium leading-4 text-muted-foreground"
								>
									{section.label}
								</div>
								{section.rows.map((row) => {
									const index = rowIndex++;
									const Icon =
										row.kind === "chat"
											? MessageSquare
											: (COMMAND_ICONS[row.command] ?? CommandIcon);
									const shortcut =
										row.kind === "command" ? formatShortcut(row.command) : "";
									return (
										<button
											key={row.kind === "chat" ? row.chat.id : row.command}
											ref={(element) => {
												itemRefs.current[index] = element;
											}}
											type="button"
											role="option"
											id={`${listId}-${index}`}
											tabIndex={-1}
											onMouseDown={(event) => event.preventDefault()}
											aria-selected={index === highlight}
											onMouseMove={() => setHighlight(index)}
											onClick={() => confirm(row)}
											className={cn(
												"flex h-7 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring",
												index === highlight
													? "bg-accent text-accent-foreground"
													: "hover:bg-muted/60",
											)}
										>
											<Icon
												aria-hidden
												className="size-3.5 shrink-0 text-muted-foreground"
											/>
											<span className="min-w-0 flex-1 truncate">
												{row.kind === "chat" ? row.title : row.label}
											</span>
											{row.kind === "chat" ? (
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
											) : shortcut ? (
												<Kbd className="h-4 bg-transparent px-0 text-[11px]">
													{shortcut}
												</Kbd>
											) : null}
										</button>
									);
								})}
							</fieldset>
						))
					)}
				</div>
				<div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/50 bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
					<div className="flex items-center gap-3">
						<span className="flex items-center gap-1.5">
							<KbdGroup>
								<Kbd>
									<ArrowUp aria-label="Up arrow" />
								</Kbd>
								<Kbd>
									<ArrowDown aria-label="Down arrow" />
								</Kbd>
							</KbdGroup>
							Navigate
						</span>
						<span className="flex items-center gap-1.5">
							<Kbd>
								<CornerDownLeft aria-label="Enter" />
							</Kbd>
							Open
						</span>
					</div>
					<span className="flex items-center gap-1.5">
						<Kbd>Esc</Kbd>Close
					</span>
				</div>
			</DialogPopup>
		</Dialog>
	);
}
