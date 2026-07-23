import { useAtomValue } from "@effect/atom-react";
import {
	KeyboardAwareLegendList,
	useKeyboardChatComposerInset,
	useKeyboardScrollToEnd,
} from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { orderedChatSessions } from "@zuse/client-runtime/chat-threads";
import {
	findPendingPlanInteraction,
	isPlanApprovalRequest,
} from "@zuse/client-runtime/plan-interactions";
import { groupTimelineTurns } from "@zuse/client-runtime/timeline";
import type {
	FolderId,
	PermissionRequest,
	SessionId,
	UserQuestion,
} from "@zuse/contracts";
import { PLAN_APPROVAL_PROMPT } from "@zuse/utils/proposed-plan";
import { Effect } from "effect";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { ChevronDown } from "lucide-react-native";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
	AccessibilityInfo,
	Alert,
	AppState,
	type LayoutChangeEvent,
	type NativeScrollEvent,
	type NativeSyntheticEvent,
	Pressable,
	Text,
	View,
} from "react-native";
import {
	KeyboardGestureArea,
	KeyboardStickyView,
} from "react-native-keyboard-controller";
import Animated, {
	useAnimatedProps,
	useAnimatedStyle,
	useReducedMotion,
	useSharedValue,
	withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUniwind } from "uniwind";

import { Composer } from "~/components/composer";
import { ConnectionRecoveryBanner } from "~/components/connection-recovery-banner";
import { ChatManagementBars } from "~/components/messages/chat-management-bars";
import { LivePermissionAccessory } from "~/components/messages/live-permission-accessory";
import type { MessageRowContext } from "~/components/messages/message-row";
import { PendingUserInputCard } from "~/components/messages/pending-user-input-card";
import { PlanReviewCard } from "~/components/messages/plan-review-card";
import { TurnRow } from "~/components/messages/turn-row";
import { ReviewChangesPill } from "~/components/review-changes-pill";
import { SessionActionsMenu } from "~/components/session-actions-menu";
import { ThreadHeaderTitle } from "~/components/thread-header-title";
import { GlassSurface } from "~/components/ui/glass-surface";
import { WorkingIndicator } from "~/components/ui/working-indicator";
import { useTranscriptScrollCoordinator } from "~/hooks/use-transcript-scroll-coordinator";
import { coordinateChatBottomState } from "~/lib/chat-bottom-state";
import { isFreshChat, summarizeComposerActivity } from "~/lib/composer-state";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { captureMobileError } from "~/lib/crash-reporting";
import { buildToolResultsByItemId } from "~/lib/message-presentation";
import { sanitizeMessages } from "~/lib/message-safety";
import { connectionSessionKey } from "~/lib/session-key";
import { shouldRestoreThreadPosition } from "~/lib/thread-switching";
import {
	readThreadViewState,
	writeThreadViewState,
} from "~/lib/thread-view-state";
import {
	answerQuestion,
	makeTextInput,
	respondToPlan,
	sendMessage,
} from "~/rpc/actions";
import {
	connectionSnapshotAtom,
	retryConnection,
	watchConnection,
} from "~/store/connection-runtime";
import {
	connectionsAtom,
	connectionsHydratedAtom,
	hydrateConnections,
} from "~/store/connections";
import {
	clearGoal,
	hydrateGoal,
	releaseGoal,
	sessionGoalAtom,
	setGoal,
} from "~/store/goals";
import {
	deleteQueuedMessage,
	hydrateMessages,
	releaseMessages,
	reorderQueuedMessages,
	resumeQueue,
	sendQueuedMessageNow,
	sessionMessagesAtom,
	sessionMessagesErrorAtom,
	sessionQueueAtom,
	sessionQueuePausedAtom,
	updateQueuedMessage,
} from "~/store/messages";
import {
	cancelOutboxMessage,
	flushOutbox,
	hydrateOutbox,
	queuedMessagesAtom,
	updateOutboxMessage,
} from "~/store/outbox";
import {
	decidePermission,
	hydratePermissionConnection,
	pendingPermissionsAtom,
	reconcilePermissions,
} from "~/store/permissions";
import {
	hydratePinnedChats,
	isPinnedAtom,
	pinnedChatKey,
	pinnedChatsHydratedAtom,
	togglePinnedChat,
} from "~/store/pinned-chats";
import {
	markSessionTurnStartFailed,
	markSessionTurnStarting,
	resolveSessionStatus,
	sessionTurnActivityAtom,
} from "~/store/session-turn-activity";
import {
	archiveChat,
	archiveSession,
	connectionBundlesAtom,
	createSession,
	markChatRead,
	renameChat,
	selectSessionChat,
	setActiveSession,
	setPermissionMode,
	statusBySessionAtom,
} from "~/store/sessions";
import { colors, glass } from "~/theme";

export default function ThreadScreenRoute() {
	const { conn, sessionId, openAtLatest } = useLocalSearchParams<{
		conn: string;
		sessionId: string;
		openAtLatest?: string;
	}>();
	const routeKey = `${connectionSessionKey(
		normalizeConnParam(conn),
		normalizeConnParam(sessionId) as SessionId,
	)}:${openAtLatest ?? ""}`;
	return (
		<ThreadScreenBoundary key={routeKey}>
			<ThreadScreen />
		</ThreadScreenBoundary>
	);
}

function ThreadScreen() {
	const insets = useSafeAreaInsets();
	const headerHeight = useHeaderHeight();
	const { theme } = useUniwind();
	const { conn, sessionId, openAtLatest } = useLocalSearchParams<{
		conn: string;
		sessionId: string;
		openAtLatest?: string;
	}>();
	const connKey = normalizeConnParam(conn);
	const normalizedSessionId = normalizeConnParam(sessionId) as SessionId;
	const restoreThreadPosition = shouldRestoreThreadPosition(openAtLatest);
	const listRef = useRef<LegendListRef>(null);
	const distanceFromBottomRef = useRef(0);
	const scrollOffsetRef = useRef(0);
	const hasUnseenContentRef = useRef(false);
	const preAppendUiRef = useRef<{
		readonly hasUnseenContent: boolean;
		readonly jumpAccessible: boolean;
	} | null>(null);
	const previousMessagesRef = useRef<readonly unknown[] | null>(null);
	const readerGestureActiveRef = useRef(false);
	const composerOverlayRef = useRef<View>(null);
	const [jumpAccessible, setJumpAccessible] = useState(false);
	const [hasUnseenContent, setHasUnseenContent] = useState(false);
	const composerBottomInset = insets.bottom + 10;
	const [bottomAccessoryHeight, setBottomAccessoryHeight] = useState(
		composerBottomInset + 64,
	);
	const isNearEnd = useSharedValue(true);
	const reduceMotion = useReducedMotion();
	const { contentInsetEndAdjustment, onComposerLayout } =
		useKeyboardChatComposerInset(
			listRef,
			composerOverlayRef,
			composerBottomInset + 64,
		);
	const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });
	const connections = useAtomValue(connectionsAtom);
	const hydrated = useAtomValue(connectionsHydratedAtom);
	const options = useMemo(
		() => optionsForConnection(connKey, connections),
		[connKey, connections],
	);
	const stateKey = connectionSessionKey(connKey, normalizedSessionId);
	const turnActivity = useAtomValue(sessionTurnActivityAtom(stateKey));
	const [restoredViewState] = useState(() =>
		restoreThreadPosition ? readThreadViewState(stateKey) : null,
	);
	const connectionSnapshot = useAtomValue(connectionSnapshotAtom(connKey));
	const bundles = useAtomValue(connectionBundlesAtom(connKey));
	const rawMessages = useAtomValue(sessionMessagesAtom(stateKey));
	const messagesError = useAtomValue(sessionMessagesErrorAtom(stateKey));
	const serverQueued = useAtomValue(sessionQueueAtom(stateKey));
	const serverQueuePaused = useAtomValue(sessionQueuePausedAtom(stateKey));
	const messages = useMemo(() => sanitizeMessages(rawMessages), [rawMessages]);
	const turns = useMemo(() => groupTimelineTurns(messages), [messages]);
	// Computed here (not in the composer) so keystrokes never touch it and the
	// composer needs no subscription to the message store.
	const composerActivity = summarizeComposerActivity(turns.at(-1));
	const transcriptScroll = useTranscriptScrollCoordinator({
		initiallyDetached: restoredViewState?.mode === "detached",
		onScrollFailed: () => {
			setJumpAccessible(true);
		},
		releaseFreeze: () => freeze.set(false),
		scrollAnchoredMessageToEnd: () =>
			scrollMessageToEnd({
				animated: !reduceMotion,
				closeKeyboard: false,
			}),
		scrollToLatest: () =>
			listRef.current?.scrollToEnd({ animated: !reduceMotion }) ??
			Promise.reject(new Error("Transcript list is not mounted.")),
	});
	const settleTranscriptTurn = transcriptScroll.onTurnSettled;
	const readReaderDetached = transcriptScroll.isReaderDetached;
	const detail = selectSessionChat(bundles, normalizedSessionId);
	const chatId = detail?.session.chatId ?? null;
	const allConnectionSessions = useMemo(
		() => bundles.flatMap((bundle) => bundle.sessions),
		[bundles],
	);
	// Plain derivations (not useMemo): several inputs flow into module-level
	// atom actions, which the React Compiler treats as possibly mutating — it
	// refuses to preserve manual memoization on them but auto-memoizes fine.
	const chatThreads =
		chatId === null
			? detail === null
				? []
				: [detail.session]
			: orderedChatSessions(allConnectionSessions, chatId);
	const threadIds = chatThreads.map((thread) => thread.id);
	const currentThreadIndex = chatThreads.findIndex(
		(thread) => thread.id === normalizedSessionId,
	);
	const statusBySession = useAtomValue(statusBySessionAtom);
	const runningThreadCount = chatThreads.filter((thread) => {
		const status = statusBySession[connectionSessionKey(connKey, thread.id)];
		return (status ?? thread.status) === "running";
	}).length;
	const title = detail?.chat?.title ?? detail?.session.title ?? "Thread";
	const sessionStatus = resolveSessionStatus(
		statusBySession[stateKey] ?? detail?.session.status,
		turnActivity,
	);
	const fresh = isFreshChat(messages);
	const sessionRunning = sessionStatus === "running";
	const sessionActive = sessionRunning || sessionStatus === "booting";

	const pending = useAtomValue(pendingPermissionsAtom(stateKey));
	const localQueued = useAtomValue(queuedMessagesAtom(stateKey));
	const queuedCount = localQueued.length;
	const unackedLocalQueued = localQueued.filter(
		(item) =>
			!serverQueued.some((serverItem) => serverItem.id === item.clientId),
	);
	const goal = useAtomValue(sessionGoalAtom(stateKey));
	const [screenOpenedAt] = useState(() => Date.now());

	useEffect(() => {
		if (!hydrated) void hydrateConnections();
	}, [hydrated]);

	useEffect(() => {
		if (connKey.length === 0 || options === null) return;
		return watchConnection(connKey, options);
	}, [connKey, options]);

	// One attempt per (chat, session) pair: if the RPC fails (or the chat
	// stream echoes a stale active thread back), re-running would optimistic-
	// patch → roll back → re-run forever — the "maximum update depth exceeded"
	// crash when opening a freshly created thread.
	const activationAttemptRef = useRef<string | null>(null);
	useEffect(() => {
		if (chatId === null || options === null) return;
		if (detail?.chat?.activeSessionId === normalizedSessionId) return;
		const attemptKey = `${chatId}:${normalizedSessionId}`;
		if (activationAttemptRef.current === attemptKey) return;
		activationAttemptRef.current = attemptKey;
		void setActiveSession(connKey, options, chatId, normalizedSessionId).catch(
			() => {},
		);
	}, [
		chatId,
		connKey,
		detail?.chat?.activeSessionId,
		normalizedSessionId,
		options,
	]);

	useEffect(() => {
		void connectionSnapshot?.generation;
		if (normalizedSessionId.length > 0 && options !== null) {
			void hydrateMessages(connKey, options, normalizedSessionId);
			void hydrateGoal(connKey, options, normalizedSessionId);
			void hydrateOutbox(connKey, normalizedSessionId);
		}
		return () => {
			if (normalizedSessionId.length === 0) return;
			void releaseMessages(connKey, normalizedSessionId);
			void releaseGoal(connKey, normalizedSessionId);
		};
	}, [connKey, connectionSnapshot?.generation, normalizedSessionId, options]);

	useEffect(() => {
		void connectionSnapshot?.generation;
		if (options === null || threadIds.length === 0) return;
		void hydratePermissionConnection(connKey, options, threadIds);
	}, [connKey, connectionSnapshot?.generation, options, threadIds]);

	useEffect(() => {
		if (options === null || (!sessionActive && pending.length === 0)) return;
		const poll = () =>
			void reconcilePermissions(connKey, options, normalizedSessionId);
		const timer = setInterval(poll, pending.length > 0 ? 5_000 : 15_000);
		return () => clearInterval(timer);
	}, [connKey, normalizedSessionId, options, pending.length, sessionActive]);

	useEffect(() => {
		if (options === null) return;
		void sessionStatus;
		void reconcilePermissions(connKey, options, normalizedSessionId);
	}, [connKey, normalizedSessionId, options, sessionStatus]);

	useEffect(() => {
		if (options === null) return;
		const subscription = AppState.addEventListener("change", (state) => {
			if (state === "active")
				void reconcilePermissions(connKey, options, normalizedSessionId);
		});
		return () => subscription.remove();
	}, [connKey, normalizedSessionId, options]);

	const pinnedHydrated = useAtomValue(pinnedChatsHydratedAtom);
	const currentPinKey =
		chatId === null ? null : pinnedChatKey(connKey, String(chatId));
	const isPinned = useAtomValue(isPinnedAtom(currentPinKey ?? ""));
	useEffect(() => {
		if (!pinnedHydrated) void hydratePinnedChats();
	}, [pinnedHydrated]);
	// Mark the chat read on open/focus (and when the chat resolves after a
	// hydrate) so the inbox unread styling clears. Idempotent server-side.
	useEffect(() => {
		if (chatId === null || options === null) return;
		void markChatRead(connKey, options, chatId);
	}, [chatId, connKey, options]);

	const error = messagesError;
	const transportOnline = connectionSnapshot?.status === "connected";
	const connectionProblem =
		connectionSnapshot?.status === "blockedAuth" ||
		connectionSnapshot?.status === "error"
			? connectionSnapshot.error
				? connectionErrorMessage(connectionSnapshot.error)
				: "Connection unavailable. Retry from the status above."
			: null;

	// Drain the outbox in order while the transport is online. This runs both
	// when the connection wakes and when an item gets queued after a failed send.
	useEffect(() => {
		if (
			!transportOnline ||
			normalizedSessionId.length === 0 ||
			options === null ||
			queuedCount === 0
		) {
			return;
		}
		let cancelled = false;
		const run = () => {
			if (cancelled) return;
			void flushOutbox(connKey, options, normalizedSessionId);
		};
		run();
		const timer = setInterval(run, 2_000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [connKey, normalizedSessionId, transportOnline, options, queuedCount]);

	// Cross-reference question rows so answered prompts collapse and the answer
	// row can resolve selected option labels.
	const { answeredQuestionIds, questionsByItemId } = useMemo(() => {
		const answered = new Set<string>();
		const questions = new Map<string, readonly UserQuestion[]>();
		for (const message of messages) {
			const content = message.content;
			if (content._tag === "user_question") {
				questions.set(content.itemId, content.questions);
			} else if (content._tag === "user_question_answer") {
				answered.add(content.itemId);
			}
		}
		return { answeredQuestionIds: answered, questionsByItemId: questions };
	}, [messages]);
	const toolResultsByItemId = useMemo(
		() => buildToolResultsByItemId(messages),
		[messages],
	);
	const permissionRequests = pending.filter(
		(request) => !isPlanApprovalRequest(request, normalizedSessionId),
	);
	const pendingPlanInteraction =
		detail === null
			? null
			: findPendingPlanInteraction({
					messages,
					requests: pending,
					sessionId: normalizedSessionId,
					providerId: detail.session.providerId,
					permissionMode: detail.session.permissionMode,
					isRunning: sessionActive,
				});
	const headPermission = permissionRequests[0] ?? null;
	const pendingQuestion = (() => {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const content = messages[index]?.content;
			if (
				content?._tag === "user_question" &&
				!answeredQuestionIds.has(content.itemId)
			) {
				return { itemId: content.itemId, questions: content.questions };
			}
		}
		return null;
	})();
	const bottomState = coordinateChatBottomState({
		permissions: permissionRequests,
		question: pendingQuestion,
		planReview: pendingPlanInteraction,
		goal,
		serverQueueCount: serverQueued.length,
		localQueueCount: unackedLocalQueued.length,
		queuePaused: serverQueuePaused,
	});

	// The live "working" row shows the whole time the agent runs, but not while a
	// prompt takeover (permission / question / plan) owns the bottom slot.
	const workingActive =
		sessionActive &&
		headPermission === null &&
		pendingQuestion === null &&
		pendingPlanInteraction === null;
	const workingSince = turns.at(-1)?.startedAt.getTime() ?? screenOpenedAt;

	const onAnswerQuestion: MessageRowContext["onAnswerQuestion"] = (
		itemId,
		answers,
	) =>
		options === null
			? Promise.resolve()
			: Effect.runPromise(
					answerQuestion({
						connection: options,
						sessionId: normalizedSessionId,
						itemId,
						answers,
					}),
				);

	const ctx: MessageRowContext = {
		connectionKey: connKey,
		sessionId: normalizedSessionId,
		workspaceRoot: detail?.project.path,
		answeredQuestionIds,
		questionsByItemId,
		toolResultsByItemId,
		sessionRunning: sessionActive,
		onAnswerQuestion,
	};

	useEffect(() => {
		const saved = restoredViewState;
		distanceFromBottomRef.current = saved?.distanceFromBottom ?? 0;
		scrollOffsetRef.current = saved?.offsetY ?? 0;
		hasUnseenContentRef.current = false;
		previousMessagesRef.current = null;
		return () => {
			writeThreadViewState(stateKey, {
				mode: readReaderDetached() ? "detached" : "following",
				offsetY: scrollOffsetRef.current,
				distanceFromBottom: distanceFromBottomRef.current,
			});
		};
	}, [readReaderDetached, restoredViewState, stateKey]);

	useEffect(() => {
		if (previousMessagesRef.current === null) {
			previousMessagesRef.current = messages;
			return;
		}
		if (previousMessagesRef.current === messages) return;
		previousMessagesRef.current = messages;
		if (!transcriptScroll.readerDetached || hasUnseenContentRef.current) {
			return;
		}
		hasUnseenContentRef.current = true;
		setHasUnseenContent(true);
		setJumpAccessible(true);
		void AccessibilityInfo.announceForAccessibility(
			"New response available below.",
		);
	}, [messages, transcriptScroll.readerDetached]);

	// Scroll events persist reader position only. LegendList and the keyboard-aware
	// scroll view own end detection; duplicating that geometry here caused the jump
	// control to disagree with the actual keyboard-adjusted end.
	const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
		const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
		if (
			readerGestureActiveRef.current &&
			listRef.current?.getState().isNearEnd === false &&
			!readReaderDetached()
		) {
			preAppendUiRef.current = null;
			transcriptScroll.onReaderDetached();
		}
		scrollOffsetRef.current = Math.max(0, contentOffset.y);
		const distanceFromBottom =
			contentSize.height - (contentOffset.y + layoutMeasurement.height);
		distanceFromBottomRef.current = Math.max(0, distanceFromBottom);
		writeThreadViewState(stateKey, {
			mode: readReaderDetached() ? "detached" : "following",
			offsetY: scrollOffsetRef.current,
			distanceFromBottom: distanceFromBottomRef.current,
		});
	};
	const detachReader = () => {
		preAppendUiRef.current = null;
		transcriptScroll.onReaderDetached();
	};
	const startReaderGesture = () => {
		readerGestureActiveRef.current = true;
	};
	const finishReaderGesture = () => {
		readerGestureActiveRef.current = false;
		if (listRef.current?.getState().isNearEnd === true) {
			transcriptScroll.onFollowingRequested();
			return;
		}
		detachReader();
	};
	const onEndVisible = (visible: boolean) => {
		if (!visible) {
			setJumpAccessible(true);
			return;
		}
		hasUnseenContentRef.current = false;
		setHasUnseenContent(false);
		setJumpAccessible(false);
	};

	const jumpToLatest = () => {
		if (turns.length === 0) return;
		preAppendUiRef.current = null;
		transcriptScroll.requestJump();
		hasUnseenContentRef.current = false;
		setHasUnseenContent(false);
	};
	const onMessageWillAppend = () => {
		preAppendUiRef.current = {
			hasUnseenContent: hasUnseenContentRef.current,
			jumpAccessible,
		};
		transcriptScroll.onMessageWillAppend(turns.length);
		markSessionTurnStarting(stateKey);
		hasUnseenContentRef.current = false;
		setHasUnseenContent(false);
		setJumpAccessible(false);
	};
	const onMessageAppendFailed = () => {
		transcriptScroll.onMessageAppendFailed();
		markSessionTurnStartFailed(stateKey);
		const previous = preAppendUiRef.current;
		preAppendUiRef.current = null;
		if (previous === null) return;
		hasUnseenContentRef.current = previous.hasUnseenContent;
		setHasUnseenContent(previous.hasUnseenContent);
		setJumpAccessible(previous.jumpAccessible);
	};
	useEffect(() => {
		if (turnActivity === "idle") settleTranscriptTurn();
	}, [settleTranscriptTurn, turnActivity]);
	const onComposerFocusChange = (_focused: boolean) => undefined;

	const jumpStyle = useAnimatedStyle(() => ({
		opacity: withTiming(isNearEnd.value ? 0 : 1, {
			duration: reduceMotion ? 0 : 160,
		}),
	}));
	const jumpAnimatedProps = useAnimatedProps(() => ({
		pointerEvents: isNearEnd.value ? ("none" as const) : ("box-none" as const),
	}));
	const onBottomAccessoryLayout = (event: LayoutChangeEvent) => {
		const nextHeight = event.nativeEvent.layout.height;
		setBottomAccessoryHeight((current) =>
			Math.abs(current - nextHeight) < 1 ? current : nextHeight,
		);
		onComposerLayout(event);
	};
	const anchoredEndSpace =
		transcriptScroll.anchorIndex === null
			? undefined
			: {
					anchorIndex: transcriptScroll.anchorIndex,
					anchorMaxSize: 72,
					anchorOffset: headerHeight + 12,
					onReady: transcriptScroll.onAnchorReady,
				};

	const onRename = () => {
		if (chatId === null || options === null) return;
		Alert.prompt(
			"Rename chat",
			undefined,
			(value) => {
				const next = value?.trim() ?? "";
				if (next.length === 0) return;
				void renameChat(connKey, options, chatId, next);
			},
			"plain-text",
			title,
		);
	};

	const onArchive = () => {
		if (chatId === null || options === null) return;
		void archiveChat(connKey, options, chatId).then(() => router.back());
	};
	const openChanges = () => {
		router.push({
			pathname: "/c/[conn]/session/[sessionId]/review",
			params: { conn: connKey, sessionId: normalizedSessionId },
		});
	};
	const openFiles = () => {
		router.push({
			pathname: "/c/[conn]/session/[sessionId]/files",
			params: { conn: connKey, sessionId: normalizedSessionId },
		});
	};
	const openThreads = () => {
		if (chatId === null) return;
		router.push({
			pathname: "/c/[conn]/chat/[chatId]/threads",
			params: {
				conn: connKey,
				chatId,
				sessionId: normalizedSessionId,
			},
		});
	};

	const renderPermissionAccessory = (requests: readonly PermissionRequest[]) =>
		options === null ? null : (
			<LivePermissionAccessory
				requests={requests}
				bottomInset={composerBottomInset}
				onDecide={(request, decision) =>
					decidePermission(
						connKey,
						options,
						normalizedSessionId,
						request.id,
						decision,
					)
				}
				onDenyWithMessage={async (request, message) => {
					await decidePermission(
						connKey,
						options,
						normalizedSessionId,
						request.id,
						{ _tag: "Deny" },
					);
					await Effect.runPromise(
						sendMessage({
							connection: options,
							sessionId: normalizedSessionId,
							input: makeTextInput(message),
						}),
					);
				}}
			/>
		);

	const resolvePlanInteraction = async (
		outcome: "approved" | "cancelled" | "abandoned",
		feedback?: string,
	) => {
		if (options === null || pendingPlanInteraction === null) return;
		if (pendingPlanInteraction.kind === "permission") {
			await decidePermission(
				connKey,
				options,
				normalizedSessionId,
				pendingPlanInteraction.request.id,
				outcome === "approved" ? { _tag: "AllowOnce" } : { _tag: "Deny" },
			);
			return;
		}
		if (pendingPlanInteraction.kind === "native") {
			await Effect.runPromise(
				respondToPlan({
					connection: options,
					sessionId: normalizedSessionId,
					toolCallId: pendingPlanInteraction.native.toolCallId,
					outcome,
					feedback,
				}),
			);
		}
	};

	const runPlanAction = async (
		action: "approve" | "feedback" | "handoff" | "abandon",
		feedback: string,
	) => {
		if (options === null || pendingPlanInteraction === null || detail === null)
			return;
		if (action === "feedback") {
			if (pendingPlanInteraction.kind === "native") {
				await resolvePlanInteraction("cancelled", feedback);
				return;
			}
			if (pendingPlanInteraction.kind === "permission")
				await resolvePlanInteraction("cancelled", feedback);
			await Effect.runPromise(
				sendMessage({
					connection: options,
					sessionId: normalizedSessionId,
					input: makeTextInput(feedback),
				}),
			);
			return;
		}
		if (action === "handoff") {
			if (pendingPlanInteraction.plan === null || detail.chat === undefined)
				throw new Error("The exact plan is unavailable.");
			const session = await createSession(connKey, options, {
				chatId: detail.chat.id,
				providerId: detail.session.providerId,
				model: detail.session.model,
				title: "Build",
				runtimeMode: detail.session.runtimeMode,
				permissionMode: "default",
				initialPrompt: `${PLAN_APPROVAL_PROMPT}\n\n${pendingPlanInteraction.plan}`,
			});
			try {
				if (pendingPlanInteraction.kind === "emulated") {
					await setPermissionMode(
						connKey,
						options,
						normalizedSessionId,
						"default",
					);
				} else {
					await resolvePlanInteraction("abandoned");
				}
			} catch (cause) {
				await archiveSession(connKey, options, session.id);
				throw cause;
			}
			router.replace({
				pathname: "/c/[conn]/session/[sessionId]",
				params: { conn: connKey, sessionId: session.id },
			});
			return;
		}
		if (action === "abandon") {
			await resolvePlanInteraction("abandoned");
			await setPermissionMode(connKey, options, normalizedSessionId, "default");
			return;
		}
		if (pendingPlanInteraction.kind === "emulated") {
			await setPermissionMode(connKey, options, normalizedSessionId, "default");
			await Effect.runPromise(
				sendMessage({
					connection: options,
					sessionId: normalizedSessionId,
					input: makeTextInput(PLAN_APPROVAL_PROMPT),
				}),
			);
			return;
		}
		await resolvePlanInteraction("approved");
	};

	return (
		<View className="flex-1 bg-background">
			<Stack.Screen
				options={{
					headerLargeTitle: false,
					headerTitle: () => (
						<ThreadHeaderTitle
							title={title}
							current={Math.max(1, currentThreadIndex + 1)}
							total={Math.max(1, chatThreads.length)}
							runningCount={runningThreadCount}
							onPress={openThreads}
						/>
					),
					headerRight: () => (
						<SessionActionsMenu
							isPinned={isPinned}
							onNewChat={() => router.push("/new-chat")}
							onPin={
								currentPinKey === null
									? undefined
									: () => void togglePinnedChat(currentPinKey)
							}
							onRename={chatId === null ? undefined : onRename}
							onThreads={openThreads}
							onChanges={openChanges}
							onFiles={openFiles}
							onArchive={onArchive}
						/>
					),
				}}
			/>
			{hydrated && options === null ? (
				<View className="px-4 py-3">
					<Text selectable className="font-sans text-[13px] text-danger">
						This saved connection could not be found on this phone. Go back and
						connect the computer again.
					</Text>
				</View>
			) : null}
			<KeyboardGestureArea interpolator="ios" offset={60} style={{ flex: 1 }}>
				<KeyboardAwareLegendList
					ref={listRef}
					style={{ flex: 1 }}
					data={turns}
					dataKey={stateKey}
					keyExtractor={(turn) => turn.id}
					getItemType={() => "turn"}
					estimatedItemSize={180}
					renderItem={({ item, index }) => (
						<TurnRow
							turn={item}
							context={ctx}
							live={sessionStatus === "running" && index === turns.length - 1}
						/>
					)}
					alignItemsAtEnd
					applyWorkaroundForContentInsetHitTestBug
					contentInsetAdjustmentBehavior="never"
					automaticallyAdjustsScrollIndicatorInsets={false}
					contentContainerStyle={{
						gap: 4,
						paddingHorizontal: 16,
						paddingTop: headerHeight + 12,
					}}
					scrollIndicatorInsets={{
						top: headerHeight,
						bottom: -insets.bottom,
					}}
					contentInsetEndAdjustment={contentInsetEndAdjustment}
					freeze={freeze}
					keyboardLiftBehavior="whenAtEnd"
					keyboardDismissMode="interactive"
					keyboardOffset={insets.bottom}
					keyboardShouldPersistTaps="handled"
					initialScrollAtEnd={restoredViewState?.mode !== "detached"}
					{...(restoredViewState?.mode === "detached"
						? { initialScrollOffset: restoredViewState.offsetY }
						: {})}
					{...(anchoredEndSpace === undefined
						? {}
						: {
								anchoredEndSpace,
							})}
					maintainScrollAtEnd={
						transcriptScroll.readerDetached
							? false
							: {
									animated: false,
									on: {
										dataChange: true,
										footerLayout: true,
										itemLayout: true,
										layout: true,
									},
								}
					}
					maintainScrollAtEndThreshold={0.1}
					maintainVisibleContentPosition
					sharedValues={{ isNearEnd }}
					ListHeaderComponent={
						error || connectionProblem ? (
							<View className="gap-2 pb-2">
								{connectionProblem && options !== null ? (
									<ConnectionRecoveryBanner
										message={connectionProblem}
										onRetry={() => retryConnection(connKey, options)}
										onPairAgain={() => router.push("/connect/scan")}
									/>
								) : null}
								{error ? (
									<Text
										selectable
										className="font-sans text-[13px] text-danger"
									>
										{error}
									</Text>
								) : null}
							</View>
						) : null
					}
					ListFooterComponent={
						<View style={{ paddingTop: 4 }}>
							{workingActive ? <WorkingIndicator since={workingSince} /> : null}
						</View>
					}
					onScroll={onScroll}
					onScrollBeginDrag={startReaderGesture}
					onScrollEndDrag={finishReaderGesture}
					onMomentumScrollBegin={startReaderGesture}
					onMomentumScrollEnd={finishReaderGesture}
					onEndVisible={onEndVisible}
					scrollEventThrottle={64}
				/>
			</KeyboardGestureArea>
			<KeyboardStickyView
				pointerEvents="box-none"
				style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
				offset={{ closed: 0, opened: insets.bottom }}
			>
				<Animated.View
					animatedProps={jumpAnimatedProps}
					accessibilityElementsHidden={!jumpAccessible}
					importantForAccessibility={
						jumpAccessible ? "auto" : "no-hide-descendants"
					}
					style={[
						jumpStyle,
						{
							position: "absolute",
							left: 0,
							right: 0,
							bottom: bottomAccessoryHeight + 8,
							alignItems: "center",
						},
					]}
				>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel={
							hasUnseenContent
								? "Jump to latest, new response available"
								: "Jump to latest"
						}
						accessibilityHint="Resumes following the live response"
						accessible={jumpAccessible}
						hitSlop={8}
						onPress={jumpToLatest}
						style={{ width: 46, height: 46 }}
					>
						<GlassSurface
							pointerEvents="none"
							style={{
								width: 46,
								height: 46,
								borderRadius: 23,
								borderWidth: 1,
								borderColor:
									theme === "dark" ? glass.borderDark : glass.borderLight,
								backgroundColor:
									theme === "dark" ? glass.fillDark : glass.fillLight,
								alignItems: "center",
								justifyContent: "center",
								shadowColor: "#000",
								shadowOpacity: theme === "dark" ? 0.32 : 0.14,
								shadowRadius: 14,
								shadowOffset: { width: 0, height: 6 },
							}}
						>
							<ChevronDown size={20} color={colors.fg} />
							{hasUnseenContent ? (
								<View
									style={{
										position: "absolute",
										top: 5,
										right: 5,
										width: 7,
										height: 7,
										borderRadius: 4,
										backgroundColor: colors.accent,
									}}
								/>
							) : null}
						</GlassSurface>
					</Pressable>
				</Animated.View>
				<View
					pointerEvents="none"
					style={{
						position: "absolute",
						left: 0,
						right: 0,
						bottom: 0,
						height: bottomAccessoryHeight + 40,
						experimental_backgroundImage:
							theme === "dark"
								? "linear-gradient(to bottom, rgba(15,15,15,0) 0%, rgba(15,15,15,0.72) 55%, rgb(15,15,15) 100%)"
								: "linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.72) 55%, rgb(255,255,255) 100%)",
					}}
				/>
				<View
					ref={composerOverlayRef}
					onLayout={onBottomAccessoryLayout}
					pointerEvents="box-none"
				>
					{options === null ? null : bottomState.blocking?.kind ===
						"permission" ? (
						renderPermissionAccessory(bottomState.blocking.requests)
					) : bottomState.blocking?.kind === "question" ? (
						<View
							className="px-3 pt-2"
							style={{
								paddingBottom: composerBottomInset,
							}}
						>
							<PendingUserInputCard
								itemId={bottomState.blocking.question.itemId}
								questions={bottomState.blocking.question.questions}
								onSubmit={onAnswerQuestion}
							/>
						</View>
					) : bottomState.planReview !== null ? (
						<PlanReviewCard
							interaction={bottomState.planReview}
							bottomInset={composerBottomInset}
							onAction={runPlanAction}
						/>
					) : null}
					{options === null ? null : (
						<View
							pointerEvents="box-none"
							style={
								bottomState.blocking !== null || bottomState.planReview !== null
									? { display: "none" }
									: undefined
							}
						>
							<ChatManagementBars
								runningThreads={runningThreadCount}
								goal={goal}
								planBlocked={pendingPlanInteraction !== null}
								queue={serverQueued}
								localQueue={unackedLocalQueued}
								queueCount={bottomState.queue.count}
								queuePaused={serverQueuePaused}
								onSetGoal={(input) =>
									setGoal(connKey, options, normalizedSessionId, input)
								}
								onClearGoal={() =>
									clearGoal(connKey, options, normalizedSessionId)
								}
								onDeleteQueue={(id) =>
									deleteQueuedMessage(connKey, options, normalizedSessionId, id)
								}
								onUpdateQueue={(item, text) =>
									updateQueuedMessage(
										connKey,
										options,
										normalizedSessionId,
										item.id,
										{ ...item.input, text },
									)
								}
								onSendQueue={(id) =>
									sendQueuedMessageNow(
										connKey,
										options,
										normalizedSessionId,
										id,
									)
								}
								onMoveQueue={(id, direction) => {
									const ids = serverQueued.map((item) => item.id);
									const from = ids.indexOf(id);
									const to = from + direction;
									if (from < 0 || to < 0 || to >= ids.length)
										return Promise.resolve();
									const next = [...ids];
									const [moved] = next.splice(from, 1);
									if (moved !== undefined) next.splice(to, 0, moved);
									return reorderQueuedMessages(
										connKey,
										options,
										normalizedSessionId,
										next,
									);
								}}
								onResumeQueue={() =>
									resumeQueue(connKey, options, normalizedSessionId)
								}
								onDeleteLocalQueue={(id) =>
									cancelOutboxMessage(connKey, normalizedSessionId, id)
								}
								onUpdateLocalQueue={(id, text) =>
									updateOutboxMessage(connKey, normalizedSessionId, id, text)
								}
							/>
							{detail !== null && !sessionActive ? (
								<ReviewChangesPill
									connection={options}
									folderId={detail.project.id as FolderId}
									worktreeId={detail.session.worktreeId}
									refreshKey={`${turns.length}`}
									onPress={() =>
										router.push({
											pathname: "/c/[conn]/session/[sessionId]/review",
											params: {
												conn: connKey,
												sessionId: normalizedSessionId,
											},
										})
									}
								/>
							) : null}
							<Composer
								key={stateKey}
								connKey={connKey}
								connection={options}
								sessionId={normalizedSessionId}
								session={detail?.session ?? null}
								status={sessionStatus}
								fresh={fresh}
								online={transportOnline}
								connectionStatus={connectionSnapshot?.status}
								onRetryConnection={() => retryConnection(connKey, options)}
								onFocusChange={onComposerFocusChange}
								onMessageAppendFailed={onMessageAppendFailed}
								onMessageWillAppend={onMessageWillAppend}
								currentActivity={
									turnActivity === "running" ? composerActivity : null
								}
								bottomInset={composerBottomInset}
							/>
						</View>
					)}
				</View>
			</KeyboardStickyView>
		</View>
	);
}

class ThreadScreenBoundary extends React.Component<
	{ readonly children: React.ReactNode },
	{ readonly failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError(): { readonly failed: boolean } {
		return { failed: true };
	}

	componentDidCatch(error: unknown, info: React.ErrorInfo): void {
		void captureMobileError(error, {
			context: "thread-screen",
			componentStack: info.componentStack ?? undefined,
		});
	}

	render() {
		if (this.state.failed) {
			return (
				<View className="flex-1 items-center justify-center bg-background px-5">
					<Text className="font-sans-medium text-base text-foreground">
						This chat could not be opened.
					</Text>
					<Text className="mt-2 text-center font-sans text-sm leading-5 text-muted-foreground">
						The crash report is saved and will stay visible after restart.
					</Text>
				</View>
			);
		}
		return this.props.children;
	}
}
