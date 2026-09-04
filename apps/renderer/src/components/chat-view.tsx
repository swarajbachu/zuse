import { HugeiconsIcon } from "@hugeicons/react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type { PendingCommand } from "@zuse/client-runtime/resource-state";
import type {
	ChatCreationPhase,
	EnvironmentId,
	Session,
	SessionId,
} from "@zuse/contracts";
import { Message01Icon } from "@zuse/icons/solid-rounded";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { usePrefersReducedMotion } from "../hooks/use-media-query.ts";
import { deriveChatAttentionState } from "../lib/chat-attention-state.ts";
import {
	CHAT_LIST_ANCHOR_OFFSET,
	resolveChatListAnchoredEndSpace,
} from "../lib/chat-list-anchor.ts";
import { resolveChatErrorBottom } from "../lib/chat-overlay-position.ts";
import {
	type ChatTimelineRow,
	deriveChatTimelineRows,
	deriveChatTurnNavigationEntries,
	resolveLatestUserMessageId,
	rowAnchorMessageId,
} from "../lib/chat-timeline-rows.ts";
import {
	cloudChatShowsWorking,
	cloudWorkspaceIsStarting,
	deriveCloudChatActivity,
} from "../lib/cloud-chat-activity.ts";
import { cloudTranscriptActivation } from "../lib/cloud-workspace-lifecycle.ts";
import { useCloudChatSummaryForSelection } from "../lib/cloud-workspaces.ts";
import { useEnvironmentPermissions } from "../lib/environment-permissions-client-bus.ts";
import { useEnvironmentShellResource } from "../lib/environment-shell-client-bus.ts";
import { markRendererInteraction } from "../lib/performance-marks.ts";
import {
	clearSessionCommandError,
	isRecoveredPreAckSessionError,
	pendingSessionCommandError,
	sessionCommandErrorKey,
	useSessionCommandErrors,
} from "../lib/session-actions.ts";
import type { SessionRuntimeState } from "../lib/session-runtime-state.ts";
import { hasPendingTurnStart } from "../lib/session-runtime-state.ts";
import { timelineReadingPositionStore } from "../lib/session-timeline-cache.ts";
import { restartProvisionalSessionTimeline } from "../lib/session-timeline-client-bus.ts";
import { useRendererSessionTimeline } from "../lib/session-timeline-hooks.ts";
import { workspaceCreationProgressIsActive } from "../lib/setup-card-visibility.ts";
import {
	resolveInitialTimelineTarget,
	resolveTimelineReadingPosition,
	type TimelineReadingPosition,
} from "../lib/timeline-reading-position.ts";
import {
	resolveScrollableNodeIsAtEnd,
	resolveTimelineHasContentBelowViewport,
} from "../lib/timeline-scroll-anchoring.ts";
import {
	TranscriptScrollCoordinator,
	type TranscriptScrollSnapshot,
} from "../lib/transcript-scroll-coordinator.ts";
import {
	chatStartupUsesQueue,
	type PendingChatCreation,
	useChatsStore,
} from "../store/chats.ts";
import { useRegisterPane } from "../store/pane-focus.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import { ChatLookupsProvider, deriveChatLookups } from "./chat-lookups.tsx";
import { ChatTurnNavigator } from "./chat-turn-navigator.tsx";
import { ChatWorkingRow } from "./chat-working-row.tsx";
import { FileChipProvider } from "./file-chip.tsx";
import { JumpToLatestPill } from "./jump-to-latest-pill.tsx";
import { ErrorBubble, MessageRow } from "./message-row.tsx";
import { NextUnreadButton } from "./next-unread-button.tsx";
import {
	ChatCreationFailureActions,
	ChatCreationPromptBubble,
} from "./pending-chat-creation.tsx";
import { SubagentRow } from "./subagent-row.tsx";
import { TurnSummary } from "./turn-summary.tsx";
import { WorktreeSetupCard } from "./worktree-setup-card.tsx";

interface TimelineEndState {
	readonly isAtEnd?: boolean;
	readonly isNearEnd?: boolean;
}

export const resolveAgentStarting = (input: {
	readonly providerOutputStarted: boolean;
	readonly creationPhase: ChatCreationPhase | null;
	readonly sessionBooting: boolean;
	readonly inFlight: boolean;
	readonly queuedItems: number;
}): boolean =>
	!input.providerOutputStarted &&
	(input.creationPhase !== null
		? input.creationPhase === "starting_agent"
		: input.sessionBooting || input.inFlight || input.queuedItems > 0);

export const shouldRenderGenericAgentStartup = (input: {
	readonly inFlight: boolean;
	readonly agentStarting?: boolean;
	readonly hasPendingCreation: boolean;
}): boolean =>
	(input.inFlight || input.agentStarting === true) && !input.hasPendingCreation;

export const shouldRenderEmptyChatState = (input: {
	readonly messageCount: number;
	readonly hasPendingCreation: boolean;
	readonly setupActive: boolean;
	readonly agentStarting: boolean;
}): boolean =>
	input.messageCount === 0 &&
	!input.hasPendingCreation &&
	!input.setupActive &&
	!input.agentStarting;

export const resolvePendingStartupTranscriptPrompt = (
	creation: PendingChatCreation | null,
	canonicalMessageCount: number,
): string | null => {
	if (
		creation === null ||
		canonicalMessageCount > 0 ||
		creation.startupInput === undefined ||
		chatStartupUsesQueue(creation.startupInput, creation.startupReady)
	) {
		return null;
	}
	return creation.startupInput.text.trim() || null;
};

function resolveTimelineIsAtEnd(
	state: TimelineEndState | undefined,
): boolean | undefined {
	return state?.isNearEnd ?? state?.isAtEnd;
}

/**
 * Virtualized transcript for one session. LegendList owns measurement and
 * visible-content compensation; TranscriptScrollCoordinator exclusively owns
 * semantic movement such as live follow, new-turn anchoring, and navigation.
 */
export function ChatView({
	sessionId,
	environmentId,
	session,
	endInset = 0,
}: {
	readonly sessionId: SessionId;
	readonly environmentId: EnvironmentId;
	readonly session: Session;
	/** Height of the floating composer overlay; padded into the scroll range. */
	readonly endInset?: number;
}) {
	useLayoutEffect(() => {
		markRendererInteraction(sessionId, "first-react-commit");
	}, [sessionId]);
	const prefersReducedMotion = usePrefersReducedMotion();
	const cloudSummary = useCloudChatSummaryForSelection({
		chatId: session.chatId,
		sessionId,
	});
	const timeline = useRendererSessionTimeline(
		sessionId,
		cloudSummary === null ? "connect" : cloudTranscriptActivation(cloudSummary),
		environmentId,
	);
	const sessionRef = timeline.ref;
	useEffect(() => {
		if (cloudSummary !== null) return;
		restartProvisionalSessionTimeline(sessionRef, timeline.view);
	}, [cloudSummary, sessionRef, timeline.view.cursor, timeline.view.data]);
	const errorKey = sessionCommandErrorKey(sessionRef);
	const localError = useSessionCommandErrors(
		(state) => state.errorByResource[errorKey] ?? null,
	);
	const commandError = localError ?? pendingSessionCommandError(sessionRef);
	const recoveredPreAckError =
		commandError !== null &&
		isRecoveredPreAckSessionError(commandError, timeline.view);
	const error = recoveredPreAckError ? null : commandError;
	useEffect(() => {
		if (recoveredPreAckError) clearSessionCommandError(sessionRef);
	}, [recoveredPreAckError, sessionRef]);
	const messages = timeline.messages;
	const timelineVersion = timeline.view.cursor?.version ?? 0;
	const runtimeState = timeline.runtime;
	const cloudShell = useEnvironmentShellResource(
		cloudSummary === null ? null : environmentId,
		"cache-only",
	);
	const cloudActivity =
		cloudSummary === null
			? null
			: deriveCloudChatActivity({
					summary: cloudSummary,
					connection: cloudShell.connection,
					runtime: runtimeState,
				});
	const turnStartPending = hasPendingTurnStart(timeline.view.pendingCommands);
	const inFlight =
		cloudActivity === null
			? runtimeState === "starting" ||
				runtimeState === "running" ||
				runtimeState === "stopping" ||
				turnStartPending
			: cloudChatShowsWorking(cloudActivity) || turnStartPending;
	const permissionRequests =
		useEnvironmentPermissions(environmentId).data?.requestsById ?? {};
	const sessionPermissionRequests = Object.values(permissionRequests).filter(
		(request) => request.sessionId === sessionId,
	);
	const awaitingPermissionPlanApproval = (() => {
		for (const request of sessionPermissionRequests) {
			if (request.kind._tag !== "Other") continue;
			if (request.kind.tool === "ExitPlanMode") return true;
		}
		return false;
	})();
	const awaitingPlanApproval =
		awaitingPermissionPlanApproval ||
		deriveChatAttentionState(messages, inFlight) === "planReady";
	const awaitingUserAction =
		awaitingPlanApproval || sessionPermissionRequests.length > 0;
	const worktreeId = session?.worktreeId ?? null;
	const worktreeSetupStatus = useWorktreesStore((state) => {
		if (worktreeId === null) return null;
		for (const list of Object.values(state.byProject)) {
			const worktree = (list ?? EMPTY_WORKTREES).find(
				(candidate) => candidate.id === worktreeId,
			);
			if (worktree === undefined) continue;
			return worktree.setupStatus;
		}
		return null;
	});
	const setupActive =
		worktreeSetupStatus === "running" ||
		worktreeSetupStatus === "pending" ||
		worktreeSetupStatus === "failed";
	const providerOutputStarted = messages.some(
		(message) => message.role !== "user",
	);
	const pendingCreation = useChatsStore((state) =>
		session.chatId === null
			? null
			: (state.pendingCreationByChat[session.chatId] ?? null),
	);
	const pendingStartupTranscriptPrompt = resolvePendingStartupTranscriptPrompt(
		pendingCreation,
		messages.length,
	);
	useEffect(() => {
		if (!providerOutputStarted || session.chatId === null) return;
		useChatsStore.getState().completeCreation(session.chatId);
	}, [providerOutputStarted, session.chatId]);
	const cloudSetupActive =
		cloudSummary !== null && cloudWorkspaceIsStarting(cloudSummary);
	const workspaceProgressActive = workspaceCreationProgressIsActive({
		workspaceRequested: pendingCreation?.workspaceRequested === true,
		setupStatus: worktreeSetupStatus,
		creationPhase: pendingCreation?.phase ?? null,
	});
	const agentStarting = resolveAgentStarting({
		providerOutputStarted,
		creationPhase: pendingCreation?.phase ?? null,
		sessionBooting: session?.status === "booting",
		inFlight,
		queuedItems: timeline.projection?.queue.items.length ?? 0,
	});
	const rows = useMemo(
		() =>
			deriveChatTimelineRows({
				messages,
				// The durable creation accordion exclusively narrates startup. Generic
				// in-flight UI resumes only after that lifecycle projection is gone.
				inFlight: shouldRenderGenericAgentStartup({
					inFlight,
					agentStarting,
					hasPendingCreation: workspaceProgressActive || cloudSetupActive,
				}),
				awaitingPlanApproval: awaitingUserAction,
			}),
		[
			awaitingUserAction,
			cloudSetupActive,
			agentStarting,
			inFlight,
			messages,
			workspaceProgressActive,
		],
	);
	const timelineFooter = useMemo(
		() => (
			<>
				<div className="px-[var(--chat-row-gutter,0.75rem)]">
					<WorktreeSetupCard providerOutputStarted={providerOutputStarted} />
					{pendingCreation?.phase === "failed" ? (
						<ChatCreationFailureActions creation={pendingCreation} />
					) : null}
				</div>
				<div className="h-2" />
			</>
		),
		[pendingCreation, providerOutputStarted],
	);
	const turns = useMemo(() => deriveChatTurnNavigationEntries(rows), [rows]);
	const latestUserMessageId = useMemo(
		() => resolveLatestUserMessageId(rows),
		[rows],
	);

	const [timelineAnchorMessageId, setTimelineAnchorMessageId] = useState<
		string | null
	>(null);
	const anchoredEndSpace = useMemo(
		() =>
			resolveChatListAnchoredEndSpace(rows, timelineAnchorMessageId, (row) =>
				rowAnchorMessageId(row),
			),
		[rows, timelineAnchorMessageId],
	);
	const listRef = useRef<LegendListRef | null>(null);
	const scrollElementRef = useRef<HTMLDivElement | null>(null);
	const latestUserMessageIdRef = useRef(latestUserMessageId);
	latestUserMessageIdRef.current = latestUserMessageId;
	const lastObservedUserMessageIdRef = useRef<string | null>(null);
	const sessionOpenedEmptyRef = useRef(messages.length === 0);
	const initializedSessionRef = useRef<SessionId | null>(null);
	const lastContentVersionRef = useRef(timelineVersion);
	const anchorRequestKeyRef = useRef<string | null>(null);
	const currentReadingPositionRef = useRef<TimelineReadingPosition | null>(
		null,
	);
	const saveTimerRef = useRef<number | null>(null);
	const scrollFrameRef = useRef<number | null>(null);
	const [activeTurnMessageId, setActiveTurnMessageId] = useState<string | null>(
		latestUserMessageId,
	);
	const [hasOutOfViewUpdates, setHasOutOfViewUpdates] = useState(false);
	const [readingState, setReadingState] = useState<{
		readonly sessionId: SessionId;
		readonly position: TimelineReadingPosition | null;
	} | null>(null);
	const [scrollSnapshot, setScrollSnapshot] =
		useState<TranscriptScrollSnapshot>({
			mode: "restoring",
			isAtEnd: true,
		});
	const scrollSnapshotRef = useRef(scrollSnapshot);
	const coordinator = useMemo(
		() =>
			new TranscriptScrollCoordinator({
				onChange: (snapshot) => {
					scrollSnapshotRef.current = snapshot;
					setScrollSnapshot(snapshot);
				},
			}),
		[sessionId],
	);
	useRegisterPane("chat", scrollElementRef);

	const captureReadingPosition = useCallback(() => {
		const measurement = listRef.current?.getState();
		if (measurement === undefined) return null;
		const position = resolveTimelineReadingPosition({
			sessionId,
			rows,
			mode: scrollSnapshotRef.current.mode,
			measurement,
		});
		currentReadingPositionRef.current = position;
		return position;
	}, [rows, sessionId]);
	const captureReadingPositionRef = useRef(captureReadingPosition);
	captureReadingPositionRef.current = captureReadingPosition;

	const persistReadingPosition = useCallback(() => {
		const position = captureReadingPosition();
		if (position !== null) {
			void timelineReadingPositionStore
				?.save(sessionRef, position)
				.catch(() => {});
		}
	}, [captureReadingPosition, sessionRef]);
	const persistReadingPositionRef = useRef(persistReadingPosition);
	persistReadingPositionRef.current = persistReadingPosition;

	const scheduleReadingPositionSave = useCallback(() => {
		if (saveTimerRef.current !== null)
			window.clearTimeout(saveTimerRef.current);
		saveTimerRef.current = window.setTimeout(() => {
			saveTimerRef.current = null;
			persistReadingPositionRef.current();
		}, 300);
	}, []);

	const handleScroll = useCallback(() => {
		const list = listRef.current;
		const stateAtEnd = resolveTimelineIsAtEnd(list?.getState());
		const nodeAtEnd = resolveScrollableNodeIsAtEnd(list?.getScrollableNode());
		const isAtEnd = nodeAtEnd ?? stateAtEnd;
		if (isAtEnd !== undefined) coordinator.scrolled({ isAtEnd });
		if (scrollFrameRef.current !== null) return;
		scrollFrameRef.current = requestAnimationFrame(() => {
			scrollFrameRef.current = null;
			const position = captureReadingPositionRef.current();
			if (position !== null) {
				setActiveTurnMessageId(position.userTurnMessageId);
			}
			scheduleReadingPositionSave();
		});
	}, [coordinator, scheduleReadingPositionSave]);
	const markAnchoredContentOutOfView = useCallback(() => {
		if (scrollSnapshotRef.current.mode !== "anchoring-turn") return;
		if (
			resolveTimelineHasContentBelowViewport(
				listRef.current?.getState(),
				endInset,
			)
		) {
			setHasOutOfViewUpdates(true);
		}
	}, [endInset]);
	useEffect(() => {
		let cancelled = false;
		initializedSessionRef.current = null;
		sessionOpenedEmptyRef.current = messages.length === 0;
		setReadingState(null);
		currentReadingPositionRef.current = null;
		void (async () => {
			const position =
				(await timelineReadingPositionStore
					?.load(sessionRef)
					.catch(() => null)) ?? null;
			if (!cancelled) setReadingState({ sessionId, position });
		})();
		return () => {
			cancelled = true;
		};
	}, [sessionId, sessionRef]);

	useEffect(() => {
		coordinator.attach({
			getMeasurementState: () => listRef.current?.getState() ?? null,
			isAtLiveEdge: () =>
				resolveScrollableNodeIsAtEnd(listRef.current?.getScrollableNode()),
			scrollToEnd: (options) => {
				const list = listRef.current;
				return list === null
					? Promise.reject(new Error("Transcript list is not mounted"))
					: list.scrollToEnd(options);
			},
			scrollToIndex: (options) => {
				const list = listRef.current;
				return list === null
					? Promise.reject(new Error("Transcript list is not mounted"))
					: list.scrollToIndex({
							...options,
							viewPosition: 0,
						});
			},
		});
		return () => coordinator.detach();
	}, [coordinator]);

	useEffect(
		() => () => {
			if (saveTimerRef.current !== null) {
				window.clearTimeout(saveTimerRef.current);
			}
			if (scrollFrameRef.current !== null) {
				cancelAnimationFrame(scrollFrameRef.current);
			}
			const position = currentReadingPositionRef.current;
			if (position?.sessionId === sessionId) {
				void timelineReadingPositionStore
					?.save(sessionRef, position)
					.catch(() => {});
			}
			coordinator.dispose();
		},
		[coordinator, sessionId, sessionRef],
	);

	useEffect(() => {
		const onVisibilityChange = () => {
			if (document.visibilityState === "hidden") {
				persistReadingPositionRef.current();
			}
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", onVisibilityChange);
	}, []);

	useLayoutEffect(() => {
		const node = listRef.current?.getScrollableNode() ?? null;
		if (node instanceof HTMLDivElement) {
			node.dataset.pane = "chat";
			node.tabIndex = -1;
			scrollElementRef.current = node;
		} else {
			scrollElementRef.current = null;
		}
	}, [rows.length, sessionId]);

	useEffect(() => {
		if (
			readingState?.sessionId !== sessionId ||
			messages.length === 0 ||
			initializedSessionRef.current === sessionId
		) {
			return;
		}
		const target = resolveInitialTimelineTarget({
			rows,
			position: readingState.position,
			recoverAtLiveEdge: false,
		});
		initializedSessionRef.current = sessionId;
		lastObservedUserMessageIdRef.current =
			sessionOpenedEmptyRef.current && inFlight
				? null
				: latestUserMessageIdRef.current;
		lastContentVersionRef.current = timelineVersion;
		coordinator.initialize({
			atReadingPosition: target !== null,
			isAtEnd:
				resolveScrollableNodeIsAtEnd(listRef.current?.getScrollableNode()) ??
				undefined,
		});
		setTimelineAnchorMessageId(
			target?.messageId ?? latestUserMessageIdRef.current,
		);
		setActiveTurnMessageId(target?.messageId ?? latestUserMessageIdRef.current);
		setHasOutOfViewUpdates(false);
	}, [
		coordinator,
		inFlight,
		messages.length,
		readingState,
		rows,
		sessionId,
		timelineVersion,
	]);

	useEffect(() => {
		let removeListeners: (() => void) | null = null;
		let frame: number | null = null;
		const attachListeners = (remainingAttempts: number) => {
			const scrollNode = listRef.current?.getScrollableNode();
			if (scrollNode === undefined) {
				if (remainingAttempts > 0) {
					frame = requestAnimationFrame(() =>
						attachListeners(remainingAttempts - 1),
					);
				}
				return;
			}
			if (scrollNode instanceof HTMLDivElement) {
				scrollNode.dataset.pane = "chat";
				scrollNode.tabIndex = -1;
				scrollElementRef.current = scrollNode;
			}
			const takeControl = (intent: "interaction" | "scroll") => {
				coordinator.readerTookControl(intent);
				if (intent === "scroll") requestAnimationFrame(handleScroll);
			};
			const onKeyDown = (event: KeyboardEvent) => {
				if (
					[
						"ArrowUp",
						"ArrowDown",
						"PageUp",
						"PageDown",
						"Home",
						"End",
						" ",
					].includes(event.key)
				) {
					takeControl("scroll");
				}
			};
			const onFocusIn = (event: FocusEvent) => {
				const target = event.target;
				if (
					target instanceof HTMLElement &&
					target.matches("a, button, input, textarea, [role='button']")
				) {
					takeControl("interaction");
				}
			};
			const onSelectionChange = () => {
				const selection = document.getSelection();
				if (selection?.isCollapsed !== false) return;
				const anchorNode = selection.anchorNode;
				if (anchorNode !== null && scrollNode.contains(anchorNode))
					takeControl("interaction");
			};
			const onScrollIntent = () => takeControl("scroll");
			const onPointerDown = (event: PointerEvent) => {
				const bounds = scrollNode.getBoundingClientRect();
				const scrollbarHitWidth = Math.max(
					12,
					scrollNode.offsetWidth - scrollNode.clientWidth,
				);
				const scrollbarIsLeft =
					window.getComputedStyle(scrollNode).direction === "rtl";
				const isScrollbarIntent =
					event.target === scrollNode &&
					(scrollbarIsLeft
						? event.clientX <= bounds.left + scrollbarHitWidth
						: event.clientX >= bounds.right - scrollbarHitWidth);
				takeControl(isScrollbarIntent ? "scroll" : "interaction");
			};
			scrollNode.addEventListener("wheel", onScrollIntent, { passive: true });
			scrollNode.addEventListener("touchmove", onScrollIntent, {
				passive: true,
			});
			scrollNode.addEventListener("pointerdown", onPointerDown, {
				passive: true,
			});
			scrollNode.addEventListener("keydown", onKeyDown);
			scrollNode.addEventListener("focusin", onFocusIn);
			document.addEventListener("selectionchange", onSelectionChange);
			removeListeners = () => {
				scrollNode.removeEventListener("wheel", onScrollIntent);
				scrollNode.removeEventListener("touchmove", onScrollIntent);
				scrollNode.removeEventListener("pointerdown", onPointerDown);
				scrollNode.removeEventListener("keydown", onKeyDown);
				scrollNode.removeEventListener("focusin", onFocusIn);
				document.removeEventListener("selectionchange", onSelectionChange);
			};
		};
		frame = requestAnimationFrame(() => attachListeners(30));
		return () => {
			if (frame !== null) cancelAnimationFrame(frame);
			removeListeners?.();
		};
	}, [coordinator, handleScroll, sessionId]);

	useEffect(() => {
		if (latestUserMessageId === null) return;
		const previous = lastObservedUserMessageIdRef.current;
		if (previous === latestUserMessageId) return;
		lastObservedUserMessageIdRef.current = latestUserMessageId;
		if (previous === null && !inFlight) return;
		const turn = turns.find((entry) => entry.messageId === latestUserMessageId);
		if (turn === undefined) return;
		setTimelineAnchorMessageId(latestUserMessageId);
		setActiveTurnMessageId(latestUserMessageId);
		setHasOutOfViewUpdates(false);
		coordinator.prepareNewTurn(turn.rowIndex, CHAT_LIST_ANCHOR_OFFSET);
	}, [coordinator, inFlight, latestUserMessageId, turns]);

	useLayoutEffect(() => {
		if (anchoredEndSpace === undefined || timelineAnchorMessageId === null) {
			return;
		}
		const requestKey = timelineAnchorMessageId;
		if (anchorRequestKeyRef.current === requestKey) return;
		anchorRequestKeyRef.current = requestKey;
		const frame = requestAnimationFrame(() => {
			coordinator.positionAnchoredTurn({ animated: false });
		});
		return () => cancelAnimationFrame(frame);
	}, [anchoredEndSpace, coordinator, timelineAnchorMessageId]);

	useEffect(() => {
		let frame: number | null = null;
		const contentChanged = lastContentVersionRef.current !== timelineVersion;
		if (coordinator.getSnapshot().mode === "detached" && contentChanged) {
			setHasOutOfViewUpdates(true);
		} else if (
			coordinator.getSnapshot().mode === "anchoring-turn" &&
			contentChanged
		) {
			frame = requestAnimationFrame(markAnchoredContentOutOfView);
		}
		lastContentVersionRef.current = timelineVersion;
		coordinator.contentChanged();
		return () => {
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [coordinator, markAnchoredContentOutOfView, rows, timelineVersion]);

	useEffect(() => {
		if (scrollSnapshot.mode === "following") setHasOutOfViewUpdates(false);
	}, [scrollSnapshot.mode]);

	const chatLookups = useMemo(() => deriveChatLookups(messages), [messages]);
	const renderTimelineRow = useCallback(
		({ item }: { item: ChatTimelineRow }) => (
			<TimelineRow
				chatId={session?.chatId ?? null}
				environmentId={timeline.ref.environmentId}
				providerId={session.providerId}
				pendingCommands={timeline.view.pendingCommands}
				row={item}
				runtimeState={timeline.runtime}
				sessionId={sessionId}
			/>
		),
		[
			session.chatId,
			session.providerId,
			sessionId,
			timeline.ref.environmentId,
			timeline.runtime,
			timeline.view.pendingCommands,
		],
	);
	const readingReady = readingState?.sessionId === sessionId;
	const effectiveReadingPosition =
		currentReadingPositionRef.current?.sessionId === sessionId
			? currentReadingPositionRef.current
			: readingState?.position;
	const initialTarget = resolveInitialTimelineTarget({
		rows,
		position: effectiveReadingPosition,
		recoverAtLiveEdge: false,
	});
	const showPill =
		(scrollSnapshot.mode === "detached" ||
			scrollSnapshot.mode === "navigating" ||
			(scrollSnapshot.mode === "anchoring-turn" && hasOutOfViewUpdates)) &&
		(!scrollSnapshot.isAtEnd || hasOutOfViewUpdates);

	return (
		<FileChipProvider
			folderId={session?.projectId ?? null}
			worktreeId={session?.worktreeId ?? null}
		>
			<div
				data-chat-viewport
				className="relative flex min-h-0 min-w-0 flex-1 [container-type:inline-size]"
			>
				<div className="relative flex h-full min-h-0 flex-1 flex-col">
					{messages.length === 0 ? (
						<div
							data-pane="chat"
							tabIndex={-1}
							ref={scrollElementRef}
							className="flex h-full min-h-0 w-full flex-1 flex-col overflow-y-auto outline-none"
						>
							<div className="px-[var(--chat-row-gutter,0.75rem)]">
								<ChatCreationPromptBubble
									prompt={pendingStartupTranscriptPrompt}
								/>
								<WorktreeSetupCard />
							</div>
							{shouldRenderEmptyChatState({
								messageCount: messages.length,
								hasPendingCreation: pendingCreation !== null,
								setupActive,
								agentStarting,
							}) ? (
								<div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
									<HugeiconsIcon
										icon={Message01Icon}
										className="size-10 opacity-40"
									/>
									<div>
										<p className="text-sm">{session?.title ?? "New chat"}</p>
										<p className="mt-1 text-xs">
											Type a message below to get started.
										</p>
									</div>
								</div>
							) : null}
						</div>
					) : !readingReady ? (
						<div
							data-pane="chat"
							tabIndex={-1}
							ref={scrollElementRef}
							className="h-full min-h-0 w-full flex-1 outline-none"
						/>
					) : (
						<ChatLookupsProvider value={chatLookups}>
							<LegendList<ChatTimelineRow>
								key={sessionId}
								ref={listRef}
								data={rows}
								dataVersion={timelineVersion}
								keyExtractor={(row) => row.id}
								getItemType={(row) => row.kind}
								renderItem={renderTimelineRow}
								estimatedItemSize={96}
								initialScrollAtEnd={initialTarget === null}
								{...(initialTarget === null
									? {}
									: {
											initialScrollIndex: {
												index: initialTarget.index,
												viewPosition: 0,
												viewOffset: initialTarget.viewportOffset,
											},
										})}
								{...(anchoredEndSpace === undefined
									? {}
									: {
											anchoredEndSpace: {
												...anchoredEndSpace,
												onReady: () => {
													coordinator.positionAnchoredTurn({
														animated: false,
														force: true,
													});
												},
												onSizeChanged: markAnchoredContentOutOfView,
											},
										})}
								maintainScrollAtEnd={false}
								maintainVisibleContentPosition={{ data: true, size: true }}
								contentInsetEndAdjustment={endInset}
								onScroll={handleScroll}
								className="h-full min-h-0 w-full flex-1 overflow-x-hidden pr-4 outline-none [overflow-anchor:none]"
								data-pane="chat"
								tabIndex={-1}
								ListFooterComponent={timelineFooter}
							/>
						</ChatLookupsProvider>
					)}
					<ChatTurnNavigator
						turns={turns}
						activeMessageId={activeTurnMessageId}
						hasOutOfViewUpdates={hasOutOfViewUpdates}
						onReaderIntent={() => {
							coordinator.readerTookControl();
						}}
						onNavigate={(turn) => {
							setTimelineAnchorMessageId(null);
							coordinator.jumpToTurn(turn.rowIndex, {
								viewportOffset: CHAT_LIST_ANCHOR_OFFSET,
								animated: !prefersReducedMotion,
							});
						}}
					/>
					{error === null ? null : (
						<div
							className="pointer-events-none absolute inset-x-0 z-20 px-[var(--chat-row-gutter,0.75rem)]"
							style={{ bottom: resolveChatErrorBottom(endInset) }}
						>
							<div className="pointer-events-auto mx-auto w-full max-w-[var(--chat-reading-column,56rem)]">
								<ErrorBubble
									error={error}
									sessionId={sessionId}
									environmentId={environmentId}
									providerId={session?.providerId}
									onDismiss={() => clearSessionCommandError(sessionRef)}
								/>
							</div>
						</div>
					)}
					<div
						className="pointer-events-none absolute inset-x-0 z-30 px-[var(--chat-row-gutter,0.75rem)]"
						style={{ bottom: Math.max(0, endInset - 8) }}
					>
						<div className="mx-auto flex w-full max-w-[var(--chat-reading-column,56rem)] items-center justify-between gap-2">
							<JumpToLatestPill
								visible={showPill}
								streaming={inFlight && hasOutOfViewUpdates}
								onClick={() => {
									setHasOutOfViewUpdates(false);
									coordinator.jumpToLatest({
										animated: !prefersReducedMotion,
									});
								}}
							/>
							<div className="ml-auto">
								<NextUnreadButton />
							</div>
						</div>
					</div>
					<p className="sr-only" aria-live="polite" aria-atomic="true">
						{showPill && inFlight && hasOutOfViewUpdates
							? "Response is streaming out of view."
							: ""}
					</p>
				</div>
			</div>
		</FileChipProvider>
	);
}

function TimelineRow({
	chatId,
	row,
	sessionId,
	environmentId,
	providerId,
	pendingCommands,
	runtimeState,
}: {
	readonly chatId: import("@zuse/contracts").ChatId | null;
	readonly row: ChatTimelineRow;
	readonly sessionId: SessionId;
	readonly environmentId: EnvironmentId;
	readonly providerId: import("@zuse/contracts").ProviderId;
	readonly pendingCommands: readonly PendingCommand[];
	readonly runtimeState: SessionRuntimeState;
}) {
	let content: ReactNode;
	switch (row.kind) {
		case "message":
			content = (
				<MessageRow
					message={row.message}
					sessionId={sessionId}
					environmentId={environmentId}
					providerId={providerId}
					showAssistantCommands={row.showAssistantCommands}
				/>
			);
			break;
		case "subagent":
			content = (
				<div>
					<SubagentRow
						chatRef={chatId === null ? null : { environmentId, chatId }}
						agentToolUseId={row.parentItemId}
						agentName={row.agentName}
						prompt={row.prompt}
						modelRequested={row.modelRequested}
						childSessionId={row.childSessionId}
						presentation={row.presentation}
						children={row.children}
						summary={row.summary}
					/>
				</div>
			);
			break;
		case "turn-summary":
			content = (
				<div>
					<TurnSummary
						body={row.body}
						chatId={chatId ?? undefined}
						sessionId={sessionId}
						environmentId={environmentId}
						showAssistantCommands={row.showAssistantCommands}
					/>
				</div>
			);
			break;
		case "working":
			content = (
				<ChatWorkingRow
					messages={row.messages}
					chatId={chatId}
					pendingCommands={pendingCommands}
					providerId={providerId}
					runtimeState={runtimeState}
					sessionId={sessionId}
				/>
			);
	}
	return (
		<div className="px-[var(--chat-row-gutter,0.75rem)]">
			<div className="mx-auto w-full max-w-[var(--chat-reading-column,56rem)]">
				{content}
			</div>
		</div>
	);
}
