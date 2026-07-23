import { useAtomValue } from "@effect/atom-react";
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
import React, {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	AccessibilityInfo,
	Alert,
	AppState,
	Dimensions,
	FlatList,
	Keyboard,
	type KeyboardEvent,
	type LayoutChangeEvent,
	type NativeScrollEvent,
	type NativeSyntheticEvent,
	Pressable,
	Text,
	View,
} from "react-native";
import Animated, {
	useAnimatedKeyboard,
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
import {
	LIVE_EDGE_ENTER_PX,
	nextThreadScrollMode,
	pendingThreadScrollCommand,
	sendAnchorSpace,
	shouldFollowTranscript,
	shouldShowLatestAction,
	type ThreadScrollMode,
	transcriptBottomInset,
} from "~/lib/thread-scroll";
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
	return (
		<ThreadScreenBoundary>
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
	const listRef = useRef<FlatList>(null);
	const scrollModeRef = useRef<ThreadScrollMode>("initial");
	const distanceFromBottomRef = useRef(0);
	const scrollOffsetRef = useRef(0);
	const pendingRestoreOffsetRef = useRef<number | null>(null);
	const pendingInitialEndRef = useRef(!restoreThreadPosition);
	const pendingSendAnchorRef = useRef(false);
	const pendingJumpToEndRef = useRef(false);
	const sendAnchorBaselineRef = useRef<string | null>(null);
	const hasUnseenContentRef = useRef(false);
	const previousMessagesRef = useRef<readonly unknown[] | null>(null);
	const [showJumpButton, setShowJumpButton] = useState(false);
	const [hasUnseenContent, setHasUnseenContent] = useState(false);
	const [keyboardOverlap, setKeyboardOverlap] = useState(0);
	const [listViewportHeight, setListViewportHeight] = useState(0);
	const [anchoredTurnId, setAnchoredTurnId] = useState<string | null>(null);
	const [bottomAccessoryHeight, setBottomAccessoryHeight] = useState(
		Math.max(insets.bottom, 12) + 64,
	);
	const jumpOpacity = useSharedValue(0);
	const reduceMotion = useReducedMotion();
	// UI-thread keyboard height: moves the bottom chrome in per-frame lockstep
	// with the OS keyboard (including interactive drag-dismiss), with zero JS
	// re-renders. The coarse keyboardOverlap state below only feeds list layout.
	const keyboard = useAnimatedKeyboard();
	const connections = useAtomValue(connectionsAtom);
	const hydrated = useAtomValue(connectionsHydratedAtom);
	const options = useMemo(
		() => optionsForConnection(connKey, connections),
		[connKey, connections],
	);
	const stateKey = connectionSessionKey(connKey, normalizedSessionId);
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
	const latestTurnId = turns.at(-1)?.id ?? null;
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
	const sessionStatus = statusBySession[stateKey] ?? detail?.session.status;
	const fresh = isFreshChat(messages);
	const sessionRunning = sessionStatus === "running";

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
		if (options === null || (!sessionRunning && pending.length === 0)) return;
		const poll = () =>
			void reconcilePermissions(connKey, options, normalizedSessionId);
		const timer = setInterval(poll, pending.length > 0 ? 5_000 : 15_000);
		return () => clearInterval(timer);
	}, [connKey, normalizedSessionId, options, pending.length, sessionRunning]);

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
					isRunning: sessionRunning,
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
		sessionRunning &&
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
		sessionRunning: sessionStatus === "running",
		onAnswerQuestion,
	};

	useEffect(() => {
		const saved = restoreThreadPosition ? readThreadViewState(stateKey) : null;
		scrollModeRef.current = saved?.mode ?? "initial";
		distanceFromBottomRef.current = saved?.distanceFromBottom ?? 0;
		scrollOffsetRef.current = saved?.offsetY ?? 0;
		pendingRestoreOffsetRef.current =
			saved?.mode === "detached" ? saved.offsetY : null;
		pendingInitialEndRef.current = saved?.mode !== "detached";
		pendingSendAnchorRef.current = false;
		pendingJumpToEndRef.current = false;
		sendAnchorBaselineRef.current = null;
		hasUnseenContentRef.current = false;
		previousMessagesRef.current = null;
		setHasUnseenContent(false);
		setShowJumpButton(false);
		setAnchoredTurnId(null);
		return () => {
			const mode = scrollModeRef.current;
			if (mode === "initial") return;
			writeThreadViewState(stateKey, {
				mode,
				offsetY: scrollOffsetRef.current,
				distanceFromBottom: distanceFromBottomRef.current,
			});
		};
	}, [restoreThreadPosition, stateKey]);

	useEffect(() => {
		// LayoutAnimation on Fabric made the chrome lag the keyboard. The visible
		// chrome rides the UI-thread keyboard value; this state only resizes the
		// list layout.
		const updateKeyboardOverlap = (event: KeyboardEvent) => {
			const screenHeight = Dimensions.get("screen").height;
			const keyboardBottom =
				event.endCoordinates.screenY + event.endCoordinates.height;
			const isDocked = keyboardBottom >= screenHeight - 2;
			const nextOverlap = isDocked
				? Math.max(0, screenHeight - event.endCoordinates.screenY)
				: 0;
			setKeyboardOverlap(nextOverlap);
		};
		const showEvent =
			process.env.EXPO_OS === "ios"
				? "keyboardWillChangeFrame"
				: "keyboardDidShow";
		const hideEvent =
			process.env.EXPO_OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
		const showSubscription = Keyboard.addListener(
			showEvent,
			updateKeyboardOverlap,
		);
		const hideSubscription = Keyboard.addListener(hideEvent, () => {
			setKeyboardOverlap(0);
		});
		return () => {
			showSubscription.remove();
			hideSubscription.remove();
		};
	}, []);

	useEffect(() => {
		if (previousMessagesRef.current === null) {
			previousMessagesRef.current = messages;
			return;
		}
		if (previousMessagesRef.current === messages) return;
		previousMessagesRef.current = messages;
		if (scrollModeRef.current !== "detached" || hasUnseenContentRef.current) {
			return;
		}
		hasUnseenContentRef.current = true;
		setHasUnseenContent(true);
		setShowJumpButton(true);
		void AccessibilityInfo.announceForAccessibility(
			"New response available below.",
		);
	}, [messages]);

	// Fade the jump button in/out from its visibility state (assignment must
	// live in an effect for the React Compiler's shared-value immutability rule).
	useEffect(() => {
		jumpOpacity.value = withTiming(showJumpButton ? 1 : 0, {
			duration: reduceMotion ? 0 : 160,
		});
	}, [jumpOpacity, reduceMotion, showJumpButton]);

	// Open-at-latest lands at the true end of the content. Repeated non-animated
	// calls while early content batches arrive are harmless and self-correcting;
	// the pending flag clears one frame after the first call.
	const attemptInitialEnd = () => {
		if (!pendingInitialEndRef.current || turns.length === 0) return;
		listRef.current?.scrollToEnd({ animated: false });
		requestAnimationFrame(() => {
			if (!pendingInitialEndRef.current) return;
			pendingInitialEndRef.current = false;
			scrollModeRef.current = nextThreadScrollMode(scrollModeRef.current, {
				type: "initial-positioned",
			});
		});
	};
	// After a send, pin the new turn's top just below the header (ChatGPT-style):
	// the reply then streams into the space below without further scroll calls —
	// the send-anchor footer spacer guarantees the offset stays valid. Waits for
	// the turn id to move past the baseline recorded at submit so keyboard- or
	// footer-driven content-size changes cannot anchor the previous turn.
	const prepareSendAnchor = () => {
		if (!pendingSendAnchorRef.current || latestTurnId === null) return;
		if (latestTurnId === sendAnchorBaselineRef.current) return;
		if (!shouldFollowTranscript(scrollModeRef.current)) {
			pendingSendAnchorRef.current = false;
			return;
		}
		if (anchoredTurnId === latestTurnId) return;
		setAnchoredTurnId(latestTurnId);
	};
	const restoreDetachedPosition = useCallback(() => {
		const offset = pendingRestoreOffsetRef.current;
		if (offset === null || messages.length === 0) return false;
		pendingRestoreOffsetRef.current = null;
		requestAnimationFrame(() => {
			listRef.current?.scrollToOffset({ offset, animated: false });
		});
		return true;
	}, [messages.length]);

	// Plain functions (not useCallback): the React Compiler memoizes them, and
	// manual memoization of setState-calling callbacks trips its preservation rule.
	const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
		const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
		scrollOffsetRef.current = Math.max(0, contentOffset.y);
		const distanceFromBottom =
			contentSize.height - (contentOffset.y + layoutMeasurement.height);
		distanceFromBottomRef.current = Math.max(0, distanceFromBottom);
		if (scrollModeRef.current !== "initial") {
			writeThreadViewState(stateKey, {
				mode: scrollModeRef.current,
				offsetY: scrollOffsetRef.current,
				distanceFromBottom: distanceFromBottomRef.current,
			});
		}
		setShowJumpButton(
			shouldShowLatestAction({
				mode: scrollModeRef.current,
				distance: distanceFromBottomRef.current,
				hasUnseenContent: hasUnseenContentRef.current,
			}),
		);
	};
	const detachReader = () => {
		scrollModeRef.current = nextThreadScrollMode(scrollModeRef.current, {
			type: "reader-interacted",
		});
		setShowJumpButton(
			shouldShowLatestAction({
				mode: scrollModeRef.current,
				distance: distanceFromBottomRef.current,
				hasUnseenContent: hasUnseenContentRef.current,
			}),
		);
	};
	const resumeAtLiveEdge = () => {
		scrollModeRef.current = nextThreadScrollMode(scrollModeRef.current, {
			type: "returned-to-live-edge",
			distance: distanceFromBottomRef.current,
		});
		if (scrollModeRef.current !== "following") return;
		// Only a deliberate scroll to the (spacer-inflated) very bottom releases
		// the send-anchor — collapsing the blank space is what the reader wants
		// there. Programmatic anchor scrolls end far from the bottom, so they
		// never trip this.
		if (distanceFromBottomRef.current <= LIVE_EDGE_ENTER_PX) {
			setAnchoredTurnId(null);
		}
		hasUnseenContentRef.current = false;
		setHasUnseenContent(false);
		setShowJumpButton(false);
	};

	const jumpToLatest = () => {
		if (turns.length === 0) return;
		pendingSendAnchorRef.current = false;
		pendingJumpToEndRef.current = true;
		setAnchoredTurnId(null);
		scrollModeRef.current = nextThreadScrollMode(scrollModeRef.current, {
			type: "jumped-to-latest",
		});
		// If no anchor spacer is active, no content-size event will follow.
		// Otherwise the committed spacer collapse will flush this pending jump.
		if (!anchorActive) requestAnimationFrame(flushPendingProgrammaticScroll);
		hasUnseenContentRef.current = false;
		setHasUnseenContent(false);
		setShowJumpButton(false);
	};
	const onMessageSubmitted = () => {
		scrollModeRef.current = nextThreadScrollMode(scrollModeRef.current, {
			type: "message-submitted",
		});
		hasUnseenContentRef.current = false;
		setHasUnseenContent(false);
		setShowJumpButton(false);
		pendingInitialEndRef.current = false;
		pendingJumpToEndRef.current = false;
		sendAnchorBaselineRef.current = latestTurnId;
		pendingSendAnchorRef.current = true;
	};
	const onComposerFocusChange = (_focused: boolean) => undefined;

	const jumpStyle = useAnimatedStyle(() => ({
		opacity: jumpOpacity.value,
		transform: [{ translateY: -keyboard.height.value }],
	}));
	const gradientStyle = useAnimatedStyle(() => ({
		transform: [{ translateY: -keyboard.height.value }],
	}));
	const accessoryStyle = useAnimatedStyle(() => ({
		transform: [{ translateY: -keyboard.height.value }],
	}));
	const onBottomAccessoryLayout = (event: LayoutChangeEvent) => {
		const nextHeight = event.nativeEvent.layout.height;
		setBottomAccessoryHeight((current) =>
			Math.abs(current - nextHeight) < 1 ? current : nextHeight,
		);
	};
	const effectiveBottomInset = transcriptBottomInset(
		bottomAccessoryHeight,
		keyboardOverlap,
	);
	// While the send-anchor is active, reserve exactly one anchored viewport
	// below the transcript so the anchored turn can hold its position at the
	// top no matter how tall it or the streaming reply becomes. Deliberately
	// independent of any turn-height measurement.
	const anchorActive =
		anchoredTurnId !== null && anchoredTurnId === latestTurnId;
	const transcriptFooterHeight =
		effectiveBottomInset +
		(anchorActive
			? sendAnchorSpace({
					viewportHeight: listViewportHeight,
					headerOffset: headerHeight + 12,
					bottomInset: effectiveBottomInset,
				})
			: 0);
	const flushPendingProgrammaticScroll = () => {
		const command = pendingThreadScrollCommand({
			pendingJumpToEnd: pendingJumpToEndRef.current,
			pendingSendAnchor: pendingSendAnchorRef.current,
			anchorActive,
		});
		if (command === "jump-end") {
			pendingJumpToEndRef.current = false;
			listRef.current?.scrollToEnd({ animated: true });
			return;
		}
		if (command === "send-anchor" && turns.length > 0) {
			pendingSendAnchorRef.current = false;
			listRef.current?.scrollToIndex({
				index: turns.length - 1,
				viewPosition: 0,
				viewOffset: headerHeight + 12,
				animated: true,
			});
		}
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
				bottomInset={insets.bottom}
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
			<FlatList
				ref={listRef}
				data={turns}
				keyExtractor={(turn) => turn.id}
				renderItem={({ item, index }) => (
					<TurnRow
						turn={item}
						context={ctx}
						live={sessionStatus === "running" && index === turns.length - 1}
					/>
				)}
				contentInsetAdjustmentBehavior="never"
				contentContainerClassName="gap-1 px-4"
				contentContainerStyle={{ paddingTop: headerHeight + 12 }}
				scrollIndicatorInsets={{
					top: headerHeight,
					bottom: effectiveBottomInset,
				}}
				keyboardDismissMode="interactive"
				keyboardShouldPersistTaps="handled"
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
								<Text selectable className="font-sans text-[13px] text-danger">
									{error}
								</Text>
							) : null}
						</View>
					) : null
				}
				ListFooterComponent={
					<View>
						<View className="pt-1">
							{workingActive ? <WorkingIndicator since={workingSince} /> : null}
						</View>
						<View style={{ height: transcriptFooterHeight }} />
					</View>
				}
				onScroll={onScroll}
				onScrollBeginDrag={detachReader}
				onScrollEndDrag={resumeAtLiveEdge}
				onMomentumScrollEnd={resumeAtLiveEdge}
				onTouchStart={detachReader}
				scrollEventThrottle={32}
				onScrollToIndexFailed={(info) => {
					// Graceful degradation when the target row is far outside the
					// render window (e.g. sending while detached far above): land
					// close with an estimated offset, then pin exactly next frame.
					listRef.current?.scrollToOffset({
						offset: info.averageItemLength * info.index,
						animated: false,
					});
					requestAnimationFrame(() => {
						listRef.current?.scrollToIndex({
							index: info.index,
							viewPosition: 0,
							viewOffset: headerHeight + 12,
							animated: false,
						});
					});
				}}
				onContentSizeChange={() => {
					if (restoreDetachedPosition()) return;
					attemptInitialEnd();
					prepareSendAnchor();
					flushPendingProgrammaticScroll();
				}}
				onLayout={(event) => {
					const nextHeight = event.nativeEvent.layout.height;
					setListViewportHeight((current) =>
						Math.abs(current - nextHeight) < 1 ? current : nextHeight,
					);
					if (restoreDetachedPosition()) return;
					attemptInitialEnd();
				}}
			/>
			<View pointerEvents="box-none" style={{ position: "absolute", inset: 0 }}>
				{showJumpButton ? (
					<Animated.View
						pointerEvents="box-none"
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
							onPress={jumpToLatest}
						>
							<GlassSurface
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
				) : null}
				<Animated.View
					pointerEvents="none"
					style={[
						gradientStyle,
						{
							position: "absolute",
							left: 0,
							right: 0,
							bottom: 0,
							height: bottomAccessoryHeight + 40,
							experimental_backgroundImage:
								theme === "dark"
									? "linear-gradient(to bottom, rgba(15,15,15,0) 0%, rgba(15,15,15,0.72) 55%, rgb(15,15,15) 100%)"
									: "linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.72) 55%, rgb(255,255,255) 100%)",
						},
					]}
				/>
				<Animated.View
					onLayout={onBottomAccessoryLayout}
					pointerEvents="box-none"
					style={[
						accessoryStyle,
						{
							position: "absolute",
							left: 0,
							right: 0,
							bottom: 0,
						},
					]}
				>
					{options === null ? null : bottomState.blocking?.kind ===
						"permission" ? (
						renderPermissionAccessory(bottomState.blocking.requests)
					) : bottomState.blocking?.kind === "question" ? (
						<View
							className="px-3 pt-2"
							style={{
								paddingBottom: insets.bottom > 0 ? insets.bottom : 12,
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
							bottomInset={insets.bottom}
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
							{detail !== null && sessionStatus !== "running" ? (
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
								onMessageSubmitted={onMessageSubmitted}
								currentActivity={composerActivity}
								bottomInset={insets.bottom}
							/>
						</View>
					)}
				</Animated.View>
			</View>
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
