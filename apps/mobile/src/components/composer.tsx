import { useAtomValue } from "@effect/atom-react";
import {
	ArrowUp02Icon,
	CloudOffIcon,
	StopIcon,
} from "@hugeicons-pro/core-solid-rounded";
import { chooseComposerSubmitRoute } from "@zuse/client-runtime/plan-interactions";
import type { ConnectionStatus } from "@zuse/client-runtime/supervisor";
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
import { useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	Keyboard,
	Pressable,
	Text,
	View,
} from "react-native";
import {
	type LocalComposerAttachment,
	pickComposerFiles,
	pickComposerImages,
	uploadComposerAttachment,
} from "~/lib/composer-attachments";
import {
	type ComposerActivity,
	composerExpanded,
	isInterruptVisible,
	nextModelChangeActions,
} from "~/lib/composer-state";
import { availableProviderIds } from "~/lib/model-options";
import { connectionSessionKey } from "~/lib/session-key";
import {
	flushServerQueue,
	interruptSession,
	makeTextInput,
	queueMessage,
	sendMessage,
	setSessionModel,
	setSessionProvider,
} from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import {
	connectionAvailabilityAtom,
	hydrateAvailability,
} from "~/store/availability";
import {
	clearComposerDraft,
	composerDraft,
	setComposerDraft,
} from "~/store/composer-drafts";
import {
	addOptimisticMessage,
	currentSessionTurnId,
	removeOptimisticMessage,
} from "~/store/messages";
import { enqueueOutboxMessage } from "~/store/outbox";
import {
	setPermissionMode as setPermissionModeOptimistic,
	setRuntimeMode as setRuntimeModeOptimistic,
} from "~/store/sessions";
import { colors } from "~/theme";
import { ComposerActionSlot } from "./composer-action-slot";
import { ComposerApprovalMenu } from "./composer-approval-menu";
import { ComposerAttachmentStrip } from "./composer-attachment-strip";
import { ComposerInputFrame } from "./composer-input-frame";
import { ComposerModeChip } from "./composer-mode-chip";
import { ComposerPlusMenu } from "./composer-plus-menu";
import {
	ComposerTextInput,
	type ComposerTextInputHandle,
} from "./composer-text-input";
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
	onFocusChange,
	onMessageAppendFailed,
	onMessageWillAppend,
	currentActivity = null,
	bottomInset,
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
	onFocusChange?: (focused: boolean) => void;
	onMessageAppendFailed?: () => void;
	onMessageWillAppend?: () => void;
	/** Latest-turn activity summary, computed once by the thread screen. */
	currentActivity?: ComposerActivity | null;
	bottomInset?: number;
}) => {
	const stateKey = connectionSessionKey(connKey, sessionId);
	// Lazy state (not a ref): reading a ref during render violates the React
	// Compiler's rules; the initializer runs once per mount (keyed by stateKey).
	const [initialDraft] = useState(() => composerDraft(stateKey));
	const inputRef = useRef<ComposerTextInputHandle>(null);
	const [hasText, setHasText] = useState(initialDraft.text.trim().length > 0);
	const [busy, setBusy] = useState(false);
	const [focused, setFocused] = useState(false);
	const [modelSheetOpen, setModelSheetOpen] = useState(false);
	const [attachments, setAttachments] = useState<LocalComposerAttachment[]>([
		...initialDraft.attachments,
	]);
	const [goalMode, setGoalMode] = useState(initialDraft.goalMode);
	const [composerError, setComposerError] = useState<string | null>(null);
	// Only auto-focus the input when the user taps the collapsed pill — never when
	// the bar auto-expands (e.g. opening a running session) so the keyboard
	// doesn't pop unexpectedly.
	const shouldAutoFocus = useRef(false);
	// Text persists on blur/unmount (inside ComposerTextInput); attachments and
	// goal mode change rarely, so persisting them eagerly is cheap.
	useEffect(() => {
		setComposerDraft(stateKey, {
			text: inputRef.current?.getText() ?? "",
			attachments,
			goalMode,
		});
	}, [attachments, goalMode, stateKey]);
	const persistDraftText = (text: string) => {
		if (text.length === 0 && attachments.length === 0 && !goalMode) {
			clearComposerDraft(stateKey);
			return;
		}
		setComposerDraft(stateKey, { text, attachments, goalMode });
	};

	const availability = useAtomValue(connectionAvailabilityAtom(connKey));
	useEffect(() => {
		void hydrateAvailability(connKey, connection);
	}, [connKey, connection]);
	const availableProviders = useMemo(
		() => availableProviderIds(availability),
		[availability],
	);
	const goalSupported =
		availability
			?.find((entry) => entry.providerId === session?.providerId)
			?.capabilities?.includes("goalMode") === true;

	const canSend = (hasText || attachments.length > 0) && !busy;
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
	// Modes remain visible in both layouts, but only editor activity expands the
	// composer. A running agent remains interruptible from the compact control.
	const expanded = composerExpanded({
		focused,
		hasText,
		hasAttachments: attachments.length > 0,
		sheetOpen: modelSheetOpen,
	});
	const agentCount = currentActivity?.agents ?? 0;
	const hasPills = !online || agentCount > 0;
	const finishSuccessfulSubmission = ({
		dismissKeyboard,
	}: {
		dismissKeyboard: boolean;
	}) => {
		clearComposerDraft(stateKey);
		inputRef.current?.clear();
		setHasText(false);
		setAttachments([]);
		setGoalMode(false);
		if (dismissKeyboard) Keyboard.dismiss();
	};

	const submit = async () => {
		if (!canSend) return;
		const value = (inputRef.current?.getText() ?? "").trim();
		if (value.length === 0 && attachments.length === 0) return;
		if (!online) {
			if (attachments.length > 0) {
				setComposerError("Attachments require an active connection.");
				return;
			}
			await enqueueOutboxMessage(connKey, sessionId, value, goalMode);
			finishSuccessfulSubmission({ dismissKeyboard: true });
			return;
		}
		setBusy(true);
		setComposerError(null);
		let optimisticMessageId: MessageId | null = null;
		let didPrepareAppend = false;
		try {
			const uploaded = await Promise.all(
				attachments.map((attachment) =>
					uploadComposerAttachment(connection, sessionId, attachment),
				),
			);
			const input = makeTextInput(value, uploaded, goalMode);
			const route = chooseComposerSubmitRoute({
				sendPlanFeedbackNow: false,
				goalSendMode: goalMode,
				shouldQueue: showInterrupt,
			});
			if (route === "queue") {
				await Effect.runPromise(
					queueMessage({
						connection,
						sessionId,
						input,
					}),
				);
				await Effect.runPromise(flushServerQueue({ connection, sessionId }));
				finishSuccessfulSubmission({ dismissKeyboard: true });
				return;
			}
			const messageId = MessageId.make(Crypto.randomUUID());
			// Establish the transcript anchor before publishing the optimistic
			// row. LegendList's anchored-end contract uses the pre-append index.
			onMessageWillAppend?.();
			didPrepareAppend = true;
			if (uploaded.length === 0) {
				optimisticMessageId = messageId;
				const optimisticContent: MessageContent = {
					_tag: "user",
					text: value,
					goal: goalMode,
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
			}
			await Effect.runPromise(
				sendMessage({
					connection,
					sessionId,
					input,
					asGoal: goalMode,
					clientMessageId: messageId,
				}),
			);
			finishSuccessfulSubmission({ dismissKeyboard: false });
		} catch (cause) {
			setComposerError(messageOf(cause));
			if (optimisticMessageId !== null) {
				removeOptimisticMessage(stateKey, optimisticMessageId);
			}
			if (didPrepareAppend) onMessageAppendFailed?.();
		} finally {
			setBusy(false);
		}
	};

	const interrupt = async () => {
		if (!showInterrupt) return;
		setBusy(true);
		setComposerError(null);
		try {
			const turnId = currentSessionTurnId(connKey, sessionId);
			if (turnId === undefined) {
				onRetryConnection?.();
				throw new Error(
					"Live response is reconnecting. Try stopping again in a moment.",
				);
			}
			await Effect.runPromise(
				interruptSession({ connection, sessionId, turnId }),
			);
		} catch (cause) {
			setComposerError(messageOf(cause));
		} finally {
			setBusy(false);
		}
	};

	const changeModelMode = async (next: ModelModeValue) => {
		if (session === null) return;
		const actions = nextModelChangeActions(session, next, fresh);
		setComposerError(null);
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
						if (
							!(await setRuntimeModeOptimistic(
								connKey,
								connection,
								sessionId,
								action.runtimeMode,
							))
						)
							throw new Error(
								"Could not change approval mode. Tap the option to retry.",
							);
						break;
					case "setPermissionMode":
						if (
							!(await setPermissionModeOptimistic(
								connKey,
								connection,
								sessionId,
								action.permissionMode,
							))
						)
							throw new Error("Could not change Plan mode. Tap Plan to retry.");
						break;
				}
			}
		} catch (cause) {
			setComposerError(messageOf(cause));
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
		<View className="px-3 pt-2" style={{ paddingBottom: bottomInset ?? 12 }}>
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
				}}
			>
				{expanded ? (
					<>
						<ComposerAttachmentStrip
							attachments={attachments}
							onRemove={(id) =>
								setAttachments((current) =>
									current.filter((item) => item.id !== id),
								)
							}
						/>
						<ComposerInputFrame
							input={
								<ComposerTextInput
									ref={inputRef}
									initialText={initialDraft.text}
									placeholder={
										online ? "Ask Zuse" : "Offline · message will queue"
									}
									autoFocusOnMountRef={shouldAutoFocus}
									onHasTextChange={setHasText}
									onFocus={() => {
										setFocused(true);
										onFocusChange?.(true);
									}}
									onBlur={() => {
										setFocused(false);
										onFocusChange?.(false);
									}}
									onPersist={persistDraftText}
								/>
							}
							leadingAction={
								modelValue === null ? null : (
									<View className="flex-row items-center gap-1">
										<ComposerActionSlot>
											<ComposerPlusMenu
												goalMode={goalMode}
												goalSupported={goalSupported}
												planMode={planMode}
												onPickImages={() =>
													void pickComposerImages().then((items) =>
														setAttachments((current) => [...current, ...items]),
													)
												}
												onPickFiles={() =>
													void pickComposerFiles().then((items) =>
														setAttachments((current) => [...current, ...items]),
													)
												}
												onToggleGoal={setGoalMode}
												onTogglePlan={(next) =>
													setPermissionMode(next ? "plan" : "default")
												}
											/>
										</ComposerActionSlot>
										<ComposerActionSlot>
											<ComposerApprovalMenu
												runtimeMode={modelValue.runtimeMode}
												onChange={setRuntimeMode}
											/>
										</ComposerActionSlot>
										{planMode ? (
											<ComposerModeChip
												label="Plan"
												plan
												onClear={() => setPermissionMode("default")}
											/>
										) : null}
										{goalMode ? (
											<ComposerModeChip
												label="Goal"
												onClear={() => setGoalMode(false)}
											/>
										) : null}
									</View>
								)
							}
							trailingAction={
								<View className="min-w-0 flex-row items-center gap-1.5">
									{modelValue === null ? null : (
										<ModelSheetTrigger
											value={modelValue}
											onPress={() => setModelSheetOpen(true)}
										/>
									)}
									<SendButton
										showInterrupt={showInterrupt}
										online={online}
										busy={busy}
										disabled={showInterrupt ? busy || !online : !canSend}
										onPress={showInterrupt ? interrupt : submit}
									/>
								</View>
							}
						/>
					</>
				) : (
					<View className="h-11 flex-row items-center gap-1">
						{modelValue === null ? null : (
							<ComposerActionSlot>
								<ComposerPlusMenu
									goalMode={goalMode}
									goalSupported={goalSupported}
									planMode={planMode}
									onPickImages={() =>
										void pickComposerImages().then((items) =>
											setAttachments((current) => [...current, ...items]),
										)
									}
									onPickFiles={() =>
										void pickComposerFiles().then((items) =>
											setAttachments((current) => [...current, ...items]),
										)
									}
									onToggleGoal={setGoalMode}
									onTogglePlan={(next) =>
										setPermissionMode(next ? "plan" : "default")
									}
								/>
							</ComposerActionSlot>
						)}
						{planMode ? (
							<ComposerModeChip
								label="Plan"
								plan
								onClear={() => setPermissionMode("default")}
							/>
						) : null}
						{goalMode ? (
							<ComposerModeChip
								label="Goal"
								onClear={() => setGoalMode(false)}
							/>
						) : null}
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
						<SendButton
							showInterrupt={showInterrupt}
							online={online}
							busy={busy}
							disabled={showInterrupt ? busy || !online : !canSend}
							onPress={showInterrupt ? interrupt : submit}
						/>
					</View>
				)}
			</GlassSurface>
			{composerError ? (
				<Text selectable className="px-3 pt-2 font-sans text-xs text-danger">
					{composerError}
				</Text>
			) : null}

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
		className="h-10 w-10 rounded-2xl px-0"
		hitSlop={4}
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
				size={16}
				color={colors.primaryForeground}
			/>
		) : (
			<HugeIcon icon={CloudOffIcon} size={15} color={colors.fg as string} />
		)}
	</Button>
);

function StatusPill({
	label,
	tone,
	onPress,
}: {
	label: string;
	tone: "neutral" | "warning" | "danger";
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
