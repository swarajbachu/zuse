import { groupTimelineTurns } from "@zuse/client-runtime/timeline";
import type {
	PermissionRequest,
	SessionId,
	UserQuestion,
} from "@zuse/contracts";
import { Effect } from "effect";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ChevronDown, ChevronLeft, Files, Plus } from "lucide-react-native";
import React, {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Alert,
	FlatList,
	KeyboardAvoidingView,
	type LayoutChangeEvent,
	type NativeScrollEvent,
	type NativeSyntheticEvent,
	Pressable,
	Text,
	View,
} from "react-native";
import Animated, {
	useAnimatedStyle,
	useSharedValue,
	withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUniwind } from "uniwind";

import { Composer } from "~/components/composer";
import { LivePermissionAccessory } from "~/components/messages/live-permission-accessory";
import type { MessageRowContext } from "~/components/messages/message-row";
import { PendingUserInputCard } from "~/components/messages/pending-user-input-card";
import { TurnRow } from "~/components/messages/turn-row";
import { SessionActionsMenu } from "~/components/session-actions-menu";
import { GlassSurface } from "~/components/ui/glass-surface";
import { WorkingIndicator } from "~/components/ui/working-indicator";
import { isFreshChat } from "~/lib/composer-state";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { captureMobileError } from "~/lib/crash-reporting";
import { visibleConnectionLabel } from "~/lib/display-names";
import { buildToolResultsByItemId } from "~/lib/message-presentation";
import { sanitizeMessages } from "~/lib/message-safety";
import { connectionSessionKey } from "~/lib/session-key";
import { selectSessionMessages } from "~/lib/session-messages";
import {
	answerQuestion,
	flushServerQueue,
	makeTextInput,
	queueMessage,
} from "~/rpc/actions";
import { useConnectionRuntimeStore } from "~/store/connection-runtime";
import { useConnectionsStore } from "~/store/connections";
import { useMobileMessagesStore } from "~/store/messages";
import { useOutboxStore } from "~/store/outbox";
import { usePermissionsStore } from "~/store/permissions";
import { selectSessionChat, useSessionsStore } from "~/store/sessions";
import { colors } from "~/theme";

const EMPTY_BUNDLES: ReturnType<
	typeof useSessionsStore.getState
>["bundlesByConnection"][string] = [];
const EMPTY_PENDING: ReturnType<
	typeof usePermissionsStore.getState
>["pendingBySession"][string] = [];
const EMPTY_QUEUED: ReturnType<
	typeof useOutboxStore.getState
>["queuedBySession"][string] = [];
const EMPTY_SERVER_QUEUE: ReturnType<
	typeof useMobileMessagesStore.getState
>["queueBySession"][string] = [];

export default function ThreadScreenRoute() {
	return (
		<ThreadScreenBoundary>
			<ThreadScreen />
		</ThreadScreenBoundary>
	);
}

function ThreadScreen() {
	const insets = useSafeAreaInsets();
	const { theme } = useUniwind();
	const { conn, sessionId } = useLocalSearchParams<{
		conn: string;
		sessionId: string;
	}>();
	const connKey = normalizeConnParam(conn);
	const normalizedSessionId = normalizeConnParam(sessionId) as SessionId;
	const listRef = useRef<FlatList>(null);
	const didInitialScroll = useRef(false);
	const initialScrollQuietUntil = useRef(0);
	const atBottomRef = useRef(true);
	const [showJumpButton, setShowJumpButton] = useState(false);
	const [bottomAccessoryHeight, setBottomAccessoryHeight] = useState(
		Math.max(insets.bottom, 12) + 64,
	);
	const jumpOpacity = useSharedValue(0);
	const {
		connections,
		hydrated,
		hydrate: hydrateConnections,
	} = useConnectionsStore();
	const options = useMemo(
		() => optionsForConnection(connKey, connections),
		[connKey, connections],
	);
	const stateKey = connectionSessionKey(connKey, normalizedSessionId);
	const watchConnection = useConnectionRuntimeStore((state) => state.watch);
	const retryConnection = useConnectionRuntimeStore((state) => state.retry);
	const connectionSnapshot = useConnectionRuntimeStore(
		(state) => state.snapshotsByConnection[connKey],
	);
	const bundles = useSessionsStore(
		(state) => state.bundlesByConnection[connKey] ?? EMPTY_BUNDLES,
	);
	const archiveChat = useSessionsStore((state) => state.archiveChat);
	const archiveSession = useSessionsStore((state) => state.archiveSession);
	const renameChatAction = useSessionsStore((state) => state.renameChat);
	const markChatRead = useSessionsStore((state) => state.markChatRead);
	const createSession = useSessionsStore((state) => state.createSession);
	const machineLabel = useMemo(() => {
		const record = connections.find(
			(connection) =>
				connection.key === connKey || connection.environmentId === connKey,
		);
		return record?.label ?? visibleConnectionLabel(undefined, connKey);
	}, [connections, connKey]);
	const rawMessages = useMobileMessagesStore((state) =>
		selectSessionMessages(state.messagesBySession, stateKey),
	);
	const errorBySession = useMobileMessagesStore(
		(state) => state.errorBySession,
	);
	const serverQueued = useMobileMessagesStore(
		(state) => state.queueBySession[stateKey] ?? EMPTY_SERVER_QUEUE,
	);
	const deleteServerQueued = useMobileMessagesStore(
		(state) => state.deleteQueued,
	);
	const hydrate = useMobileMessagesStore((state) => state.hydrate);
	const messages = useMemo(() => sanitizeMessages(rawMessages), [rawMessages]);
	const turns = useMemo(() => groupTimelineTurns(messages), [messages]);
	const detail = selectSessionChat(bundles, normalizedSessionId);
	const title = detail?.chat?.title ?? detail?.session.title ?? "Thread";
	const sessionStatus =
		useSessionsStore((state) => state.statusBySession[stateKey]) ??
		detail?.session.status;
	const fresh = isFreshChat(messages);
	const sessionRunning = sessionStatus === "running";

	const hydratePermissions = usePermissionsStore((state) => state.hydrate);
	const decidePermission = usePermissionsStore((state) => state.decide);
	const pending = usePermissionsStore(
		(state) => state.pendingBySession[stateKey] ?? EMPTY_PENDING,
	);
	const hydrateOutbox = useOutboxStore((state) => state.hydrate);
	const flushOutbox = useOutboxStore((state) => state.flush);
	const cancelQueued = useOutboxStore((state) => state.cancel);
	const localQueued = useOutboxStore(
		(state) => state.queuedBySession[stateKey] ?? EMPTY_QUEUED,
	);
	const queuedCount = localQueued.length;
	const [screenOpenedAt] = useState(() => Date.now());

	useEffect(() => {
		if (!hydrated) void hydrateConnections();
	}, [hydrateConnections, hydrated]);

	useEffect(() => {
		if (connKey.length === 0 || options === null) return;
		return watchConnection(connKey, options);
	}, [connKey, options, watchConnection]);

	useEffect(() => {
		void connectionSnapshot?.generation;
		if (normalizedSessionId.length > 0 && options !== null) {
			void hydrate(connKey, options, normalizedSessionId);
			void hydratePermissions(connKey, options, normalizedSessionId);
			void hydrateOutbox(connKey, normalizedSessionId);
		}
	}, [
		connKey,
		connectionSnapshot?.generation,
		hydrate,
		hydrateOutbox,
		hydratePermissions,
		normalizedSessionId,
		options,
	]);

	const chatId = detail?.chat?.id ?? null;
	// Mark the chat read on open/focus (and when the chat resolves after a
	// hydrate) so the inbox unread styling clears. Idempotent server-side.
	useEffect(() => {
		if (chatId === null || options === null) return;
		void markChatRead(connKey, options, chatId);
	}, [chatId, connKey, options, markChatRead]);

	const error = errorBySession[stateKey];
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
	}, [
		connKey,
		flushOutbox,
		normalizedSessionId,
		transportOnline,
		options,
		queuedCount,
	]);

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
	const pendingPlan = (() => {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const content = messages[index]?.content;
			if (content?._tag !== "tool_use" || content.tool !== "ExitPlanMode") {
				continue;
			}
			const input = content.input;
			if (typeof input !== "object" || input === null || !("plan" in input)) {
				continue;
			}
			const plan = Reflect.get(input, "plan");
			if (typeof plan === "string" && plan.trim().length > 0) {
				return { itemId: content.itemId, plan };
			}
		}
		return null;
	})();

	// Bottom-slot precedence (matches web): a permission or an unanswered
	// question fully replaces the composer; plan review replaces it only when
	// neither is pending. Permission outranks question because the agent is
	// already mid-tool-call. ExitPlanMode is split out from real permissions.
	const planRequest =
		pending.find(
			(request) =>
				request.kind._tag === "Other" && request.kind.tool === "ExitPlanMode",
		) ?? null;
	const permissionRequests = pending.filter(
		(request) =>
			!(request.kind._tag === "Other" && request.kind.tool === "ExitPlanMode"),
	);
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

	// The live "working" row shows the whole time the agent runs, but not while a
	// prompt takeover (permission / question / plan) owns the bottom slot.
	const workingActive =
		sessionRunning &&
		headPermission === null &&
		pendingQuestion === null &&
		planRequest === null;
	const workingSince = turns.at(-1)?.startedAt.getTime() ?? screenOpenedAt;

	const onAnswerQuestion = useCallback<MessageRowContext["onAnswerQuestion"]>(
		(itemId, answers) =>
			options === null
				? Promise.resolve()
				: Effect.runPromise(
						answerQuestion({
							connection: options,
							sessionId: normalizedSessionId,
							itemId,
							answers,
						}),
					),
		[normalizedSessionId, options],
	);

	const ctx = useMemo<MessageRowContext>(
		() => ({
			connectionKey: connKey,
			sessionId: normalizedSessionId,
			answeredQuestionIds,
			connKey,
			questionsByItemId,
			toolResultsByItemId,
			planMode: detail?.session.permissionMode === "plan",
			sessionRunning: sessionStatus === "running",
			onAnswerQuestion,
			normalizedSessionId,
		}),
		[
			answeredQuestionIds,
			detail?.session.permissionMode,
			onAnswerQuestion,
			questionsByItemId,
			sessionStatus,
			toolResultsByItemId,
			connKey,
			normalizedSessionId,
		],
	);

	useEffect(() => {
		void stateKey;
		didInitialScroll.current = false;
		initialScrollQuietUntil.current = Date.now() + 500;
		atBottomRef.current = true;
	}, [stateKey]);

	// Fade the jump button in/out from its visibility state (assignment must
	// live in an effect for the React Compiler's shared-value immutability rule).
	useEffect(() => {
		jumpOpacity.value = withTiming(showJumpButton ? 1 : 0, { duration: 160 });
	}, [showJumpButton, jumpOpacity]);

	const scrollToLatest = useCallback(() => {
		if (messages.length === 0) return;
		// Only autoscroll when the user is already at the bottom, or during the
		// very first positioning of a freshly-opened chat. Otherwise leave the
		// scroll position alone so reading isn't yanked (D6).
		if (didInitialScroll.current && !atBottomRef.current) return;
		const animated =
			didInitialScroll.current && Date.now() > initialScrollQuietUntil.current;
		didInitialScroll.current = true;
		requestAnimationFrame(() => {
			listRef.current?.scrollToEnd({ animated });
		});
	}, [messages.length]);

	// Plain functions (not useCallback): the React Compiler memoizes them, and
	// manual memoization of setState-calling callbacks trips its preservation rule.
	const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
		const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
		const distanceFromBottom =
			contentSize.height - (contentOffset.y + layoutMeasurement.height);
		const atBottom = distanceFromBottom <= 40;
		atBottomRef.current = atBottom;
		if (atBottom === showJumpButton) setShowJumpButton(!atBottom);
	};

	const jumpToBottom = () => {
		atBottomRef.current = true;
		setShowJumpButton(false);
		listRef.current?.scrollToEnd({ animated: true });
	};

	const jumpStyle = useAnimatedStyle(() => ({ opacity: jumpOpacity.value }));
	const onBottomAccessoryLayout = (event: LayoutChangeEvent) => {
		const nextHeight = event.nativeEvent.layout.height;
		setBottomAccessoryHeight((current) =>
			Math.abs(current - nextHeight) < 1 ? current : nextHeight,
		);
	};

	const onRename = useCallback(() => {
		if (chatId === null || options === null) return;
		Alert.prompt(
			"Rename chat",
			undefined,
			(value) => {
				const next = value?.trim() ?? "";
				if (next.length === 0) return;
				void renameChatAction(connKey, options, chatId, next);
			},
			"plain-text",
			title,
		);
	}, [chatId, connKey, options, renameChatAction, title]);

	const onArchive = useCallback(() => {
		if (chatId === null || options === null) return;
		void archiveChat(connKey, options, chatId).then(() => router.back());
	}, [archiveChat, chatId, connKey, options]);

	// One bottom accessory for both real permission prompts and plan review
	// (`withPlan`). Rendered in the composer's slot — it replaces the composer.
	const renderPromptAccessory = (
		requests: readonly PermissionRequest[],
		withPlan: boolean,
	) =>
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
					// Queue the typed guidance as the next user message (the Deny wire
					// decision carries no text of its own).
					await Effect.runPromise(
						queueMessage({
							connection: options,
							sessionId: normalizedSessionId,
							input: makeTextInput(message),
						}),
					).catch(() => {});
					await Effect.runPromise(
						flushServerQueue({
							connection: options,
							sessionId: normalizedSessionId,
						}),
					).catch(() => {});
				}}
				planText={withPlan ? pendingPlan?.plan : undefined}
				onOpenPlan={
					withPlan && pendingPlan !== null
						? () =>
								router.push({
									pathname: "/plan-viewer",
									params: {
										conn: connKey,
										sessionId: normalizedSessionId,
										itemId: pendingPlan.itemId,
									},
								})
						: undefined
				}
				onHandoffPlan={
					withPlan
						? async (request) => {
								if (
									pendingPlan === null ||
									detail?.chat === undefined ||
									detail.session.model.trim().length === 0
								) {
									throw new Error("This plan cannot be handed off yet.");
								}
								const session = await createSession(connKey, options, {
									chatId: detail.chat.id,
									providerId: detail.session.providerId,
									model: detail.session.model,
									runtimeMode: detail.session.runtimeMode,
									permissionMode: "default",
									initialPrompt: `Implement this approved plan.\n\n${pendingPlan.plan}`,
								});
								try {
									await decidePermission(
										connKey,
										options,
										normalizedSessionId,
										request.id,
										{ _tag: "Deny" },
									);
								} catch (cause) {
									await archiveSession(connKey, options, session.id);
									throw cause;
								}
								router.replace({
									pathname: "/c/[conn]/session/[sessionId]",
									params: { conn: connKey, sessionId: session.id },
								});
							}
						: undefined
				}
			/>
		);

	return (
		<View className="flex-1 bg-background">
			<Stack.Screen
				options={{
					headerBackVisible: false,
					headerTitleAlign: "center",
					headerLeft: () => (
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Go back"
							hitSlop={10}
							onPress={() => router.back()}
							className="h-9 w-9 items-center justify-center rounded-full bg-card active:opacity-70"
							style={{ borderCurve: "continuous" }}
						>
							<ChevronLeft size={20} color={colors.fg} />
						</Pressable>
					),
					headerTitle: () => (
						<View className="items-center">
							<Text
								className="font-sans-medium text-[15px] text-foreground"
								numberOfLines={1}
							>
								{title}
							</Text>
							<Text
								className="font-sans text-[11px] text-muted-foreground"
								numberOfLines={1}
							>
								{detail?.project.name
									? `${detail.project.name} · ${machineLabel}`
									: machineLabel}
							</Text>
						</View>
					),
					headerRight: () => (
						<View className="flex-row items-center gap-2">
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Browse workspace files"
								hitSlop={10}
								disabled={detail === null}
								onPress={() =>
									router.push({
										pathname: "/c/[conn]/session/[sessionId]/files",
										params: { conn: connKey, sessionId: normalizedSessionId },
									})
								}
								className="h-9 w-9 items-center justify-center rounded-full bg-card active:opacity-70 disabled:opacity-40"
								style={{ borderCurve: "continuous" }}
							>
								<Files size={18} color={colors.fg} />
							</Pressable>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="New chat"
								hitSlop={10}
								onPress={() => router.push("/new-chat")}
								className="h-9 w-9 items-center justify-center rounded-full bg-card active:opacity-70"
								style={{ borderCurve: "continuous" }}
							>
								<Plus size={19} color={colors.fg} />
							</Pressable>
							<SessionActionsMenu
								onRename={chatId === null ? undefined : onRename}
								onArchive={onArchive}
							/>
						</View>
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
				contentInsetAdjustmentBehavior="automatic"
				contentContainerClassName="gap-1 px-4 pt-3"
				contentContainerStyle={{ paddingBottom: bottomAccessoryHeight + 12 }}
				scrollIndicatorInsets={{ bottom: bottomAccessoryHeight }}
				keyboardDismissMode="interactive"
				ListHeaderComponent={
					error || connectionProblem ? (
						<View className="pb-2">
							{connectionProblem ? (
								<Text selectable className="font-sans text-[13px] text-danger">
									{connectionProblem}
								</Text>
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
					workingActive || localQueued.length > 0 || serverQueued.length > 0 ? (
						<View className="pt-1">
							{workingActive ? <WorkingIndicator since={workingSince} /> : null}
							{serverQueued.map((item) => (
								<QueuedBubble
									key={item.id}
									text={item.input.text}
									onCancel={() => {
										if (options !== null) {
											void deleteServerQueued(
												connKey,
												options,
												normalizedSessionId,
												item.id,
											);
										}
									}}
								/>
							))}
							{localQueued.map((item) => (
								<QueuedBubble
									key={item.clientId}
									text={item.text}
									onCancel={() =>
										void cancelQueued(
											connKey,
											normalizedSessionId,
											item.clientId,
										)
									}
								/>
							))}
						</View>
					) : null
				}
				onScroll={onScroll}
				scrollEventThrottle={32}
				maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
				onContentSizeChange={scrollToLatest}
				onLayout={scrollToLatest}
			/>
			<KeyboardAvoidingView
				behavior={process.env.EXPO_OS === "ios" ? "position" : "height"}
				pointerEvents="box-none"
				style={{ position: "absolute", inset: 0 }}
				contentContainerStyle={{ flex: 1 }}
			>
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
							accessibilityLabel="Scroll to latest"
							onPress={jumpToBottom}
						>
							<GlassSurface
								style={{
									width: 40,
									height: 40,
									borderRadius: 20,
									alignItems: "center",
									justifyContent: "center",
								}}
							>
								<ChevronDown size={20} color={colors.fg} />
							</GlassSurface>
						</Pressable>
					</Animated.View>
				) : null}
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
								? "linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.6) 55%, rgba(0,0,0,0.9) 100%)"
								: "linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.6) 55%, rgba(255,255,255,0.9) 100%)",
					}}
				/>
				<View
					onLayout={onBottomAccessoryLayout}
					pointerEvents="box-none"
					style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
				>
					{options === null ? null : headPermission !== null ? (
						renderPromptAccessory(permissionRequests, false)
					) : pendingQuestion !== null ? (
						<View
							className="px-3 pt-2"
							style={{
								paddingBottom: insets.bottom > 0 ? insets.bottom : 12,
							}}
						>
							<PendingUserInputCard
								itemId={pendingQuestion.itemId}
								questions={pendingQuestion.questions}
								onSubmit={onAnswerQuestion}
							/>
						</View>
					) : planRequest !== null ? (
						renderPromptAccessory([planRequest], true)
					) : (
						<Composer
							connKey={connKey}
							connection={options}
							sessionId={normalizedSessionId}
							session={detail?.session ?? null}
							status={sessionStatus}
							fresh={fresh}
							online={transportOnline}
							connectionStatus={connectionSnapshot?.status}
							onRetryConnection={() => retryConnection(connKey, options)}
							bottomInset={insets.bottom}
						/>
					)}
				</View>
			</KeyboardAvoidingView>
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

const QueuedBubble = ({
	text,
	onCancel,
}: {
	text: string;
	onCancel: () => void;
}) => (
	<View className="items-end px-3 py-1.5">
		<View
			style={{ borderCurve: "continuous" }}
			className="max-w-[88%] rounded-2xl border border-primary/40 bg-primary/15 px-3 py-2"
		>
			<View className="mb-0.5 flex-row items-center">
				<Text className="font-sans-medium text-[11px] text-warning">
					Queued
				</Text>
				<View className="flex-1" />
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Cancel queued message"
					hitSlop={8}
					onPress={onCancel}
				>
					<Text className="font-sans-medium text-[12px] text-muted-foreground">
						Cancel
					</Text>
				</Pressable>
			</View>
			<Text className="font-sans text-[15px] leading-5 text-foreground">
				{text}
			</Text>
		</View>
	</View>
);
