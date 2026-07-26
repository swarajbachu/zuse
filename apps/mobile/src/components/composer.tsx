import { useAtomValue } from "@effect/atom-react";
import {
	ArrowUp02Icon,
	CloudOffIcon,
	StopIcon,
} from "@zuse/icons/solid-rounded";
import type { ComposerTrigger } from "@zuse/client-runtime/composer-trigger";
import { containsComposerToken } from "@zuse/client-runtime/composer-trigger";
import { chooseComposerSubmitRoute } from "@zuse/client-runtime/plan-interactions";
import {
	type FileRef,
	Message,
	type MessageContent,
	MessageId,
	type PermissionMode,
	type RuntimeMode,
	type Session,
	type SessionId,
	type SessionStatus,
	type SkillRef,
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
	captureComposerImage,
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
import { connectionErrorMessage } from "~/lib/connection-error-message";
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
	hydrateComposerDraft,
	setComposerDraft,
} from "~/store/composer-drafts";
import {
	addOptimisticMessage,
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
import {
	ComposerContextPicker,
	type ComposerPickerRow,
} from "./composer-context-picker";
import { ComposerContextTray } from "./composer-context-tray";
import { ComposerInputFrame } from "./composer-input-frame";
import { ComposerModeChip } from "./composer-mode-chip";
import { ComposerPlusMenu } from "./composer-plus-menu";
import {
	ComposerTextInput,
	type ComposerTextInputHandle,
} from "./composer-text-input";
import { ComposerVoiceButton } from "./composer-voice-button";
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
	onFocusChange,
	onMessageAppendFailed,
	onMessageWillAppend,
	currentActivity = null,
	bottomInset,
	voiceEnabled = false,
	contextUsagePercent = null,
}: {
	connKey: string;
	connection: WsProtocolOptions;
	sessionId: SessionId;
	session: Session | null;
	status?: SessionStatus;
	fresh: boolean;
	online: boolean;
	onFocusChange?: (focused: boolean) => void;
	onMessageAppendFailed?: () => void;
	onMessageWillAppend?: () => void;
	/** Latest-turn activity summary, computed once by the thread screen. */
	currentActivity?: ComposerActivity | null;
	bottomInset?: number;
	voiceEnabled?: boolean;
	contextUsagePercent?: number | null;
}) => {
	const stateKey = connectionSessionKey(connKey, sessionId);
	// Lazy state (not a ref): reading a ref during render violates the React
	// Compiler's rules; the initializer runs once per mount (keyed by stateKey).
	const [initialDraft] = useState(() => composerDraft(stateKey));
	const inputRef = useRef<ComposerTextInputHandle>(null);
	const [hydratedText, setHydratedText] = useState(initialDraft.text);
	const [draftHydrated, setDraftHydrated] = useState(false);
	const [hasText, setHasText] = useState(initialDraft.text.trim().length > 0);
	const [busy, setBusy] = useState(false);
	const [focused, setFocused] = useState(false);
	const [modelSheetOpen, setModelSheetOpen] = useState(false);
	const [attachments, setAttachments] = useState<LocalComposerAttachment[]>([
		...initialDraft.attachments,
	]);
	const [goalMode, setGoalMode] = useState(initialDraft.goalMode);
	const [fileRefs, setFileRefs] = useState<FileRef[]>([
		...(initialDraft.fileRefs ?? []),
	]);
	const [skillRefs, setSkillRefs] = useState<SkillRef[]>([
		...(initialDraft.skillRefs ?? []),
	]);
	const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
	const [composerError, setComposerError] = useState<string | null>(null);
	useEffect(() => {
		let active = true;
		void hydrateComposerDraft(stateKey).then((draft) => {
			if (!active) return;
			if (draft !== null) {
				const currentText = inputRef.current?.getText() ?? hydratedText;
				if (currentText === initialDraft.text) {
					setHydratedText(draft.text);
					setHasText(draft.text.trim().length > 0);
					inputRef.current?.replaceAll(draft.text);
					setAttachments([...draft.attachments]);
					setGoalMode(draft.goalMode);
					setFileRefs([...(draft.fileRefs ?? [])]);
					setSkillRefs([...(draft.skillRefs ?? [])]);
				}
			}
			setDraftHydrated(true);
		});
		return () => {
			active = false;
		};
	}, [hydratedText, initialDraft.text, stateKey]);
	// Only auto-focus the input when the user taps the collapsed pill — never when
	// the bar auto-expands (e.g. opening a running session) so the keyboard
	// doesn't pop unexpectedly.
	const shouldAutoFocus = useRef(false);
	// Text persists on blur/unmount (inside ComposerTextInput); attachments and
	// goal mode change rarely, so persisting them eagerly is cheap.
	useEffect(() => {
		if (!draftHydrated) return;
		setComposerDraft(stateKey, {
			text: inputRef.current?.getText() ?? hydratedText,
			attachments,
			goalMode,
			fileRefs,
			skillRefs,
		});
	}, [
		attachments,
		draftHydrated,
		fileRefs,
		goalMode,
		hydratedText,
		skillRefs,
		stateKey,
	]);
	const persistDraftText = (text: string) => {
		if (text.length === 0 && attachments.length === 0 && !goalMode) {
			clearComposerDraft(stateKey);
			return;
		}
		setComposerDraft(stateKey, {
			text,
			attachments,
			goalMode,
			fileRefs,
			skillRefs,
		});
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
	const hasPills = agentCount > 0 || contextUsagePercent !== null;
	const finishSuccessfulSubmission = ({
		dismissKeyboard,
	}: {
		dismissKeyboard: boolean;
	}) => {
		clearComposerDraft(stateKey);
		inputRef.current?.clear();
		setHasText(false);
		setAttachments([]);
		setFileRefs([]);
		setSkillRefs([]);
		setTrigger(null);
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
			const input = makeTextInput(
				value,
				uploaded,
				goalMode,
				fileRefs,
				skillRefs,
			);
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
			optimisticMessageId = messageId;
			const optimisticContent: MessageContent =
				uploaded.length > 0 || fileRefs.length > 0 || skillRefs.length > 0
					? {
							_tag: "user_rich",
							text: value,
							attachments: uploaded,
							fileRefs,
							skillRefs,
							annotations: [],
							goal: goalMode,
						}
					: {
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

	const removeToken = (token: string) => {
		const text = inputRef.current?.getText() ?? "";
		const from = text.indexOf(token);
		if (from >= 0) {
			inputRef.current?.replaceRange(from, from + token.length, "");
		}
	};

	const selectContext = (row: ComposerPickerRow) => {
		if (trigger === null) return;
		if (row.kind === "file") {
			const token = `@${row.value.relPath}`;
			setFileRefs((current) =>
				current.some((item) => item.relPath === row.value.relPath)
					? current
					: [...current, row.value],
			);
			inputRef.current?.replaceRange(trigger.from, trigger.to, `${token} `);
		} else if (row.kind === "skill") {
			const token = `/${row.value.name}`;
			setSkillRefs((current) =>
				current.some((item) => item.name === row.value.name)
					? current
					: [
							...current,
							{
								name: row.value.name,
								scope: row.value.scope,
								args: "",
								providerId: row.value.providerId,
							},
						],
			);
			inputRef.current?.replaceRange(trigger.from, trigger.to, `${token} `);
		} else {
			inputRef.current?.replaceRange(
				trigger.from,
				trigger.to,
				`/${row.value.name} `,
			);
		}
		setTrigger(null);
	};

	const interrupt = async () => {
		if (!showInterrupt) return;
		setBusy(true);
		setComposerError(null);
		try {
			await Effect.runPromise(interruptSession({ connection, sessionId }));
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
					{contextUsagePercent === null ? null : (
						<StatusPill
							label={`Context ${Math.round(contextUsagePercent)}%`}
							tone={contextUsagePercent >= 85 ? "warning" : "neutral"}
						/>
					)}
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
						{trigger !== null && session !== null ? (
							<ComposerContextPicker
								kind={trigger.kind}
								query={trigger.query}
								connection={connection}
								projectId={session.projectId}
								worktreeId={session.worktreeId}
								sessionId={sessionId}
								providerId={session.providerId}
								onSelect={selectContext}
							/>
						) : null}
						<ComposerContextTray
							fileRefs={fileRefs}
							skillRefs={skillRefs}
							onRemoveFile={(relPath) => {
								setFileRefs((current) =>
									current.filter((item) => item.relPath !== relPath),
								);
								removeToken(`@${relPath}`);
							}}
							onRemoveSkill={(name) => {
								setSkillRefs((current) =>
									current.filter((item) => item.name !== name),
								);
								removeToken(`/${name}`);
							}}
						/>
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
									initialText={hydratedText}
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
									onTextChange={(text) => {
										setFileRefs((current) =>
											current.filter((file) =>
												containsComposerToken(text, `@${file.relPath}`),
											),
										);
										setSkillRefs((current) =>
											current.filter((skill) =>
												containsComposerToken(text, `/${skill.name}`),
											),
										);
									}}
									onTriggerChange={setTrigger}
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
												onCaptureImage={() =>
													void captureComposerImage()
														.then((items) =>
															setAttachments((current) => [
																...current,
																...items,
															]),
														)
														.catch((cause) =>
															setComposerError(
																cause instanceof Error
																	? cause.message
																	: String(cause),
															),
														)
												}
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
									<ComposerVoiceButton
										connection={connection}
										enabled={voiceEnabled}
										online={online}
										onTranscript={(text) =>
											inputRef.current?.insertAtCursor(text)
										}
										onError={setComposerError}
									/>
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
									onCaptureImage={() =>
										void captureComposerImage().then((items) =>
											setAttachments((current) => [...current, ...items]),
										)
									}
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

const messageOf = (cause: unknown): string => connectionErrorMessage(cause);

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
