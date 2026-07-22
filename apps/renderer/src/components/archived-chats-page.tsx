import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArchiveArrowUpIcon,
	ArchiveIcon,
	ArrowLeft01Icon,
	Search01Icon,
} from "@hugeicons-pro/core-solid-rounded";
import type {
	Chat,
	ChatArchiveJob,
	ChatDirectoryStatus,
	FolderId,
	Message,
	Session,
} from "@zuse/contracts";
import { Effect } from "effect";
import { useEffect, useMemo, useState } from "react";

import { getRpcClient } from "../lib/rpc-client.ts";
import { cn } from "../lib/utils.ts";
import { useArchivePreviewStore } from "../store/archive-preview.ts";
import { useChatsStore } from "../store/chats.ts";
import { ArchivedChatTimeline } from "./archived-chat-timeline.tsx";
import { DirectoryUnavailableBanner } from "./directory-unavailable-banner.tsx";
import { ProviderIcon } from "./provider-icons.tsx";
import { Button } from "./ui/button.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";
import { Spinner } from "./ui/spinner.tsx";

const EMPTY_CHATS: ReadonlyArray<Chat> = [];
const EMPTY_SESSIONS: ReadonlyArray<Session> = [];
const EMPTY_MESSAGES: ReadonlyArray<Message> = [];

const formatDate = (date: Date): string =>
	date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year:
			date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
	});

export function ArchivedChatsPage({
	projectId,
	projectName,
}: {
	projectId: FolderId | null;
	projectName: string;
}) {
	const archivedChats = useArchivePreviewStore((state) =>
		projectId === null
			? EMPTY_CHATS
			: (state.chatsByProject[projectId] ?? EMPTY_CHATS),
	);
	const [query, setQuery] = useState("");
	const [archiveJob, setArchiveJob] = useState<ChatArchiveJob | null>(null);
	const [directoryStatus, setDirectoryStatus] =
		useState<ChatDirectoryStatus | null>(null);
	const selectedChatId = useArchivePreviewStore((state) =>
		projectId === null
			? null
			: (state.selectedChatByProject[projectId] ?? null),
	);
	const projectLoading = useArchivePreviewStore((state) =>
		projectId === null ? false : state.loadingByProject[projectId] === true,
	);
	const projectLoaded = useArchivePreviewStore((state) =>
		projectId === null ? false : state.loadedByProject[projectId] === true,
	);
	const projectError = useArchivePreviewStore((state) =>
		projectId === null ? null : (state.errorByProject[projectId] ?? null),
	);
	const selectedChat = useMemo(
		() => archivedChats.find((chat) => chat.id === selectedChatId) ?? null,
		[archivedChats, selectedChatId],
	);
	const preview = useArchivePreviewStore((state) =>
		selectedChatId === null ? undefined : state.previewsByChat[selectedChatId],
	);
	const previewLoading = useArchivePreviewStore((state) =>
		selectedChatId === null
			? false
			: state.previewLoadingByChat[selectedChatId] === true,
	);
	const previewError = useArchivePreviewStore((state) =>
		selectedChatId === null
			? null
			: (state.errorByChat[selectedChatId] ?? null),
	);
	const sessions = preview?.sessions ?? EMPTY_SESSIONS;
	const selectedSessionId = useArchivePreviewStore((state) =>
		selectedChatId === null
			? null
			: (state.selectedSessionByChat[selectedChatId] ?? null),
	);
	const selectedSession = useMemo(
		() => sessions.find((session) => session.id === selectedSessionId) ?? null,
		[sessions, selectedSessionId],
	);
	const messages = useArchivePreviewStore((state) =>
		selectedSessionId === null
			? EMPTY_MESSAGES
			: (state.messagesBySession[selectedSessionId] ?? EMPTY_MESSAGES),
	);
	const messagesLoading = useArchivePreviewStore((state) =>
		selectedSessionId === null
			? false
			: state.messagesLoadingBySession[selectedSessionId] === true,
	);
	const messagesError = useArchivePreviewStore((state) =>
		selectedSessionId === null
			? null
			: (state.errorBySession[selectedSessionId] ?? null),
	);
	const restoring = useArchivePreviewStore((state) =>
		selectedChatId === null
			? false
			: state.restoringByChat[selectedChatId] === true,
	);
	const restoreError = useArchivePreviewStore((state) =>
		selectedChatId === null
			? null
			: (state.restoreErrorByChat[selectedChatId] ?? null),
	);
	const loadProject = useArchivePreviewStore((state) => state.loadProject);
	const showList = useArchivePreviewStore((state) => state.showList);
	const openChat = useArchivePreviewStore((state) => state.openChat);
	const selectSession = useArchivePreviewStore((state) => state.selectSession);
	const unarchive = useChatsStore((state) => state.unarchive);
	const forceArchive = useChatsStore((state) => state.archive);

	useEffect(() => {
		if (projectId !== null) void loadProject(projectId);
	}, [loadProject, projectId]);

	useEffect(() => setQuery(""), [projectId]);

	useEffect(() => {
		if (selectedChatId === null) {
			setArchiveJob(null);
			setDirectoryStatus(null);
			return;
		}
		setArchiveJob(null);
		setDirectoryStatus(null);
		let cancelled = false;
		let timer: number | null = null;
		const refresh = async () => {
			try {
				const client = await getRpcClient();
				const [job, status] = await Promise.all([
					Effect.runPromise(
						client["chat.archiveStatus"]({ chatId: selectedChatId }),
					),
					Effect.runPromise(
						client["chat.directoryStatus"]({ chatId: selectedChatId }),
					),
				]);
				if (!cancelled) {
					setArchiveJob(job);
					setDirectoryStatus(status);
				}
			} catch {
				// The preview remains readable while the connection recovers.
			} finally {
				if (!cancelled) timer = window.setTimeout(poll, 2_000);
			}
		};
		const poll = () => {
			if (document.visibilityState === "visible") void refresh();
			else if (!cancelled) timer = window.setTimeout(poll, 2_000);
		};
		void refresh();
		return () => {
			cancelled = true;
			if (timer !== null) window.clearTimeout(timer);
		};
	}, [selectedChatId]);

	if (projectId === null) {
		return <CenteredState text="Select a project to view archived chats." />;
	}
	if (selectedChat === null) {
		const needle = query.trim().toLowerCase();
		const filteredChats =
			needle.length === 0
				? archivedChats
				: archivedChats.filter((chat) =>
						chat.title.toLowerCase().includes(needle),
					);
		return (
			<section className="flex min-h-0 flex-1 flex-col bg-background/55">
				<header className="shrink-0 border-b border-border/50 px-8 py-4">
					<div className="flex items-center gap-3">
						<HugeiconsIcon
							icon={ArchiveIcon}
							className="size-5 text-muted-foreground"
						/>
						<div className="min-w-0">
							<h1 className="truncate text-lg font-semibold text-foreground">
								Archived chats
							</h1>
							<p className="truncate text-xs text-muted-foreground">
								{projectName}
							</p>
						</div>
					</div>
					<label className="mt-5 flex min-h-11 max-w-xl items-center gap-2 rounded-md border border-border/70 bg-background px-3 text-sm focus-within:ring-2 focus-within:ring-ring">
						<HugeiconsIcon
							icon={Search01Icon}
							className="size-4 shrink-0 text-muted-foreground"
						/>
						<span className="sr-only">Filter archived chats</span>
						<input
							value={query}
							onChange={(event) => setQuery(event.currentTarget.value)}
							placeholder="Filter archived chats…"
							className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
						/>
					</label>
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto px-8 py-5">
					{projectError !== null ? (
						<CenteredState
							text={projectError}
							action="Retry"
							onAction={() => void loadProject(projectId, true)}
						/>
					) : projectLoading || !projectLoaded ? (
						<CenteredState text="Loading archived chats…" loading />
					) : filteredChats.length === 0 ? (
						<CenteredState
							text={
								needle.length > 0
									? "No archived chats match that filter."
									: `No archived chats in ${projectName}.`
							}
						/>
					) : (
						<ul className="mx-auto flex w-full max-w-4xl flex-col divide-y divide-border/45">
							{filteredChats.map((chat) => (
								<li key={chat.id}>
									<button
										type="button"
										onClick={() => void openChat(chat)}
										className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left outline-none transition-colors duration-150 ease-out hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none"
									>
										<HugeiconsIcon
											icon={ArchiveIcon}
											className="size-3.5 shrink-0 text-muted-foreground"
										/>
										<span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
											{chat.title}
										</span>
										<span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
											Archived {formatDate(chat.archivedAt ?? chat.updatedAt)}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			</section>
		);
	}

	return (
		<section className="flex min-h-0 flex-1 flex-col bg-background/55">
			<header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/50 px-5">
				<button
					type="button"
					onClick={() => void showList(projectId)}
					aria-label="Back to archived chats"
					className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-150 ease-out hover:bg-muted/45 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
				>
					<HugeiconsIcon icon={ArrowLeft01Icon} className="size-4" />
				</button>
				<HugeiconsIcon
					icon={ArchiveIcon}
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<div className="min-w-0 flex-1">
					<h1 className="truncate text-sm font-medium text-foreground">
						{selectedChat.title}
					</h1>
					<p className="truncate text-[11px] text-muted-foreground">
						Archived{" "}
						{formatDate(selectedChat.archivedAt ?? selectedChat.updatedAt)}
					</p>
				</div>
			</header>
			{directoryStatus?._tag === "unavailable" ? (
				<div className="shrink-0 px-4 pt-3">
					<DirectoryUnavailableBanner archived />
				</div>
			) : null}

			{preview !== undefined && sessions.length > 0 ? (
				<nav
					aria-label="Archived chat sessions"
					className="flex h-11 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border/50 px-3"
				>
					{sessions.map((session) => (
						<button
							key={session.id}
							type="button"
							onClick={() => void selectSession(selectedChat.id, session.id)}
							className={cn(
								"flex min-w-0 max-w-56 items-center gap-2 border-b-2 px-3 text-xs outline-none transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
								session.id === selectedSessionId
									? "border-foreground text-foreground"
									: "border-transparent text-muted-foreground hover:text-foreground",
							)}
							aria-current={
								session.id === selectedSessionId ? "page" : undefined
							}
						>
							<ProviderIcon
								providerId={session.providerId}
								className="size-3.5"
							/>
							<span className="truncate">{session.title}</span>
						</button>
					))}
				</nav>
			) : null}

			<div className="flex min-h-0 flex-1 px-3">
				<div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
					{previewLoading ? (
						<CenteredState text="Loading archived chat…" loading />
					) : previewError !== null ? (
						<CenteredState
							text={previewError}
							action="Retry"
							onAction={() => void openChat(selectedChat)}
						/>
					) : selectedSession === null ? (
						<CenteredState text="This archived chat has no sessions to preview." />
					) : messagesLoading ? (
						<CenteredState text="Loading transcript…" loading />
					) : messagesError !== null ? (
						<CenteredState
							text={messagesError}
							action="Retry"
							onAction={() =>
								void selectSession(selectedChat.id, selectedSession.id)
							}
						/>
					) : messages.length === 0 ? (
						<CenteredState text="No messages in this session." />
					) : (
						<ArchivedChatTimeline
							projectId={projectId}
							sessionId={selectedSession.id}
							messages={messages}
						/>
					)}
				</div>
			</div>

			<footer className="shrink-0 border-t border-border/60 bg-background/92 px-4 py-2 backdrop-blur-xl">
				<div className="mx-auto flex w-full max-w-4xl items-center gap-2.5">
					<HugeiconsIcon
						icon={ArchiveIcon}
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<div className="min-w-0 flex-1">
						<p className="text-xs text-muted-foreground">
							This chat is archived.
						</p>
						{restoreError !== null ? (
							<p className="mt-0.5 truncate text-[11px] text-destructive">
								{restoreError}
							</p>
						) : null}
						{archiveJob?.status === "failed" ? (
							<p className="mt-0.5 truncate text-[11px] text-destructive">
								{archiveJob.error ?? "Worktree cleanup failed."}
							</p>
						) : null}
					</div>
					{archiveJob?.status === "failed" ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => void forceArchive(selectedChat.id, true)}
						>
							Force archive
						</Button>
					) : null}
					<Button
						variant="settings"
						size="sm"
						disabled={restoring}
						onClick={() => void unarchive(selectedChat.id)}
					>
						{restoring ? (
							<Spinner className="size-3.5" />
						) : (
							<HugeiconsIcon icon={ArchiveArrowUpIcon} className="size-3.5" />
						)}
						{restoring ? "Unarchiving…" : restoreError ? "Retry" : "Unarchive"}
					</Button>
				</div>
			</footer>
		</section>
	);
}

function CenteredState({
	text,
	loading = false,
	action,
	onAction,
}: {
	readonly text: string;
	readonly loading?: boolean;
	readonly action?: string;
	readonly onAction?: () => void;
}) {
	return (
		<div className="flex h-full min-h-64 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
			{loading ? <ShimmerText>{text}</ShimmerText> : <p>{text}</p>}
			{action !== undefined && onAction !== undefined ? (
				<Button variant="outline" size="sm" onClick={onAction}>
					{action}
				</Button>
			) : null}
		</div>
	);
}
