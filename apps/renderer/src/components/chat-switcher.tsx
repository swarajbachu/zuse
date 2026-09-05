import type { Chat, FolderId } from "@zuse/contracts";
import fuzzysort from "fuzzysort";
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
import { cn } from "~/lib/utils";
import {
	type ChatSwitcherCommandRow,
	commandRowsForQuery,
	commandSearchQuery,
} from "../lib/chat-switcher-commands.ts";
import { dispatchCommand } from "../lib/commands.ts";
import { useActiveEnvironmentEntities } from "../lib/environment-entity-hooks.ts";
import { useChatsStore } from "../store/chats.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";

/**
 * Cross-project quick open (Cmd+K). Its default mode lists every non-archived
 * chat across every project; prefixing the query with `>` instead searches
 * safe application commands from the shared command registry. Selecting a
 * chat in another project automatically switches the active project too —
 * that's handled inside `useChatsStore.select`.
 *
 * Modeled on the keyboard-list pattern in `composer/slash-command-popover.tsx`
 * (fuzzysort + arrow-key highlight) but presented as a centered modal.
 */
export function ChatSwitcher() {
	const open = useUiStore((s) => s.chatSwitcherOpen);
	if (!open) return null;
	return <ChatSwitcherInner />;
}

interface ChatRow {
	readonly kind: "chat";
	readonly chat: Chat;
	readonly projectId: FolderId;
	readonly projectName: string;
	/** Pre-lowercased title used for the empty-query recents label / fuzzy keys. */
	readonly title: string;
}

type Row = ChatRow | ChatSwitcherCommandRow;

const recencyOf = (chat: Chat): number =>
	(chat.lastMessageAt ?? chat.updatedAt ?? chat.createdAt).getTime();

function ChatSwitcherInner() {
	const folders = useWorkspaceStore((s) => s.folders);
	const { chatsByProject } = useActiveEnvironmentEntities();
	const selectedChatId = useChatsStore((s) => s.selectedChatId);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listId = useId();
	const confirmedRef = useRef(false);

	const close = () => useUiStore.getState().setChatSwitcherOpen(false);

	// All non-archived chats across all projects, with their project name.
	const allRows = useMemo<ReadonlyArray<ChatRow>>(() => {
		const projectName = new Map<FolderId, string>(
			folders.map((f) => [f.id, f.name]),
		);
		const rows: ChatRow[] = [];
		for (const [pid, chats] of Object.entries(chatsByProject)) {
			const folderId = pid as FolderId;
			for (const chat of chats) {
				if (chat.archivedAt !== null) continue;
				rows.push({
					kind: "chat",
					chat,
					projectId: folderId,
					projectName: projectName.get(folderId) ?? "Unknown project",
					title: chat.title.length > 0 ? chat.title : "New chat",
				});
			}
		}
		return rows;
	}, [folders, chatsByProject]);

	const [query, setQuery] = useState("");
	const commandMode = commandSearchQuery(query) !== null;

	const rows = useMemo<ReadonlyArray<Row>>(() => {
		if (commandMode) return commandRowsForQuery(query);
		if (query.trim().length === 0) {
			// Recents first across all projects.
			return allRows
				.slice()
				.sort((a, b) => recencyOf(b.chat) - recencyOf(a.chat));
		}
		const ranked = fuzzysort.go(query, allRows, {
			keys: ["title", "projectName"],
			threshold: 0.3,
			limit: 50,
		});
		return ranked.map((r) => r.obj);
	}, [allRows, commandMode, query]);

	const [highlight, setHighlight] = useState(0);
	useEffect(() => setHighlight(0), [rows]);

	const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
	useEffect(() => {
		itemRefs.current[highlight]?.scrollIntoView({ block: "nearest" });
	}, [highlight]);

	const confirm = (row: Row | undefined) => {
		if (row === undefined) return;
		confirmedRef.current = true;
		// Focus commands target content made inert by the modal. Unmount the
		// dialog before dispatch so its focus guard cannot steal the handoff.
		flushSync(close);
		if (row.kind === "command") {
			dispatchCommand(row.command);
			return;
		}
		useChatsStore.getState().select(row.chat.id);
	};

	const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.nativeEvent.isComposing) return;
		if (rows.length === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			e.stopPropagation();
			setHighlight((h) => (h + 1) % rows.length);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			e.stopPropagation();
			setHighlight((h) => (h - 1 + rows.length) % rows.length);
		} else if (e.key === "Enter") {
			e.preventDefault();
			e.stopPropagation();
			confirm(rows[highlight]);
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogPopup
				aria-label="Quick open"
				className="max-w-xl overflow-hidden"
				showCloseButton={false}
				bottomStickOnMobile={false}
				initialFocus={inputRef}
				finalFocus={() => !confirmedRef.current}
			>
				<input
					ref={inputRef}
					role="combobox"
					aria-expanded
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={
						rows[highlight] === undefined ? undefined : `${listId}-${highlight}`
					}
					onKeyDown={onKey}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					aria-label="Search chats and commands"
					placeholder="Search chats… Type > for commands"
					className="h-7 w-full shrink-0 border-b border-border/60 bg-transparent px-3.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring placeholder:text-muted-foreground"
				/>
				<div
					id={listId}
					role="listbox"
					tabIndex={-1}
					aria-label={commandMode ? "Commands" : "Chats"}
					className="min-h-0 flex-1 overflow-y-auto p-1.5"
				>
					{rows.length === 0 ? (
						<p className="px-4 py-6 text-center text-sm text-muted-foreground">
							{commandMode ? "No commands found." : "No chats found."}
						</p>
					) : (
						rows.map((row, i) => {
							const active = i === highlight;
							const isCurrent =
								row.kind === "chat" && row.chat.id === selectedChatId;
							return (
								<button
									key={
										row.kind === "chat" ? row.chat.id : `command:${row.command}`
									}
									ref={(el) => {
										itemRefs.current[i] = el;
									}}
									type="button"
									role="option"
									id={`${listId}-${i}`}
									tabIndex={-1}
									onMouseDown={(e) => e.preventDefault()}
									aria-selected={active}
									onMouseEnter={() => setHighlight(i)}
									onClick={() => confirm(row)}
									className={cn(
										"flex h-7 w-full items-center gap-3 rounded-lg px-2.5 text-left text-sm",
										active
											? "bg-accent text-accent-foreground"
											: "hover:bg-muted/60",
									)}
								>
									{row.kind === "command" ? (
										<>
											<span className="min-w-0 flex-1 truncate text-foreground">
												{row.label}
												<span className="ml-2 text-xs text-muted-foreground">
													{row.description}
												</span>
											</span>
											<span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
												{row.group}
											</span>
										</>
									) : (
										<>
											<span className="min-w-0 flex-1 truncate text-foreground">
												{row.title}
											</span>
											{isCurrent && (
												<span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
													current
												</span>
											)}
											<span className="shrink-0 truncate text-xs text-muted-foreground">
												{row.projectName}
											</span>
										</>
									)}
								</button>
							);
						})
					)}
				</div>
			</DialogPopup>
		</Dialog>
	);
}
