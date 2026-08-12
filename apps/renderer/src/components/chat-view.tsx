import { HugeiconsIcon } from "@hugeicons/react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type { Message, SessionId } from "@zuse/contracts";
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
	deriveCloudChatActivity,
} from "../lib/cloud-chat-activity.ts";
import { markRendererInteraction } from "../lib/performance-marks.ts";
import { effectiveSessionRuntimeState } from "../lib/session-runtime-state.ts";
import { timelineReadingPositionStore } from "../lib/session-timeline-cache.ts";
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
import { useCloudExecutionStore } from "../store/cloud-chat-registry.ts";
import {
	useCloudChatSummaryForSession,
	useCloudChatsStore,
} from "../store/cloud-chats.ts";
import {
	acknowledgeTimelineRendered,
	teardownLiveStreams,
	useMessagesStore,
} from "../store/messages.ts";
import { useRegisterPane } from "../store/pane-focus.ts";
import { usePermissionsStore } from "../store/permissions.ts";
import { useSessionRuntimeStore } from "../store/session-runtime.ts";
import { getSessionById, useSessionsStore } from "../store/sessions.ts";
import { useSkillsStore } from "../store/skills.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import { ChatLookupsProvider, deriveChatLookups } from "./chat-lookups.tsx";
import { ChatTurnNavigator } from "./chat-turn-navigator.tsx";
import { ChatWorkingRow } from "./chat-working-row.tsx";
import { FileChipProvider } from "./file-chip.tsx";
import { JumpToLatestPill } from "./jump-to-latest-pill.tsx";
import { ErrorBubble, MessageRow } from "./message-row.tsx";
import { NextUnreadButton } from "./next-unread-button.tsx";
import { SubagentRow } from "./subagent-row.tsx";
import { TurnSummary } from "./turn-summary.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";
import { WorktreeSetupCard } from "./worktree-setup-card.tsx";

const EMPTY_MESSAGES: ReadonlyArray<Message> = [];
const TIMELINE_HEADER = (
	<>
		<div className="px-[var(--chat-row-gutter,0.75rem)]">
			<WorktreeSetupCard />
		</div>
		<div className="h-2" />
	</>
);
const TIMELINE_FOOTER = <div className="h-2" />;

interface TimelineEndState {
	readonly isAtEnd?: boolean;
	readonly isNearEnd?: boolean;
}

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
	endInset = 0,
}: {
	readonly sessionId: SessionId;
	/** Height of the floating composer overlay; padded into the scroll range. */
	readonly endInset?: number;
}) {
	useLayoutEffect(() => {
		markRendererInteraction(sessionId, "first-react-commit");
	}, [sessionId]);
	const prefersReducedMotion = usePrefersReducedMotion();
	const messages = useMessagesStore(
		(state) => state.messagesBySession[sessionId] ?? EMPTY_MESSAGES,
	);
	const timelineVersion = useMessagesStore(
		(state) => state.timelineVersionBySession[sessionId] ?? 0,
	);
	const renderRecovery = useMessagesStore(
		(state) => state.renderRecoveryBySession[sessionId] ?? 0,
	);
	const runtimeState = useSessionRuntimeStore((state) =>
		effectiveSessionRuntimeState(state.bySession[sessionId]),
	);
	const cloudSummary = useCloudChatSummaryForSession(sessionId);
	const cloudAttachment = useCloudExecutionStore((state) =>
		cloudSummary === null
			? "detached"
			: (state.stateByWorkspace[cloudSummary.workspaceId] ?? "detached"),
	);
	const cloudCommand = useCloudChatsStore((state) =>
		cloudSummary === null
			? null
			: (state.commandByWorkspace[cloudSummary.workspaceId]?.state ?? null),
	);
	const cloudActivity =
		cloudSummary === null
			? null
			: deriveCloudChatActivity({
					summary: cloudSummary,
					attachment: cloudAttachment,
					runtime: runtimeState,
					command: cloudCommand,
				});
	const inFlight =
		cloudActivity === null
			? runtimeState === "starting" ||
				runtimeState === "running" ||
				runtimeState === "stopping"
			: cloudChatShowsWorking(cloudActivity);
	const awaitingPermissionPlanApproval = usePermissionsStore((state) => {
		for (const request of Object.values(state.requestsById)) {
			if (request.sessionId !== sessionId) continue;
			if (request.kind._tag !== "Other") continue;
			if (request.kind.tool === "ExitPlanMode") return true;
		}
		return false;
	});
	const awaitingPlanApproval =
		awaitingPermissionPlanApproval ||
		deriveChatAttentionState(messages, inFlight) === "planReady";
	const error = useMessagesStore(
		(state) => state.errorBySession[sessionId] ?? null,
	);
	const clearError = useMessagesStore((state) => state.clearError);
	const hydrate = useMessagesStore((state) => state.hydrate);
	const hydrateSkills = useSkillsStore((state) => state.hydrate);
	const session = useSessionsStore((state) => {
		void state.sessionsByProject;
		return getSessionById(sessionId);
	});
	const cloudHistoryLoading = useCloudChatsStore((state) =>
		cloudSummary === null
			? false
			: state.historyLoadingByChat[cloudSummary.chatId] === true,
	);

	const worktreeId = session?.worktreeId ?? null;
	const setupActive = useWorktreesStore((state) => {
		if (worktreeId === null) return false;
		for (const list of Object.values(state.byProject)) {
			const worktree = (list ?? EMPTY_WORKTREES).find(
				(candidate) => candidate.id === worktreeId,
			);
			if (worktree === undefined) continue;
			return (
				worktree.setupStatus === "running" ||
				worktree.setupStatus === "pending" ||
				worktree.setupStatus === "failed"
			);
		}
		return false;
	});
	const rows = useMemo(
		() =>
			deriveChatTimelineRows({
				messages,
				inFlight,
				awaitingPlanApproval,
			}),
		[awaitingPlanApproval, inFlight, messages],
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
			void timelineReadingPositionStore?.save(position).catch(() => {});
		}
	}, [captureReadingPosition]);
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
		if (cloudSummary === null) {
			void hydrate(sessionId);
			void hydrateSkills(sessionId);
		}
		return () => {
			void teardownLiveStreams(sessionId);
		};
	}, [cloudSummary, hydrate, hydrateSkills, sessionId]);

	useEffect(() => {
		let cancelled = false;
		initializedSessionRef.current = null;
		sessionOpenedEmptyRef.current = messages.length === 0;
		setReadingState(null);
		currentReadingPositionRef.current = null;
		void (async () => {
			const position =
				(await timelineReadingPositionStore
					?.load(sessionId)
					.catch(() => null)) ?? null;
			if (!cancelled) setReadingState({ sessionId, position });
		})();
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

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
				void timelineReadingPositionStore?.save(position).catch(() => {});
			}
			coordinator.dispose();
		},
		[coordinator, sessionId],
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
		const frame = requestAnimationFrame(() => {
			const renderedData = listRef.current?.getState()?.data;
			if (
				renderedData !== undefined &&
				renderedData.length === rows.length &&
				renderedData.at(-1) === rows.at(-1)
			) {
				acknowledgeTimelineRendered(sessionId, timelineVersion);
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [renderRecovery, rows, sessionId, timelineVersion]);

	useLayoutEffect(() => {
		const node = listRef.current?.getScrollableNode() ?? null;
		if (node instanceof HTMLDivElement) {
			node.dataset.pane = "chat";
			node.tabIndex = -1;
			scrollElementRef.current = node;
		} else {
			scrollElementRef.current = null;
		}
	}, [renderRecovery, rows.length, sessionId]);

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
	}, [coordinator, handleScroll, renderRecovery, sessionId]);

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
		const requestKey = `${timelineAnchorMessageId}:${renderRecovery}`;
		if (anchorRequestKeyRef.current === requestKey) return;
		anchorRequestKeyRef.current = requestKey;
		const frame = requestAnimationFrame(() => {
			coordinator.positionAnchoredTurn({ animated: false });
		});
		return () => cancelAnimationFrame(frame);
	}, [anchoredEndSpace, coordinator, renderRecovery, timelineAnchorMessageId]);

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
			<TimelineRow row={item} sessionId={sessionId} />
		),
		[sessionId],
	);
	const readingReady = readingState?.sessionId === sessionId;
	const effectiveReadingPosition =
		currentReadingPositionRef.current?.sessionId === sessionId
			? currentReadingPositionRef.current
			: readingState?.position;
	const initialTarget = resolveInitialTimelineTarget({
		rows,
		position: effectiveReadingPosition,
		recoverAtLiveEdge:
			renderRecovery > 0 && scrollSnapshot.mode === "following",
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
								<WorktreeSetupCard />
							</div>
							{setupActive ? null : cloudHistoryLoading ? (
								<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
									<ShimmerText>Loading chat history…</ShimmerText>
								</div>
							) : (
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
							)}
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
								key={`${sessionId}:${renderRecovery}`}
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
								ListHeaderComponent={TIMELINE_HEADER}
								ListFooterComponent={TIMELINE_FOOTER}
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
									onDismiss={() => clearError(sessionId)}
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
	row,
	sessionId,
}: {
	readonly row: ChatTimelineRow;
	readonly sessionId: SessionId;
}) {
	let content: ReactNode;
	switch (row.kind) {
		case "message":
			content = (
				<MessageRow
					message={row.message}
					sessionId={sessionId}
					showAssistantCommands={row.showAssistantCommands}
				/>
			);
			break;
		case "subagent":
			content = (
				<div>
					<SubagentRow
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
						sessionId={sessionId}
						showAssistantCommands={row.showAssistantCommands}
					/>
				</div>
			);
			break;
		case "working":
			content = (
				<ChatWorkingRow messages={row.messages} sessionId={sessionId} />
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
