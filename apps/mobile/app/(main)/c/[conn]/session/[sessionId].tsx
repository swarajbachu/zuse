import { useAtomValue } from "@effect/atom-react";
import {
	KeyboardAwareLegendList,
	useKeyboardChatComposerInset,
	useKeyboardScrollToEnd,
} from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { orderedChatSessions } from "@zuse/client-runtime/chat-threads";
import { isWaitingCloudSend } from "@zuse/client-runtime/cloud-send-delivery";
import {
	findPendingPlanInteraction,
	isPlanApprovalRequest,
	nativePlanRecoveryState,
} from "@zuse/client-runtime/plan-interactions";
import { groupTimelineTurns } from "@zuse/client-runtime/timeline";
import {
	AgentItemId,
	type FolderId,
	type MessageId,
	type PermissionRequest,
	providerLabel,
	type SessionId,
	type UserQuestion,
} from "@zuse/contracts";
import { PLAN_APPROVAL_PROMPT } from "@zuse/utils/proposed-plan";
import { Effect } from "effect";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ChevronDown } from "lucide-react-native";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
	AccessibilityInfo,
	ActivityIndicator,
	Alert,
	type HostInstance,
	type LayoutChangeEvent,
	type NativeScrollEvent,
	type NativeSyntheticEvent,
	Platform,
	Pressable,
	Text,
	View,
} from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, {
	useReducedMotion,
	useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUniwind } from "uniwind";
import { CloudChatStatus } from "~/components/cloud-chat-status";
import { CloudDeviceAccess } from "~/components/cloud-device-access";
import { CloudLifecycleBar } from "~/components/cloud-lifecycle-bar";
import { Composer } from "~/components/composer";
import { ConnectionRecoveryBanner } from "~/components/connection-recovery-banner";
import { InlineErrorNotice } from "~/components/inline-error-notice";
import { MessageHistoryStatus } from "~/components/message-history-status";
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
import { UndeliveredMessage } from "~/components/undelivered-message";
import { useTranscriptScrollCoordinator } from "~/hooks/use-transcript-scroll-coordinator";
import {
	coordinateChatBottomState,
	selectPendingQuestion,
} from "~/lib/chat-bottom-state";
import { cloudLifecycle } from "~/lib/cloud-lifecycle";
import { isFreshChat, summarizeComposerActivity } from "~/lib/composer-state";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import { connectionNotice } from "~/lib/connection-notice";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { connectionSupports } from "~/lib/connection-records";
import { captureMobileError } from "~/lib/crash-reporting";
import { visibleConnectionLabel } from "~/lib/display-names";
import { useReadableInset } from "~/lib/form-factor";
import { scrollListToLatest } from "~/lib/legend-list-scroll";
import { buildToolResultsByItemId } from "~/lib/message-presentation";
import { sanitizeMessages } from "~/lib/message-safety";
import { useHeaderContentInset } from "~/lib/native-header";
import { mobileReleaseFeatures } from "~/lib/release-features";
import { connectionSessionKey } from "~/lib/session-key";
import { promptText } from "~/lib/text-prompt";
import { transcriptEndRunwayHeight } from "~/lib/thread-runway";
import { shouldRestoreThreadPosition } from "~/lib/thread-switching";
import {
	readThreadViewState,
	writeThreadViewState,
} from "~/lib/thread-view-state";
import {
	answerQuestion,
	cancelQuestion,
	createWorktree,
	forkSessionFromMessage,
	getWorktree,
	makeTextInput,
	mergeSessionBack,
	openSessionOnHost,
	renameWorktreeBranch,
	respondToPlan,
	sendMessage,
} from "~/rpc/actions";
import { cloudRuntimeReady } from "~/rpc/cloud-runtime";
import { getConnectionClient } from "~/rpc/connection";
import { cloudCatalogAtom } from "~/store/cloud-catalog";
import {
	connectionSnapshotAtom,
	retryConnection,
	watchConnection,
} from "~/store/connection-runtime";
import {
	allConnectionsAtom as connectionsAtom,
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
	refreshMessages,
	releaseMessages,
	reorderQueuedMessages,
	resumeQueue,
	runQueuedMessageNext,
	sessionDeliveryAtom,
	sessionExecutionStepsAtom,
	sessionHealthAtom,
	sessionInteractionsAtom,
	sessionMessagesAtom,
	sessionMessagesErrorAtom,
	sessionQueueAtom,
	sessionQueuePausedAtom,
	sessionTranscriptReadyAtom,
	updateQueuedMessage,
} from "~/store/messages";
import {
	cancelOutboxMessage,
	hydrateOutbox,
	queuedMessagesAtom,
	submitOutboxDrafts,
	updateOutboxMessage,
} from "~/store/outbox";
import {
	decidePermission,
	pendingPermissionsAtom,
	retainPermissionConnection,
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
	prepareSessionWorkspace,
	renameChat,
	renameSession,
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
	// Full-bleed screen: the readable column is applied to the list and composer.
	const readableInset = useReadableInset();
	const headerHeight = useHeaderContentInset();
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
	const composerOverlayRef = useRef<HostInstance>(null);
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
	const connectionRecord = connections.find(
		(connection) => connection.key === connKey,
	);
	const stateKey = connectionSessionKey(connKey, normalizedSessionId);
	const turnActivity = useAtomValue(sessionTurnActivityAtom(stateKey));
	const [restoredViewState] = useState(() =>
		restoreThreadPosition ? readThreadViewState(stateKey) : null,
	);
	const connectionSnapshot = useAtomValue(connectionSnapshotAtom(connKey));
	const bundles = useAtomValue(connectionBundlesAtom(connKey));
	const rawMessages = useAtomValue(sessionMessagesAtom(stateKey));
	const interactions = useAtomValue(sessionInteractionsAtom(stateKey));
	const executionHealth = useAtomValue(sessionHealthAtom(stateKey));
	const executionSteps = useAtomValue(sessionExecutionStepsAtom(stateKey));
	const transcriptReady = useAtomValue(sessionTranscriptReadyAtom(stateKey));
	const [transcriptTimedOut, setTranscriptTimedOut] = useState(false);
	const [transcriptAttempt, setTranscriptAttempt] = useState(0);
	const initialTranscriptLoading = !transcriptReady && rawMessages.length === 0;
	const cloudCatalogState = useAtomValue(cloudCatalogAtom);
	const cloudLifecycleState =
		options?.cloudWorkspaceId === undefined
			? null
			: cloudLifecycle(
					cloudCatalogState.chats.find(
						(row) => row.workspaceId === options.cloudWorkspaceId,
					),
				);
	const messagesError = useAtomValue(sessionMessagesErrorAtom(stateKey));
	const serverQueued = useAtomValue(sessionQueueAtom(stateKey));
	const serverQueuePaused = useAtomValue(sessionQueuePausedAtom(stateKey));
	const messages = useMemo(() => sanitizeMessages(rawMessages), [rawMessages]);
	const turns = useMemo(() => groupTimelineTurns(messages), [messages]);

	const anchoredFirstTurnFor = useRef<string | null>(null);

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
				closeKeyboard: true,
			}),
		scrollToLatest: () => {
			const list = listRef.current;
			return list === null
				? Promise.reject(new Error("Transcript list is not mounted."))
				: scrollListToLatest(list, { animated: !reduceMotion });
		},
	});
	const settleTranscriptTurn = transcriptScroll.onTurnSettled;
	const readReaderDetached = transcriptScroll.isReaderDetached;
	const detail = selectSessionChat(bundles, normalizedSessionId);
	const chatId = detail?.session.chatId ?? null;
	const allConnectionSessions = useMemo(
		() => bundles.flatMap((bundle) => bundle.sessions),
		[bundles],
	);

	const chatThreads =
		chatId === null
			? detail === null
				? []
				: [detail.session]
			: orderedChatSessions(allConnectionSessions, chatId);
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
	}, [connKey, normalizedSessionId, options]);

	useEffect(() => {
		void stateKey;
		void transcriptAttempt;
		setTranscriptTimedOut(false);
		if (!initialTranscriptLoading) return;
		const timer = setTimeout(() => setTranscriptTimedOut(true), 30_000);
		return () => clearTimeout(timer);
	}, [stateKey, transcriptAttempt, initialTranscriptLoading]);

	const observedConnectionGenerationRef = useRef<number | null>(null);
	useEffect(() => {
		const generation = connectionSnapshot?.generation;
		if (generation === undefined) return;
		const previous = observedConnectionGenerationRef.current;
		observedConnectionGenerationRef.current = generation;
		if (
			previous === null ||
			previous === generation ||
			normalizedSessionId.length === 0 ||
			options === null
		) {
			return;
		}

		void refreshMessages(connKey, options, normalizedSessionId);
	}, [connKey, connectionSnapshot?.generation, normalizedSessionId, options]);

	useEffect(() => {
		if (options === null) return;
		return retainPermissionConnection(connKey, options);
	}, [connKey, options]);

	const pinnedHydrated = useAtomValue(pinnedChatsHydratedAtom);
	const currentPinKey =
		chatId === null ? null : pinnedChatKey(connKey, String(chatId));
	const isPinned = useAtomValue(isPinnedAtom(currentPinKey ?? ""));
	useEffect(() => {
		if (!pinnedHydrated) void hydratePinnedChats();
	}, [pinnedHydrated]);

	useEffect(() => {
		if (chatId === null || options === null) return;
		if (
			options.cloudWorkspaceId !== undefined &&
			!cloudRuntimeReady(options.cloudWorkspaceId)
		)
			return;
		void markChatRead(connKey, options, chatId);
	}, [chatId, connKey, options]);

	const error = messagesError;
	const transportOnline = connectionSnapshot?.status === "connected";
	const transportNotice =
		options?.cloudWorkspaceId !== undefined
			? null
			: connectionNotice(
					connectionSnapshot,
					visibleConnectionLabel(connectionRecord?.label),
				);

	useEffect(() => {
		if (
			!transportOnline ||
			normalizedSessionId.length === 0 ||
			options === null ||
			queuedCount === 0
		) {
			return;
		}
		void submitOutboxDrafts(connKey, options, normalizedSessionId);
	}, [connKey, normalizedSessionId, transportOnline, options, queuedCount]);

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
	const planRecovery = nativePlanRecoveryState(messages, interactions);
	const pendingPlanInteraction =
		detail === null
			? null
			: findPendingPlanInteraction({
					interactions,
					messages,
					requests: pending,
					sessionId: normalizedSessionId,
					providerId: detail.session.providerId,
					permissionMode: detail.session.permissionMode,
					isRunning: sessionActive,
				});
	const headPermission = permissionRequests[0] ?? null;
	const pendingQuestion = selectPendingQuestion(interactions);
	const bottomState = coordinateChatBottomState({
		permissions: permissionRequests,
		question: pendingQuestion,
		planReview: pendingPlanInteraction,
		goal,
		serverQueueCount: serverQueued.length,
		localQueueCount: unackedLocalQueued.length,
		queuePaused: serverQueuePaused,
	});

	const workingActive =
		sessionActive &&
		cloudLifecycleState === null &&
		headPermission === null &&
		(pendingQuestion === null || pendingQuestion.expired === true) &&
		pendingPlanInteraction === null;
	const workingSince = turns.at(-1)?.startedAt.getTime() ?? screenOpenedAt;

	const delivery = useAtomValue(sessionDeliveryAtom(stateKey));
	const cloudSendWaiting =
		options?.cloudWorkspaceId !== undefined &&
		cloudLifecycleState === null &&
		delivery.pending.some(isWaitingCloudSend);
	const agentName =
		detail?.session.providerId === undefined
			? "Agent"
			: providerLabel(detail.session.providerId);
	const workingLabel = cloudSendWaiting
		? `Waiting for ${agentName}`
		: `${agentName} is working`;

	const attachedFor = useRef<string | null>(null);
	useEffect(() => {
		if (
			!cloudSendWaiting ||
			options === null ||
			attachedFor.current === stateKey
		)
			return;
		attachedFor.current = stateKey;
		void Effect.runPromise(getConnectionClient(options, true)).catch(
			() => undefined,
		);
	}, [cloudSendWaiting, options, stateKey]);

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
						itemId: AgentItemId.make(itemId),
						answers,
					}),
				);

	const onCancelQuestion = (itemId: string) =>
		options === null
			? Promise.resolve()
			: Effect.runPromise(
					cancelQuestion({
						connection: options,
						sessionId: normalizedSessionId,
						itemId: AgentItemId.make(itemId),
					}),
				);

	const mergeRequest = useRef<{
		sessionId: SessionId;
		commandId: string;
		busy: boolean;
	} | null>(null);
	const onMergeBack = async () => {
		if (options === null || detail?.session.forkedFromSessionId == null) return;
		if (mergeRequest.current?.sessionId !== normalizedSessionId)
			mergeRequest.current = {
				sessionId: normalizedSessionId,
				commandId: `merge-back:${crypto.randomUUID()}`,
				busy: false,
			};
		const request = mergeRequest.current;
		if (request.busy) return;
		request.busy = true;
		try {
			await Effect.runPromise(
				mergeSessionBack({
					connection: options,
					sessionId: request.sessionId,
					commandId: request.commandId,
				}),
			);
			if (mergeRequest.current === request) mergeRequest.current = null;
			Alert.alert(
				"Context merged",
				"The parent conversation will receive this context on its next turn.",
			);
		} catch (cause) {
			Alert.alert("Could not merge context", connectionErrorMessage(cause));
		} finally {
			request.busy = false;
		}
	};

	const forkPending = useRef(false);
	const runFork = async (
		fromMessageId: MessageId,
		destination: "tab" | "chat",
		isolated: boolean,
		nativeChildStepId?: string,
	) => {
		if (detail === null || options === null || forkPending.current) return;
		forkPending.current = true;
		try {
			const detail = await prepareSessionWorkspace(
				connKey,
				options,
				normalizedSessionId,
			);
			const worktreeId =
				destination === "chat" && isolated
					? (
							await Effect.runPromise(
								createWorktree({
									connection: options,
									projectId: detail.project.id,
								}),
							)
						).id
					: detail.session.worktreeId;
			const result = await Effect.runPromise(
				forkSessionFromMessage({
					connection: options,
					sourceSessionId: normalizedSessionId,
					fromMessageId,
					nativeChildStepId,
					destination,
					worktreeId,
				}),
			);
			Alert.alert(
				"Fork created",
				result.forkMode === "resume"
					? "The provider resumed the conversation with its native context."
					: "The visible transcript was copied into the new session.",
				[
					{
						text: "Open",
						onPress: () =>
							router.push({
								pathname: "/c/[conn]/session/[sessionId]",
								params: {
									conn: connKey,
									sessionId: result.session.id,
								},
							}),
					},
				],
			);
		} catch (cause) {
			Alert.alert("Could not create fork", connectionErrorMessage(cause));
		} finally {
			forkPending.current = false;
		}
	};

	const onForkFromMessage: NonNullable<
		MessageRowContext["onForkFromMessage"]
	> = (fromMessageId, destination, isolated) => {
		void runFork(fromMessageId, destination, isolated);
	};

	const ctx: MessageRowContext = {
		lastAssistantMessageId: messages.findLast(
			(message) => message.content._tag === "assistant",
		)?.id,
		connectionKey: connKey,
		...(options === null ? {} : { connection: options }),
		sessionId: normalizedSessionId,
		workspaceRoot: detail?.project.path,
		answeredQuestionIds,
		questionsByItemId,
		toolResultsByItemId,
		sessionRunning: sessionActive,
		executionSteps,
		onAnswerQuestion,
		onForkFromMessage,
		onForkNativeChild: (messageId, stepId) => {
			void runFork(messageId, "tab", false, stepId);
		},
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
		hasUnseenContentRef.current = false;
		setHasUnseenContent(false);
		transcriptScroll.requestJump();
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
	useEffect(() => {
		if (anchoredFirstTurnFor.current === stateKey) return;
		const only = turns.length === 1 ? turns[0] : undefined;
		if (
			only === undefined ||
			only.user === null ||
			only.body.length > 0 ||
			transcriptScroll.anchorIndex !== null
		)
			return;
		anchoredFirstTurnFor.current = stateKey;
		transcriptScroll.onMessageWillAppend(0);
	}, [stateKey, transcriptScroll, turns]);
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
	const onBottomAccessoryLayout = (event: LayoutChangeEvent) => {
		const nextHeight = event.nativeEvent.layout.height;
		setBottomAccessoryHeight((current) =>
			Math.abs(current - nextHeight) < 1 ? current : nextHeight,
		);
		onComposerLayout(event);
	};
	const endRunwayHeight = transcriptEndRunwayHeight();
	const anchoredEndSpace =
		transcriptScroll.anchorIndex === null
			? undefined
			: {
					anchorIndex: transcriptScroll.anchorIndex,
					anchorOffset: headerHeight + 12,
					onReady: transcriptScroll.onAnchorReady,
				};

	const onRenameChat = () => {
		if (chatId === null || options === null) return;
		promptText({
			title: "Rename chat",
			defaultValue: title,
			placeholder: "Chat name",
			confirmLabel: "Rename",
			onSubmit: (value) => {
				const next = value.trim();
				if (next.length === 0) return;
				void renameChat(connKey, options, chatId, next).catch((cause) =>
					Alert.alert("Could not rename chat", connectionErrorMessage(cause)),
				);
			},
		});
	};
	const onRenameSession = () => {
		if (detail === null || options === null) return;
		promptText({
			title: "Rename session",
			defaultValue: detail.session.title,
			placeholder: "Session name",
			confirmLabel: "Rename",
			onSubmit: (value) => {
				const next = value.trim();
				if (next.length === 0) return;
				void renameSession(connKey, options, detail.session.id, next).catch(
					(cause) =>
						Alert.alert(
							"Could not rename session",
							connectionErrorMessage(cause),
						),
				);
			},
		});
	};
	const onRenameBranch = () => {
		const worktreeId = detail?.session.worktreeId;
		if (worktreeId == null || options === null) return;
		void Effect.runPromise(getWorktree({ connection: options, worktreeId }))
			.then((worktree) => {
				if (worktree === null) {
					Alert.alert(
						"Could not rename branch",
						"The worktree no longer exists.",
					);
					return;
				}
				promptText({
					title: "Rename branch",
					defaultValue: worktree.branch,
					placeholder: "Branch name",
					confirmLabel: "Rename",
					onSubmit: (value) => {
						const next = value.trim();
						if (next.length === 0 || next === worktree.branch) return;
						void Effect.runPromise(
							renameWorktreeBranch({
								connection: options,
								worktreeId,
								name: next,
							}),
						).catch((cause) =>
							Alert.alert(
								"Could not rename branch",
								connectionErrorMessage(cause),
							),
						);
					},
				});
			})
			.catch((cause) =>
				Alert.alert("Could not rename branch", connectionErrorMessage(cause)),
			);
	};

	const onArchive = () => {
		if (chatId === null || options === null) return;
		void archiveChat(connKey, options, chatId).then(() => router.back());
	};
	const withWorkspace = async (
		action: (
			current: NonNullable<ReturnType<typeof selectSessionChat>>,
		) => void | Promise<void>,
	) => {
		if (options === null) return;
		try {
			await action(
				await prepareSessionWorkspace(connKey, options, normalizedSessionId),
			);
		} catch (cause) {
			Alert.alert("Cloud workspace", connectionErrorMessage(cause));
		}
	};
	const onOpenTerminal = () =>
		withWorkspace(async (detail) => {
			if (detail === null || options === null) return;
			let cwd = detail.project.path;
			const worktreeId = detail.session.worktreeId;
			if (worktreeId !== null) {
				try {
					const worktree = await Effect.runPromise(
						getWorktree({ connection: options, worktreeId }),
					);
					if (worktree !== null) cwd = worktree.path;
				} catch (cause) {
					Alert.alert("Could not open terminal", connectionErrorMessage(cause));
					return;
				}
			}
			router.push({
				pathname: "/c/[conn]/session/[sessionId]/terminal",
				params: {
					conn: connKey,
					sessionId: normalizedSessionId,
					cwd,
					label: title,
				},
			});
		});
	const openChanges = () =>
		withWorkspace(() => {
			router.push({
				pathname: "/c/[conn]/session/[sessionId]/review",
				params: { conn: connKey, sessionId: normalizedSessionId },
			});
		});
	const openOnDesktop = () => {
		if (options === null) return;
		void Effect.runPromise(
			openSessionOnHost({
				connection: options,
				sessionId: normalizedSessionId,
			}),
		).catch((cause) =>
			Alert.alert("Could not open on desktop", connectionErrorMessage(cause)),
		);
	};
	const openFiles = () =>
		withWorkspace(() => {
			router.push({
				pathname: "/c/[conn]/session/[sessionId]/files",
				params: { conn: connKey, sessionId: normalizedSessionId },
			});
		});
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
							onRenameChat={chatId === null ? undefined : onRenameChat}
							onRenameSession={detail === null ? undefined : onRenameSession}
							onRenameBranch={
								detail?.session.worktreeId == null ? undefined : onRenameBranch
							}
							onThreads={openThreads}
							onChanges={openChanges}
							onFiles={openFiles}
							onCheckpoints={() =>
								router.push({
									pathname: "/c/[conn]/session/[sessionId]/checkpoints",
									params: { conn: connKey, sessionId: normalizedSessionId },
								})
							}
							onAttempts={() =>
								router.push({
									pathname: "/c/[conn]/session/[sessionId]/attempts",
									params: { conn: connKey, sessionId: normalizedSessionId },
								})
							}
							onTerminal={
								mobileReleaseFeatures.terminal &&
								(options?.cloudWorkspaceId !== undefined ||
									connectionSupports(connectionRecord, "mobile-terminal-v1"))
									? () => void onOpenTerminal()
									: undefined
							}
							onOpenOnDesktop={
								connectionSupports(connectionRecord, "desktop-handoff-v1")
									? openOnDesktop
									: undefined
							}
							onMergeBack={
								detail?.session.forkedFromSessionId == null
									? undefined
									: () => void onMergeBack()
							}
							onArchive={onArchive}
						/>
					),
				}}
			/>
			{hydrated && options === null ? (
				<View className="px-4 py-3">
					<Text selectable className="font-sans text-[13px] text-danger">
						{connKey.startsWith("cloud:")
							? "Loading this chat from your cloud account. If it was archived or deleted, return to your chat list."
							: "This saved connection could not be found on this phone. Go back and connect the computer again."}
					</Text>
				</View>
			) : null}
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
					paddingHorizontal: 16 + readableInset,
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
					transcriptScroll.readerDetached ||
					transcriptScroll.anchorIndex !== null
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
				drawDistance={800}
				sharedValues={{ isNearEnd }}
				ListHeaderComponent={
					<View>
						<MessageHistoryStatus
							connKey={connKey}
							sessionId={normalizedSessionId}
						/>
						{options?.cloudWorkspaceId !== undefined ? (
							<CloudChatStatus
								workspaceId={options.cloudWorkspaceId}
								connKey={connKey}
								sessionId={normalizedSessionId}
								messages={messages}
								error={error}
							/>
						) : error && transportNotice === null ? (
							<InlineErrorNotice
								message={connectionErrorMessage(error)}
								compact
							/>
						) : null}
					</View>
				}
				ListFooterComponent={
					<View style={{ minHeight: endRunwayHeight, paddingTop: 4 }}>
						{options === null ? null : (
							<UndeliveredMessage
								stateKey={stateKey}
								connection={options}
								sessionId={normalizedSessionId}
								messages={messages}
							/>
						)}
						{options?.cloudWorkspaceId && (
							<CloudDeviceAccess workspaceId={options.cloudWorkspaceId} />
						)}
						{workingActive || cloudSendWaiting ? (
							<WorkingIndicator since={workingSince} label={workingLabel} />
						) : null}
					</View>
				}
				onScroll={onScroll}
				onScrollBeginDrag={startReaderGesture}
				onScrollEndDrag={finishReaderGesture}
				onMomentumScrollBegin={startReaderGesture}
				onMomentumScrollEnd={finishReaderGesture}
				onEndVisible={onEndVisible}
				scrollEventThrottle={16}
			/>
			{initialTranscriptLoading &&
			turns.length === 0 &&
			cloudLifecycleState === null ? (
				<View
					pointerEvents="box-none"
					style={{
						position: "absolute",
						top: headerHeight,
						left: 16,
						right: 16,
						bottom: bottomAccessoryHeight,
						justifyContent: "center",
					}}
				>
					{transcriptTimedOut || messagesError !== null ? (
						<View className="items-center gap-3 px-4">
							<Text className="font-sans text-sm text-muted-foreground">
								Couldn’t load this conversation.
							</Text>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Retry loading conversation"
								className="min-h-11 justify-center px-4"
								onPress={() => {
									if (options === null) return;
									setTranscriptTimedOut(false);
									setTranscriptAttempt((attempt) => attempt + 1);
									retryConnection(connKey, options);
									void refreshMessages(connKey, options, normalizedSessionId);
								}}
							>
								<Text className="font-sans-medium text-sm text-accent">
									Try again
								</Text>
							</Pressable>
						</View>
					) : (
						<TranscriptLoadingState />
					)}
				</View>
			) : null}
			<KeyboardStickyView
				pointerEvents="box-none"
				style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
				offset={{ closed: 0, opened: insets.bottom }}
			>
				<Animated.View
					pointerEvents={jumpAccessible ? "box-none" : "none"}
					accessibilityElementsHidden={!jumpAccessible}
					importantForAccessibility={
						jumpAccessible ? "auto" : "no-hide-descendants"
					}
					style={[
						{
							position: "absolute",
							left: 0,
							right: 0,
							bottom: bottomAccessoryHeight + 8,
							alignItems: "center",
							opacity: jumpAccessible ? 1 : 0,
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

						height: bottomAccessoryHeight + 16,
						experimental_backgroundImage:
							theme === "dark"
								? "linear-gradient(to bottom, rgba(15,15,15,0) 0%, rgba(15,15,15,0.45) 60%, rgba(15,15,15,0.85) 100%)"
								: Platform.OS === "ios"
									? "linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.45) 60%, rgba(255,255,255,0.85) 100%)"
									: // Fade into the page color so the dock has no edges on wide screens.
										"linear-gradient(to bottom, rgba(247,247,245,0) 0%, rgba(247,247,245,0.45) 60%, rgba(247,247,245,0.85) 100%)",
					}}
				/>
				<View
					ref={composerOverlayRef}
					onLayout={onBottomAccessoryLayout}
					pointerEvents="box-none"
					style={{ marginHorizontal: readableInset }}
				>
					{executionHealth === "unavailable" ? (
						<Text
							accessibilityRole="alert"
							className="px-3 py-2 text-xs text-muted-foreground"
						>
							Execution ownership could not be confirmed. Waiting for recovery.
						</Text>
					) : null}
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
								expired={bottomState.blocking.question.expired}
								onSubmit={onAnswerQuestion}
								onCancel={onCancelQuestion}
							/>
						</View>
					) : bottomState.planReview !== null ? (
						<PlanReviewCard
							interaction={bottomState.planReview}
							bottomInset={composerBottomInset}
							onAction={runPlanAction}
						/>
					) : planRecovery !== null ? (
						<Text className="px-3 py-2 text-xs text-muted-foreground">
							{planRecovery === "uncertain"
								? "Plan delivery could not be confirmed. Review the conversation before starting another turn."
								: "This plan request has expired. Send a new message to continue."}
						</Text>
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
							{options.cloudWorkspaceId === undefined ? null : (
								<CloudLifecycleBar workspaceId={options.cloudWorkspaceId} />
							)}
							{cloudLifecycleState !== null ? null : (
								<ConnectionRecoveryBanner
									notice={transportNotice}
									onRetry={() => retryConnection(connKey, options)}
									onPairAgain={() => router.push("/connect/scan")}
									className="mx-3 mt-2"
								/>
							)}
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
									runQueuedMessageNext(
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
								status={cloudLifecycleState === null ? sessionStatus : "idle"}
								fresh={fresh}
								online={
									options.cloudWorkspaceId !== undefined || transportOnline
								}
								onMessageAppendFailed={onMessageAppendFailed}
								onMessageWillAppend={onMessageWillAppend}
								onFocusChange={(focused) => {
									if (
										!focused ||
										transcriptScroll.readerDetached ||
										listRef.current === null
									) {
										return;
									}
									requestAnimationFrame(() => {
										const list = listRef.current;
										if (list !== null) {
											void scrollListToLatest(list, {
												animated: !reduceMotion,
											});
										}
									});
								}}
								currentActivity={
									turnActivity === "running" ? composerActivity : null
								}
								bottomInset={composerBottomInset}
								voiceEnabled={connectionSupports(
									connectionRecord,
									"voice-account-transcription-v1",
								)}
							/>
						</View>
					)}
				</View>
			</KeyboardStickyView>
		</View>
	);
}

function TranscriptLoadingState() {
	return (
		<View
			accessibilityRole="progressbar"
			accessibilityLabel="Loading conversation"
			className="items-center justify-center gap-3 px-1 pt-10"
		>
			<ActivityIndicator size="small" color={colors.accent} />
			<Text className="font-sans-medium text-[13px] text-muted-foreground">
				Loading conversation…
			</Text>
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
