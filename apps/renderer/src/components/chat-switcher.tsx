import type { Chat, FolderId } from "@zuse/contracts";
import { Schema } from "effect";
import fuzzysort from "fuzzysort";
import { useEffect, useMemo, useRef, useState } from "react";
import { overlaySurface } from "~/components/ui/overlay-surface";
import { cn } from "~/lib/utils";
import { useActiveEnvironmentEntities } from "../lib/environment-entity-hooks.ts";
import { extensionActions } from "../lib/extension-client-bus.ts";
import { useExtensionContributions } from "../lib/extension-registry.tsx";
import { useChatsStore } from "../store/chats.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";

/**
 * Cross-project chat quick-switcher (Cmd+K). Lists every non-archived chat
 * across every project; fuzzy-search by chat title or project name, then jump
 * with Enter. Selecting a chat in another project automatically switches the
 * active project too — that's handled inside `useChatsStore.select`, so this
 * component just decides *which* chat and calls it.
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
	readonly _tag: "chat";
	readonly chat: Chat;
	readonly projectId: FolderId;
	readonly projectName: string;
	/** Pre-lowercased title used for the empty-query recents label / fuzzy keys. */
	readonly title: string;
}

interface CommandRow {
	readonly _tag: "command";
	readonly extensionId: import("@zuse/contracts").ExtensionId;
	readonly command: import("@zuse/extension-sdk").ExtensionCommandContribution;
	readonly title: string;
	readonly projectName: string;
}

type Row = ChatRow | CommandRow;

const recencyOf = (chat: Chat): number =>
	(chat.lastMessageAt ?? chat.updatedAt ?? chat.createdAt).getTime();

function ChatSwitcherInner() {
	const folders = useWorkspaceStore((s) => s.folders);
	const { chatsByProject } = useActiveEnvironmentEntities();
	const selectedChatId = useChatsStore((s) => s.selectedChatId);
	const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const extensions = useExtensionContributions();

	const close = () => useUiStore.getState().setChatSwitcherOpen(false);

	// Restore focus to wherever the user was when they opened the switcher,
	// but only when they dismiss without picking (selecting navigates focus).
	const prevFocusRef = useRef<HTMLElement | null>(null);
	const searchInputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		prevFocusRef.current = document.activeElement as HTMLElement | null;
		searchInputRef.current?.focus();
		return () => {
			// no-op cleanup; explicit restore happens in `dismiss`.
		};
	}, []);

	// All non-archived chats across all projects, with their project name.
	const allRows = useMemo<ReadonlyArray<Row>>(() => {
		const projectName = new Map<FolderId, string>(
			folders.map((f) => [f.id, f.name]),
		);
		const rows: Row[] = [];
		for (const [pid, chats] of Object.entries(chatsByProject)) {
			const folderId = pid as FolderId;
			for (const chat of chats) {
				if (chat.archivedAt !== null) continue;
				rows.push({
					_tag: "chat",
					chat,
					projectId: folderId,
					projectName: projectName.get(folderId) ?? "Unknown project",
					title: chat.title.length > 0 ? chat.title : "New chat",
				});
			}
		}
		for (const extension of extensions) {
			for (const command of extension.contributions.commands) {
				if (command.context === "project" && selectedFolderId === null)
					continue;
				if (command.context === "session" && selectedSessionId === null)
					continue;
				rows.push({
					_tag: "command",
					extensionId: extension.extensionId,
					command,
					title: command.title,
					projectName: "Extension command",
				});
			}
		}
		return rows;
	}, [
		extensions,
		folders,
		chatsByProject,
		selectedFolderId,
		selectedSessionId,
	]);

	const [query, setQuery] = useState("");

	const rows = useMemo<ReadonlyArray<Row>>(() => {
		if (query.trim().length === 0) {
			// Recents first across all projects.
			return allRows.slice().sort((a, b) => {
				if (a._tag !== b._tag) return a._tag === "command" ? -1 : 1;
				return a._tag === "chat" && b._tag === "chat"
					? recencyOf(b.chat) - recencyOf(a.chat)
					: a.title.localeCompare(b.title);
			});
		}
		const ranked = fuzzysort.go(query, allRows, {
			keys: ["title", "projectName"],
			threshold: 0.3,
			limit: 50,
		});
		return ranked.map((r) => r.obj);
	}, [allRows, query]);

	const [highlight, setHighlight] = useState(0);
	useEffect(() => setHighlight(0), [rows]);

	const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
	useEffect(() => {
		itemRefs.current[highlight]?.scrollIntoView({ block: "nearest" });
	}, [highlight]);

	const dismiss = () => {
		close();
		prevFocusRef.current?.focus?.();
	};

	const confirm = (row: Row | undefined) => {
		if (row === undefined) return;
		close();
		if (row._tag === "chat") {
			useChatsStore.getState().select(row.chat.id);
			return;
		}
		void row.command.run({
			projectId: selectedFolderId,
			sessionId: selectedSessionId,
			invoke: async (contract, input) => {
				const validInput = Schema.decodeUnknownSync(contract.input)(input);
				const output = await extensionActions.invoke(
					row.extensionId,
					contract.name,
					validInput,
				);
				return Schema.decodeUnknownSync(contract.output)(output);
			},
			openSurface: (surfaceId) =>
				window.dispatchEvent(
					new CustomEvent("zuse:extension-open-surface", {
						detail: { extensionId: row.extensionId, surfaceId },
					}),
				),
			openWorkspacePanel: (panelId) =>
				window.dispatchEvent(
					new CustomEvent("zuse:extension-open-workspace-panel", {
						detail: { extensionId: row.extensionId, panelId },
					}),
				),
		});
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				dismiss();
				return;
			}
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
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [rows, highlight]);

	return (
		<div className="fixed inset-0 z-50 flex justify-center px-4 py-[12vh]">
			<button
				type="button"
				aria-label="Close chat switcher"
				className="absolute inset-0 bg-black/40 backdrop-blur-sm"
				onClick={dismiss}
			/>
			<div
				role="dialog"
				aria-label="Switch chat"
				className={cn(
					"relative flex h-fit max-h-full w-full max-w-xl flex-col overflow-hidden",
					overlaySurface,
				)}
				onMouseDown={(e) => e.stopPropagation()}
			>
				<input
					ref={searchInputRef}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search chats across all projects…"
					className="w-full shrink-0 border-b border-border/60 bg-transparent px-3.5 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
				/>
				<div role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
					{rows.length === 0 ? (
						<p className="px-4 py-6 text-center text-sm text-muted-foreground">
							No chats found.
						</p>
					) : (
						rows.map((row, i) => {
							const active = i === highlight;
							const isCurrent =
								row._tag === "chat" && row.chat.id === selectedChatId;
							return (
								<button
									key={
										row._tag === "chat"
											? row.chat.id
											: `${row.extensionId}:${row.command.id}`
									}
									ref={(el) => {
										itemRefs.current[i] = el;
									}}
									type="button"
									role="option"
									aria-selected={active}
									onMouseEnter={() => setHighlight(i)}
									onClick={() => confirm(row)}
									className={cn(
										"flex min-h-8 w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm",
										active
											? "bg-accent text-accent-foreground"
											: "hover:bg-muted/60",
									)}
								>
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
								</button>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}
