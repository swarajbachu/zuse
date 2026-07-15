import {
	ArrowUp02Icon,
	CancelCircleIcon,
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
	type Session,
	type SessionId,
	type SessionStatus,
} from "@zuse/contracts";
import { Effect } from "effect";
import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
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
import {
	ComposerModelMenu,
	ComposerSettingsMenu,
	type ModelModeValue,
} from "./model-mode-menu";
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

	return (
		<View
			className="px-3 pt-2"
			style={{ paddingBottom: bottomInset > 0 ? bottomInset : 12 }}
		>
			<View className="min-h-11 flex-row flex-wrap items-center justify-center gap-2 pb-2">
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
				{(currentActivity?.files.length ?? 0) > 0 ? (
					<StatusPill
						label={`${currentActivity?.files.length ?? 0} files  +${currentActivity?.added ?? 0} −${currentActivity?.removed ?? 0}`}
						tone="files"
						onPress={
							currentActivity?.fileItemId === null ||
							currentActivity?.fileItemId === undefined
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
				{(currentActivity?.agents ?? 0) > 0 ? (
					<StatusPill
						label={`${currentActivity?.agents} ${currentActivity?.agents === 1 ? "agent" : "agents"}`}
						tone="neutral"
						onPress={
							currentActivity?.agentItemId === null ||
							currentActivity?.agentItemId === undefined
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
			<GlassSurface
				style={{
					gap: 8,
					padding: 10,
				}}
			>
				{modelValue?.permissionMode === "plan" ? (
					<PlanPill
						editable
						onClear={() =>
							void changeModelMode({ ...modelValue, permissionMode: "default" })
						}
					/>
				) : null}
				<TextInput
					className="max-h-36 min-h-12 px-1 py-2 font-sans text-[17px] leading-6 text-foreground"
					multiline
					placeholder={online ? "Message" : "Offline · message will queue"}
					placeholderTextColor={colors.tertiaryFg}
					value={text}
					onChangeText={setText}
				/>
				<View className="flex-row items-end gap-2">
					{modelValue === null ? null : (
						<>
							<ComposerSettingsMenu
								value={modelValue}
								editable
								onChange={(next) => void changeModelMode(next)}
							/>
							<View className="min-w-0 flex-1" />
							<View className="h-11 justify-end pb-2">
								<ComposerModelMenu
									value={modelValue}
									editable
									onChange={(next) => void changeModelMode(next)}
									availableProviders={availableProviders}
									canChangeProvider={fresh}
									canChangeReasoning={fresh}
								/>
							</View>
						</>
					)}
					{showInterrupt ? (
						<Button
							size="sm"
							variant="secondary"
							className="h-11 w-11 rounded-2xl px-0"
							disabled={busy || !online}
							onPress={interrupt}
							accessibilityLabel="Stop response"
						>
							<HugeIcon icon={StopIcon} size={15} color={colors.fg as string} />
						</Button>
					) : null}
					<Button
						size="sm"
						variant={online ? "primary" : "secondary"}
						className="h-11 w-11 rounded-2xl px-0"
						disabled={!canSend}
						onPress={submit}
						accessibilityLabel={online ? "Send message" : "Queue message"}
					>
						{busy ? (
							<ActivityIndicator color={colors.bg} />
						) : online ? (
							<HugeIcon
								icon={ArrowUp02Icon}
								size={18}
								color={colors.bg as string}
							/>
						) : (
							<HugeIcon
								icon={CloudOffIcon}
								size={15}
								color={colors.fg as string}
							/>
						)}
					</Button>
				</View>
			</GlassSurface>
		</View>
	);
};

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const PlanPill = ({
	editable,
	onClear,
}: {
	editable: boolean;
	onClear: () => void;
}) => (
	<View className="self-start flex-row items-center gap-2 rounded-full bg-card-elevated px-3 py-2">
		<Text className="font-sans-medium text-[15px] text-foreground">Plan</Text>
		{editable ? (
			<Pressable accessibilityRole="button" onPress={onClear} hitSlop={8}>
				<HugeIcon
					icon={CancelCircleIcon}
					size={15}
					color={colors.secondaryFg as string}
				/>
			</Pressable>
		) : null}
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
