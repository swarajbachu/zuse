import {
	ArrowUp02Icon,
	CloudOffIcon,
	StopIcon,
} from "@hugeicons-pro/core-solid-rounded";
import type { ConnectionStatus } from "@zuse/client-runtime/supervisor";
import {
	extractFileChanges,
	groupTimelineTurns,
	summarizeTurnActivity,
} from "@zuse/client-runtime/timeline";
import {
	Message,
	type MessageContent,
	MessageId,
	type PermissionMode,
	type RuntimeMode,
	type Session,
	type SessionId,
	type SessionStatus,
} from "@zuse/contracts";
import { Effect } from "effect";
import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { ListTodo, X } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	Text,
	TextInput,
	View,
} from "react-native";
import {
	isInterruptVisible,
	nextModelChangeActions,
} from "~/lib/composer-state";
import { availableProviderIds } from "~/lib/model-options";
import { connectionSessionKey } from "~/lib/session-key";
import { selectSessionMessages } from "~/lib/session-messages";
import {
	flushServerQueue,
	interruptSession,
	makeTextInput,
	queueMessage,
	sendMessage,
	setSessionModel,
	setSessionPermissionMode,
	setSessionProvider,
	setSessionRuntimeMode,
} from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import { useAvailabilityStore } from "~/store/availability";
import {
	addOptimisticMessage,
	removeOptimisticMessage,
	useMobileMessagesStore,
} from "~/store/messages";
import { useOutboxStore } from "~/store/outbox";
import { colors } from "~/theme";
import { ComposerApprovalMenu } from "./composer-approval-menu";
import { ComposerPlusMenu } from "./composer-plus-menu";
import type { ModelModeValue } from "./model-mode-menu";
import { ModelSheet } from "./model-sheet";
import { ModelSheetTrigger } from "./model-sheet-trigger";
import { Button } from "./ui/button";
import { GlassSurface } from "./ui/glass-surface";
import { HugeIcon } from "./ui/huge-icon";

export const Composer = ({
	connKey,
	connection,
	sessionId,
	session,
	status,
	fresh,
	online,
	connectionStatus,
	onRetryConnection,
	bottomInset = 0,
}: {
	connKey: string;
	connection: WsProtocolOptions;
	sessionId: SessionId;
	session: Session | null;
	status?: SessionStatus;
	fresh: boolean;
	online: boolean;
	connectionStatus?: ConnectionStatus;
	onRetryConnection?: () => void;
	bottomInset?: number;
}) => {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [focused, setFocused] = useState(false);
	const [modelSheetOpen, setModelSheetOpen] = useState(false);
	// Only auto-focus the input when the user taps the collapsed pill — never when
	// the bar auto-expands (e.g. opening a running session) so the keyboard
	// doesn't pop unexpectedly.
	const shouldAutoFocus = useRef(false);
	const stateKey = connectionSessionKey(connKey, sessionId);

	const queuedCount = useOutboxStore(
		(state) => (state.queuedBySession[stateKey] ?? []).length,
	);
	const queueSending = useOutboxStore(
		(state) => state.sendingBySession[stateKey] === true,
	);
	const queueError = useOutboxStore((state) => state.errorBySession[stateKey]);
	const enqueue = useOutboxStore((state) => state.enqueue);
	const messages = useMobileMessagesStore((state) =>
		selectSessionMessages(state.messagesBySession, stateKey),
	);
	const currentActivity = useMemo(() => {
		const turn = groupTimelineTurns(messages).at(-1);
		if (turn === undefined) return null;
		const summary = summarizeTurnActivity(turn.body);
		const firstFileTool = turn.body.find((message) => {
			const content = message.content;
			return (
				content._tag === "tool_use" &&
				extractFileChanges(content.tool, content.input).length > 0
			);
		});
		const firstAgentTool = turn.body.find((message) => {
			const content = message.content;
			return (
				content._tag === "tool_use" && /task|agent|spawn/i.test(content.tool)
			);
		});
		return {
			...summary,
			fileItemId:
				firstFileTool?.content._tag === "tool_use"
					? firstFileTool.content.itemId
					: null,
			agentItemId:
				firstAgentTool?.content._tag === "tool_use"
					? firstAgentTool.content.itemId
					: null,
		};
	}, [messages]);

	const hydrateAvailability = useAvailabilityStore((state) => state.hydrate);
	const availability = useAvailabilityStore(
		(state) => state.availabilityByConnection[connKey],
	);
	useEffect(() => {
		void hydrateAvailability(connKey, connection);
	}, [connKey, connection, hydrateAvailability]);
	const availableProviders = useMemo(
		() => availableProviderIds(availability),
		[availability],
	);

	const canSend = text.trim().length > 0 && !busy;
	const showInterrupt = isInterruptVisible(status);
	const modelValue: ModelModeValue | null =
		session === null
			? null
			: {
					providerId: session.providerId,
					model: session.model,
					runtimeMode: session.runtimeMode,
					permissionMode: session.permissionMode,
				};
	const planMode = modelValue?.permissionMode === "plan";
	// Collapse to a compact pill when the composer is idle: not focused, empty,
	// and the agent isn't running. Any of those expands it to the full bar.
	const expanded =
		focused || text.trim().length > 0 || showInterrupt || modelSheetOpen;

	const fileCount = currentActivity?.files.length ?? 0;
	const agentCount = currentActivity?.agents ?? 0;
	const hasPills =
		!online || queuedCount > 0 || fileCount > 0 || agentCount > 0;

	const submit = async () => {
		if (!canSend) return;
		const value = text.trim();
		setText("");
		if (!online) {
			await enqueue(connKey, sessionId, value);
			return;
		}
		setBusy(true);
		if (showInterrupt) {
			try {
				await Effect.runPromise(
					queueMessage({
						connection,
						sessionId,
						input: makeTextInput(value),
					}),
				);
			} catch (cause) {
				console.warn("[mobile] composer.queue_add_failed", {
					sessionId,
					reason: messageOf(cause),
				});
				await enqueue(connKey, sessionId, value);
				setBusy(false);
				return;
			}
			await Effect.runPromise(
				flushServerQueue({ connection, sessionId }),
			).catch((cause) => {
				console.warn("[mobile] composer.queue_flush_failed", {
					sessionId,
					reason: messageOf(cause),
				});
			});
			setBusy(false);
			return;
		}
		const messageId = MessageId.make(Crypto.randomUUID());
		const optimisticContent: MessageContent = {
			_tag: "user",
			text: value,
			goal: false,
		};
		addOptimisticMessage(
			stateKey,
			Message.make({
				id: messageId,
				sessionId,
				role: "user",
				content: optimisticContent,
				createdAt: new Date(),
			}),
		);
		try {
			await Effect.runPromise(
				sendMessage({
					connection,
					sessionId,
					input: makeTextInput(value),
					clientMessageId: messageId,
				}),
			);
		} catch {
			removeOptimisticMessage(stateKey, messageId);
			// Lost the connection mid-send — keep the text safe in the outbox.
			await enqueue(connKey, sessionId, value);
		} finally {
			setBusy(false);
		}
	};

	const interrupt = async () => {
		if (!showInterrupt) return;
		setBusy(true);
		try {
			await Effect.runPromise(interruptSession({ connection, sessionId }));
		} finally {
			setBusy(false);
		}
	};

	const changeModelMode = async (next: ModelModeValue) => {
		if (session === null) return;
		const actions = nextModelChangeActions(session, next, fresh);
		try {
			for (const action of actions) {
				switch (action.type) {
					case "setProvider":
						await Effect.runPromise(
							setSessionProvider({
								connection,
								sessionId,
								providerId: action.providerId,
								model: action.model,
							}),
						);
						break;
					case "setModel":
						await Effect.runPromise(
							setSessionModel({ connection, sessionId, model: action.model }),
						);
						break;
					case "setRuntimeMode":
						await Effect.runPromise(
							setSessionRuntimeMode({
								connection,
								sessionId,
								runtimeMode: action.runtimeMode,
							}),
						);
						break;
					case "setPermissionMode":
						await Effect.runPromise(
							setSessionPermissionMode({
								connection,
								sessionId,
								mode: action.permissionMode,
							}),
						);
						break;
				}
			}
		} catch {
			// Started sessions can reject some changes. Keep this quiet on mobile.
		}
	};

	const setRuntimeMode = (runtimeMode: RuntimeMode) => {
		if (modelValue === null) return;
		void changeModelMode({ ...modelValue, runtimeMode });
	};
	const setPermissionMode = (permissionMode: PermissionMode) => {
		if (modelValue === null) return;
		void changeModelMode({ ...modelValue, permissionMode });
	};

	return (
		<View
			className="px-3 pt-2"
			style={{ paddingBottom: bottomInset > 0 ? bottomInset : 12 }}
		>
			{hasPills ? (
				<View className="mb-2 flex-row flex-wrap items-center justify-center gap-2">
					{!online ? (
						<StatusPill
							label={
								connectionStatus === "error"
									? "Connection unavailable · Retry"
									: connectionStatus === "blockedAuth"
										? "Sign in required"
										: connectionStatus === "offline"
											? "Offline"
											: connectionStatus === "connecting"
												? "Connecting"
												: "Reconnecting"
							}
							tone={connectionStatus === "error" ? "danger" : "warning"}
							onPress={
								connectionStatus === "error" ? onRetryConnection : undefined
							}
						/>
					) : null}
					{queuedCount > 0 ? (
						<StatusPill
							label={`${queuedCount} queued${queueSending ? " · sending" : queueError ? " · retry" : ""}`}
							tone={queueError ? "danger" : "neutral"}
						/>
					) : null}
					{fileCount > 0 ? (
						<StatusPill
							label={`${fileCount} files  +${currentActivity?.added ?? 0} −${currentActivity?.removed ?? 0}`}
							tone="files"
							onPress={
								currentActivity?.fileItemId == null
									? undefined
									: () =>
											router.push({
												pathname: "/c/[conn]/session/[sessionId]/tool/[itemId]",
												params: {
													conn: connKey,
													sessionId,
													itemId: currentActivity?.fileItemId ?? "",
												},
											})
							}
						/>
					) : null}
					{agentCount > 0 ? (
						<StatusPill
							label={`${agentCount} ${agentCount === 1 ? "agent" : "agents"}`}
							tone="neutral"
							onPress={
								currentActivity?.agentItemId == null
									? undefined
									: () =>
											router.push({
												pathname: "/c/[conn]/session/[sessionId]/tool/[itemId]",
												params: {
													conn: connKey,
													sessionId,
													itemId: currentActivity?.agentItemId ?? "",
												},
											})
							}
						/>
					) : null}
				</View>
			) : null}

			<GlassSurface
				style={{
					gap: 8,
					paddingHorizontal: expanded ? 16 : 12,
					paddingVertical: expanded ? 10 : 6,
					borderRadius: 26,
					borderWidth: planMode ? 1.5 : 0,
					borderColor: planMode ? colors.accent : "transparent",
				}}
			>
				{expanded && planMode ? (
					<PlanPill onClear={() => setPermissionMode("default")} />
				) : null}

				{expanded ? (
					<>
						<TextInput
							// Focus on mount only when the user opened the bar by tapping the
							// collapsed pill — avoids popping the keyboard on auto-expand.
							ref={(node) => {
								if (node && shouldAutoFocus.current) {
									shouldAutoFocus.current = false;
									node.focus();
								}
							}}
							className="max-h-36 min-h-11 px-1 py-2 font-sans text-[17px] leading-6 text-foreground"
							multiline
							placeholder={online ? "Ask Zuse" : "Offline · message will queue"}
							placeholderTextColor={colors.tertiaryFg}
							value={text}
							onChangeText={setText}
							onFocus={() => setFocused(true)}
							onBlur={() => setFocused(false)}
						/>
						<View className="flex-row items-center gap-2">
							{modelValue === null ? null : (
								<>
									<ComposerPlusMenu
										planMode={planMode}
										onTogglePlan={(next) =>
											setPermissionMode(next ? "plan" : "default")
										}
									/>
									<ComposerApprovalMenu
										runtimeMode={modelValue.runtimeMode}
										onChange={setRuntimeMode}
									/>
									<View className="min-w-0 flex-1" />
									<ModelSheetTrigger
										value={modelValue}
										onPress={() => setModelSheetOpen(true)}
									/>
								</>
							)}
							<SendButton
								showInterrupt={showInterrupt}
								online={online}
								busy={busy}
								disabled={showInterrupt ? busy || !online : !canSend}
								onPress={showInterrupt ? interrupt : submit}
							/>
						</View>
					</>
				) : (
					<View className="flex-row items-center gap-1">
						{modelValue === null ? null : (
							<ComposerPlusMenu
								planMode={planMode}
								onTogglePlan={(next) =>
									setPermissionMode(next ? "plan" : "default")
								}
							/>
						)}
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Write a message"
							className="min-h-11 flex-1 justify-center px-1"
							onPress={() => {
								shouldAutoFocus.current = true;
								setFocused(true);
							}}
						>
							<Text className="font-sans text-[17px] text-muted-foreground">
								{online ? "Ask Zuse" : "Offline · message will queue"}
							</Text>
						</Pressable>
					</View>
				)}
			</GlassSurface>

			{modelValue === null ? null : (
				<ModelSheet
					open={modelSheetOpen}
					onOpenChange={setModelSheetOpen}
					value={modelValue}
					availableProviders={availableProviders}
					canChangeProvider={fresh}
					canChangeReasoning={fresh}
					onChange={(next) => void changeModelMode(next)}
				/>
			)}
		</View>
	);
};

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const SendButton = ({
	showInterrupt,
	online,
	busy,
	disabled,
	onPress,
}: {
	showInterrupt: boolean;
	online: boolean;
	busy: boolean;
	disabled: boolean;
	onPress: () => void;
}) => (
	<Button
		size="sm"
		variant={showInterrupt ? "secondary" : online ? "primary" : "secondary"}
		className="h-11 w-11 rounded-full px-0"
		disabled={disabled}
		onPress={onPress}
		accessibilityLabel={
			showInterrupt
				? "Stop response"
				: online
					? "Send message"
					: "Queue message"
		}
	>
		{busy ? (
			<ActivityIndicator
				color={showInterrupt ? colors.fg : colors.primaryForeground}
			/>
		) : showInterrupt ? (
			<HugeIcon icon={StopIcon} size={15} color={colors.fg as string} />
		) : online ? (
			<HugeIcon
				icon={ArrowUp02Icon}
				size={18}
				color={colors.primaryForeground}
			/>
		) : (
			<HugeIcon icon={CloudOffIcon} size={15} color={colors.fg as string} />
		)}
	</Button>
);

/** The "Plan" indicator pill docked at the top of the composer in plan mode. */
const PlanPill = ({ onClear }: { onClear: () => void }) => (
	<View className="self-start flex-row items-center gap-2 rounded-full bg-card-elevated px-3 py-1.5">
		<ListTodo size={15} color={colors.accent} />
		<Text className="font-sans-medium text-[14px] text-foreground">Plan</Text>
		<Pressable accessibilityRole="button" onPress={onClear} hitSlop={8}>
			<X size={14} color={colors.secondaryFg} />
		</Pressable>
	</View>
);

function StatusPill({
	label,
	tone,
	onPress,
}: {
	label: string;
	tone: "neutral" | "warning" | "danger" | "files";
	onPress?: () => void;
}) {
	const color =
		tone === "warning"
			? colors.warning
			: tone === "danger"
				? colors.danger
				: colors.secondaryFg;
	const content = (
		<View
			className="min-h-11 justify-center rounded-full border border-border bg-card px-3"
			style={{ borderCurve: "continuous" }}
		>
			<Text
				selectable
				className="font-sans-medium text-[12px]"
				style={{ color, fontVariant: ["tabular-nums"] }}
			>
				{label}
			</Text>
		</View>
	);
	return onPress === undefined ? (
		content
	) : (
		<Pressable accessibilityRole="button" onPress={onPress}>
			{content}
		</Pressable>
	);
}
