import { useChatsStore } from "../../store/chats.ts";
import "@zuse/i18n/english/projects";
import {
	ChatId,
	FolderId,
	type MasterAction,
	type MasterArtifact,
	SessionId,
} from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { useCallback, useRef, useState } from "react";
import { formatError } from "../../lib/format-error.ts";
import { masterWorkerActivity } from "../../lib/master-activity.ts";
import { useMasterSnapshot } from "../../lib/masters-client-bus.ts";
import { useEnvironmentCatalogStore } from "../../store/environment-catalog.ts";
import {
	executeMaster,
	type MasterSelection,
	masterCommand,
	readMaster,
	useMastersStore,
} from "../../store/masters.ts";
import { Button } from "../ui/button.tsx";
import { ShimmerText } from "../ui/shimmer-text.tsx";
import {
	type LoadedArtifact,
	MasterArtifactViewer,
} from "./artifact-viewer.tsx";
import { MasterConversation } from "./conversation.tsx";
import { MasterDetails } from "./details.tsx";
import { MasterHeader } from "./header.tsx";
import { MasterHistory } from "./history.tsx";
import { avatarFor, Mascot, type MascotState } from "./mascot.tsx";
import { MasterPreferences } from "./preferences.tsx";
import { ZotGuide } from "./zot-guide.tsx";

export function MastersSurface({ selection }: { selection: MasterSelection }) {
	const { message } = useMessages("projects");

	const resource = useMasterSnapshot(
		selection.environmentId,
		selection.masterId,
	);
	const snapshot = resource.data;
	const session = snapshot?.coordinator;

	const [historyOpen, setHistoryOpen] = useState(false);
	const [preferencesOpen, setPreferencesOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [artifactId, setArtifactId] = useState<string | null>(null);
	const [artifact, setArtifact] = useState<LoadedArtifact | null>(null);
	const root = useRef<HTMLDivElement>(null);
	const railPreference = useMastersStore((state) => state.railOpen);
	// Details stay open by default; the header toggle remembers the choice.
	const railOpen = railPreference ?? true;

	const refresh = useCallback(async () => {
		if (!selection.masterId) return;
		try {
			await readMaster(selection.environmentId, selection.masterId);
			setError(null);
		} catch (cause) {
			setError(formatError(cause));
		}
	}, [selection.environmentId, selection.masterId]);

	const action = async (command: MasterAction) => {
		setBusy(true);
		setError(null);
		try {
			const result = await executeMaster(selection, command);
			if (command._tag === "publish")
				setArtifact((previous) => {
					const metadata = result.artifacts.find(
						(item) => item.id === command.id,
					);
					return previous?.metadata.id === command.id && metadata
						? { metadata, content: command.content }
						: previous;
				});
			if (result.homeEnvironmentId !== selection.environmentId)
				useMastersStore.getState().select({
					environmentId: result.homeEnvironmentId,
					masterId: result.id,
				});
			await refresh();
		} catch (cause) {
			setError(formatError(cause));
			throw cause;
		} finally {
			setBusy(false);
		}
	};
	const perform = (command: MasterAction) => {
		void action(command).catch(() => undefined);
	};
	const openChat = async (
		environmentId: string,
		chatId: string,
		sessionId?: string,
	) => {
		const summary = snapshot?.chats.find(
			(chat) =>
				chat.repository.environmentId === environmentId &&
				chat.chat.id === chatId,
		);
		if (!summary) return;
		try {
			await useEnvironmentCatalogStore.getState().activate(environmentId, {
				folderId: FolderId.make(summary.repository.folderId),
				chatId: ChatId.make(chatId),
			});
			if (sessionId)
				await useChatsStore
					.getState()
					.setActiveSession(ChatId.make(chatId), SessionId.make(sessionId));
			useMastersStore.getState().select(null);
		} catch (cause) {
			setError(formatError(cause));
		}
	};
	const showArtifact = async (metadata: MasterArtifact) => {
		if (!selection.masterId) return;
		setArtifactId(metadata.id);
		try {
			const result = await masterCommand<
				{ masterId: string; artifactId: string; version: number },
				{ content: string }
			>(selection.environmentId, "masters.artifact", {
				masterId: selection.masterId,
				artifactId: metadata.id,
				version: metadata.version,
			});
			setArtifact({ metadata, content: result.content });
		} catch (cause) {
			setError(formatError(cause));
		}
	};

	if (!snapshot)
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
				{error ? (
					<>
						<p role="alert">{error}</p>
						<Button variant="ghost" onClick={() => void refresh()}>
							{message("projects:masters_retry")}
						</Button>
					</>
				) : (
					<ShimmerText>{message("projects:masters_loading")}</ShimmerText>
				)}
			</div>
		);

	const master = snapshot.master;
	const activities = master.workers.map((worker) =>
		masterWorkerActivity(worker, snapshot.chats),
	);
	const mascotState: MascotState =
		master.status !== "active"
			? "paused"
			: activities.includes("blocked")
				? "attention"
				: activities.includes("working") ||
						snapshot.coordinator?.status === "running"
					? "working"
					: "idle";
	// Older incomplete Masters have no coordinator until their settings are saved.
	const needsSetup =
		!master.activeSessionId &&
		master.homeEnvironmentId === selection.environmentId &&
		master.status !== "moving";
	return (
		<div ref={root} className="flex min-h-0 flex-1 flex-col">
			<ZotGuide
				rootRef={root}
				snapshot={snapshot}
				environmentId={selection.environmentId}
				composerMounted={!preferencesOpen && !historyOpen && Boolean(session)}
			/>
			<MasterHeader
				master={master}
				railOpen={railOpen}
				onToggleRail={() => {
					setArtifactId(null);
					useMastersStore.getState().setRailOpen(!railOpen);
				}}
				busy={busy}
				onControl={(status) => perform({ _tag: "control", status })}
				onRenew={() => {
					setHistoryOpen(false);
					perform({ _tag: "renew" });
				}}
				onOpenHistory={() => setHistoryOpen(true)}
				onOpenArtifacts={() => {
					const first =
						master.artifacts.find((item) => item.pinned) ?? master.artifacts[0];
					if (first) void showArtifact(first);
				}}
			/>
			{error ? (
				<div
					role="alert"
					className="flex h-8 shrink-0 items-center gap-2 bg-destructive/8 px-3 text-xs text-destructive"
				>
					<span className="min-w-0 flex-1 truncate" title={error}>
						{error}
					</span>
					<Button variant="ghost" size="sm" onClick={() => void refresh()}>
						{message("projects:masters_retry")}
					</Button>
				</div>
			) : null}
			<div className="flex min-h-0 flex-1">
				<div
					data-zot-guide-area
					className="flex min-h-0 min-w-0 flex-1 flex-col"
				>
					{preferencesOpen ? (
						<MasterPreferences
							snapshot={snapshot}
							busy={busy}
							execute={action}
							onClose={() => setPreferencesOpen(false)}
						/>
					) : historyOpen ? (
						<MasterHistory
							master={master}
							environmentId={selection.environmentId}
							onClose={() => setHistoryOpen(false)}
						/>
					) : session ? (
						<MasterConversation
							snapshot={snapshot}
							session={session}
							environmentId={selection.environmentId}
							mascotState={mascotState}
						/>
					) : needsSetup ? (
						<div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
							{message("projects:masters_needs_setup")}
						</div>
					) : master.status === "moving" ? (
						<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
							<ShimmerText>
								{message("projects:masters_status_moving")}
							</ShimmerText>
						</div>
					) : (
						// The snapshot polls every few seconds, so a missing coordinator
						// here is lost, not loading; a fresh chat rebuilds it.
						<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
							<Mascot
								avatar={avatarFor(master)}
								state="paused"
								size="large"
								px={84}
								seed={master.id}
							/>
							<div>
								<p className="text-sm font-medium text-foreground">
									{message("projects:masters_conversation_lost", {
										name: master.settings.name,
									})}
								</p>
								<p className="mt-1 max-w-sm text-[12px] text-muted-foreground">
									{message("projects:masters_conversation_lost_help")}
								</p>
							</div>
							<Button
								loading={busy}
								disabled={busy}
								onClick={() => perform({ _tag: "renew" })}
							>
								{message("projects:masters_start_fresh_chat")}
							</Button>
						</div>
					)}
				</div>
				{artifactId ? (
					<MasterArtifactViewer
						snapshot={snapshot}
						selectedId={artifactId}
						artifact={artifact}
						busy={busy}
						select={(next) => void showArtifact(next)}
						execute={action}
						perform={perform}
						openChat={(environmentId, chatId) =>
							void openChat(environmentId, chatId)
						}
						onClose={() => setArtifactId(null)}
					/>
				) : railOpen || needsSetup ? (
					<MasterDetails
						snapshot={snapshot}
						selection={selection}
						mascotState={mascotState}
						busy={busy}
						execute={action}
						perform={perform}
						openChat={(environmentId, chatId, sessionId) =>
							void openChat(environmentId, chatId, sessionId)
						}
						openArtifact={(next) => void showArtifact(next)}
						openPreferences={() => {
							setHistoryOpen(false);
							setPreferencesOpen(true);
						}}
						onClose={() => useMastersStore.getState().setRailOpen(false)}
					/>
				) : null}
			</div>
		</div>
	);
}
