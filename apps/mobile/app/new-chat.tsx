import ArrowUpIcon from "@hugeicons-pro/core-solid-rounded/ArrowUp01Icon";
import CloudOffIcon from "@hugeicons-pro/core-solid-rounded/CloudOffIcon";
import {
	orderedChatSessions,
	resolveActiveChatSession,
} from "@zuse/client-runtime/chat-threads";
import type {
	ChatId,
	Folder,
	GitBranchInfo,
	GitPrSummary,
	Worktree,
} from "@zuse/contracts";
import { Effect } from "effect";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Keyboard,
	KeyboardAvoidingView,
	ScrollView,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ComposerActionSlot } from "~/components/composer-action-slot";
import { ComposerApprovalMenu } from "~/components/composer-approval-menu";
import { ComposerAttachmentStrip } from "~/components/composer-attachment-strip";
import { ComposerInputFrame } from "~/components/composer-input-frame";
import { ComposerModeChip } from "~/components/composer-mode-chip";
import { ComposerPlusMenu } from "~/components/composer-plus-menu";
import type { ModelModeValue } from "~/components/model-mode-menu";
import { ModelSheet } from "~/components/model-sheet";
import { ModelSheetTrigger } from "~/components/model-sheet-trigger";
import { SelectorRow } from "~/components/selector-row";
import { Button } from "~/components/ui/button";
import { GlassSurface } from "~/components/ui/glass-surface";
import { HugeIcon } from "~/components/ui/huge-icon";
import {
	type LocalComposerAttachment,
	pickComposerFiles,
	pickComposerImages,
	uploadComposerAttachment,
} from "~/lib/composer-attachments";
import { optionsForConnection } from "~/lib/connection-params";
import { availableConnections } from "~/lib/connection-records";
import {
	availableProviderIds,
	defaultModelForProvider,
	defaultModelOptions,
} from "~/lib/model-options";
import {
	buildNewChatCreatePayload,
	MAIN_SOURCE,
	type NewChatSource,
	type NewChatSourceKind,
	sourceOptionsForKind,
	WORK_MODE_OPTIONS,
	workModeLabel,
} from "~/lib/new-chat";
import { connectionSessionKey } from "~/lib/session-key";
import { hasRunningChatThread } from "~/lib/thread-presentation";
import {
	createWorktree,
	listBranches,
	listPullRequests,
	listWorktrees,
	makeTextInput,
	sendMessage,
} from "~/rpc/actions";
import { useAuthStore } from "~/store/auth";
import { useAvailabilityStore } from "~/store/availability";
import { useConnectionsStore } from "~/store/connections";
import { useSessionsStore } from "~/store/sessions";
import { colors } from "~/theme";

export default function NewChatScreen() {
	const insets = useSafeAreaInsets();
	const { conn, chatId } = useLocalSearchParams<{
		conn?: string;
		chatId?: string;
	}>();
	const requestedConnectionKey = conn?.trim() ?? "";
	const requestedChatId = (chatId?.trim() ?? "") as ChatId;
	const inheritedModel = useRef(false);
	const [text, setText] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [modelSheetOpen, setModelSheetOpen] = useState(false);
	const [attachments, setAttachments] = useState<LocalComposerAttachment[]>([]);
	const [goalMode, setGoalMode] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selectedConnectionKey, setSelectedConnectionKey] = useState<
		string | null
	>(null);
	const [selectedProjectId, setSelectedProjectId] = useState<
		Folder["id"] | null
	>(null);
	const [source, setSource] = useState<NewChatSource>(MAIN_SOURCE);
	// The work-mode kind is tracked separately from `source`: a kind can have no
	// sub-options (e.g. no worktrees yet), and `source` falls back to MAIN in
	// that case — so keying the work-mode selector off `source.kind` would make
	// it snap back to "Work locally". `sourceKind` is the source of truth for
	// which work mode is selected.
	const [sourceKind, setSourceKind] = useState<NewChatSourceKind>("main");
	const initialModel = defaultModelForProvider("codex");
	const [modelMode, setModelMode] = useState<ModelModeValue>({
		providerId: "codex",
		model: initialModel,
		runtimeMode: "approval-required",
		permissionMode: "default",
		modelOptions: defaultModelOptions("codex", initialModel),
	});
	const [worktrees, setWorktrees] = useState<readonly Worktree[]>([]);
	const [branches, setBranches] = useState<readonly GitBranchInfo[]>([]);
	const [prs, setPrs] = useState<readonly GitPrSummary[]>([]);

	const {
		connections: allConnections,
		hydrated,
		hydrate: hydrateConnections,
		refreshLabel,
	} = useConnectionsStore();
	const account = useAuthStore((state) => state.account);
	const connections = useMemo(
		() => availableConnections(allConnections, account !== null),
		[account, allConnections],
	);
	const {
		bundlesByConnection,
		loadingByConnection,
		hydrate: hydrateSessions,
		createChat,
		createSession,
		statusBySession,
	} = useSessionsStore();

	useEffect(() => {
		if (!hydrated) void hydrateConnections();
	}, [hydrateConnections, hydrated]);

	useEffect(() => {
		for (const connection of connections) {
			const options = optionsForConnection(connection.key, connections);
			if (options === null) continue;
			void hydrateSessions(connection.key, options);
			// Adopt the machine's computed name here too, so the machine row shows
			// the nice label even if the inbox hasn't refreshed it yet.
			void refreshLabel(connection.key, options);
		}
	}, [connections, hydrateSessions, refreshLabel]);

	const effectiveConnectionKey =
		selectedConnectionKey ??
		(requestedConnectionKey.length > 0 ? requestedConnectionKey : null) ??
		connections[0]?.key ??
		null;

	const threadContext = useMemo(() => {
		if (effectiveConnectionKey === null || requestedChatId.length === 0)
			return null;
		for (const bundle of bundlesByConnection[effectiveConnectionKey] ?? []) {
			const chat = bundle.chats.find((item) => item.id === requestedChatId);
			if (chat === undefined) continue;
			const threads = orderedChatSessions(bundle.sessions, chat.id);
			return {
				chat,
				project: bundle.project,
				threads,
				activeThread: resolveActiveChatSession(chat, threads),
			};
		}
		return null;
	}, [bundlesByConnection, effectiveConnectionKey, requestedChatId]);
	const threadMode = requestedChatId.length > 0;

	const projectChoices = useMemo(() => {
		if (effectiveConnectionKey === null) return [];
		return (bundlesByConnection[effectiveConnectionKey] ?? []).map(
			(bundle) => ({
				project: bundle.project,
				connectionKey: effectiveConnectionKey,
			}),
		);
	}, [bundlesByConnection, effectiveConnectionKey]);

	const effectiveProjectId =
		threadContext?.chat.projectId ??
		(selectedProjectId !== null &&
		projectChoices.some((item) => item.project.id === selectedProjectId)
			? selectedProjectId
			: (projectChoices[0]?.project.id ?? null));

	const selectedOptions = useMemo(
		() =>
			effectiveConnectionKey === null
				? null
				: optionsForConnection(effectiveConnectionKey, connections),
		[connections, effectiveConnectionKey],
	);

	const hydrateAvailability = useAvailabilityStore((state) => state.hydrate);
	const availability = useAvailabilityStore((state) =>
		effectiveConnectionKey === null
			? undefined
			: state.availabilityByConnection[effectiveConnectionKey],
	);
	useEffect(() => {
		if (effectiveConnectionKey === null || selectedOptions === null) return;
		void hydrateAvailability(effectiveConnectionKey, selectedOptions);
	}, [effectiveConnectionKey, selectedOptions, hydrateAvailability]);
	const availableProviders = useMemo(
		() => availableProviderIds(availability),
		[availability],
	);

	useEffect(() => {
		const active = threadContext?.activeThread;
		if (active === null || active === undefined || inheritedModel.current)
			return;
		inheritedModel.current = true;
		setModelMode({
			providerId: active.providerId,
			model: active.model,
			runtimeMode: active.runtimeMode,
			permissionMode: active.permissionMode,
			modelOptions: defaultModelOptions(active.providerId, active.model),
		});
	}, [threadContext?.activeThread]);

	// Codex is the hardcoded default provider; if the selected machine doesn't
	// have it installed, derive a fallback to the first available provider so the
	// menu and the create payload start on something the server can actually run.
	// Derived (not stored) to avoid a setState-in-effect cascade — the user's own
	// picks always come from the filtered menu, so they pass through unchanged.
	const effectiveModelMode = useMemo<ModelModeValue>(() => {
		if (
			availableProviders === null ||
			availableProviders.length === 0 ||
			availableProviders.includes(modelMode.providerId)
		) {
			return modelMode;
		}
		const providerId = availableProviders[0];
		if (providerId === undefined) return modelMode;
		const model = defaultModelForProvider(providerId);
		return {
			...modelMode,
			providerId,
			model,
			modelOptions: defaultModelOptions(providerId, model),
		};
	}, [availableProviders, modelMode]);
	const goalSupported =
		availability
			?.find((entry) => entry.providerId === effectiveModelMode.providerId)
			?.capabilities?.includes("goalMode") === true;

	useEffect(() => {
		if (threadMode || selectedOptions === null || effectiveProjectId === null)
			return;
		let cancelled = false;
		void Promise.all([
			Effect.runPromise(
				listWorktrees({
					connection: selectedOptions,
					projectId: effectiveProjectId,
				}),
			).catch(() => [] as readonly Worktree[]),
			Effect.runPromise(
				listBranches({
					connection: selectedOptions,
					projectId: effectiveProjectId,
				}),
			),
			Effect.runPromise(
				listPullRequests({
					connection: selectedOptions,
					projectId: effectiveProjectId,
				}),
			),
		]).then(([nextWorktrees, nextBranches, nextPrs]) => {
			if (cancelled) return;
			setWorktrees(nextWorktrees);
			setBranches(nextBranches);
			setPrs(nextPrs);
		});
		return () => {
			cancelled = true;
		};
	}, [selectedOptions, effectiveProjectId, threadMode]);

	const loading = Object.values(loadingByConnection).some(Boolean);
	const selectedProject =
		threadContext?.project ??
		projectChoices.find((item) => item.project.id === effectiveProjectId)
			?.project;

	// Selector-stack derived values (machine → project → work-mode → branch).
	const machineOptions = connections.map((connection) => ({
		key: connection.key,
		label: connection.label,
		selected: connection.key === effectiveConnectionKey,
		onSelect: () => {
			setSelectedConnectionKey(connection.key);
			setSelectedProjectId(null);
			setSource(MAIN_SOURCE);
			setSourceKind("main");
		},
	}));
	const machineLabel =
		connections.find((connection) => connection.key === effectiveConnectionKey)
			?.label ?? (connections.length === 0 ? "No machines" : "Machine");

	const projectOptions = projectChoices.map((item) => ({
		key: item.project.id,
		label: item.project.name,
		selected: item.project.id === effectiveProjectId,
		onSelect: () => {
			setSelectedProjectId(item.project.id);
			setSource(MAIN_SOURCE);
			setSourceKind("main");
		},
	}));
	const projectLabel =
		selectedProject?.name ?? (loading ? "Loading projects" : "Project");

	const firstSourceForKind = (kind: NewChatSourceKind): NewChatSource =>
		sourceOptionsForKind(kind, worktrees, branches, prs)[0]?.source ??
		MAIN_SOURCE;
	const workModeOptions = WORK_MODE_OPTIONS.map((option) => ({
		key: option.kind,
		label: option.label,
		selected: sourceKind === option.kind,
		onSelect: () => {
			setSourceKind(option.kind);
			setSource(firstSourceForKind(option.kind));
		},
	}));

	const defaultBranchLabel =
		branches.find((branch) => branch.current)?.name ?? "main";
	const emptyBranchLabel =
		sourceKind === "worktree"
			? "No worktrees"
			: sourceKind === "pr"
				? "No pull requests"
				: "No branches";
	const branchOptions = sourceOptionsForKind(
		sourceKind,
		worktrees,
		branches,
		prs,
	).map((option) => ({
		key: option.key,
		label: option.label,
		selected:
			option.source.kind === source.kind &&
			option.source.label === source.label,
		onSelect: () => setSource(option.source),
	}));
	const branchLabel =
		sourceKind === "main"
			? defaultBranchLabel
			: source.kind === sourceKind
				? source.label
				: emptyBranchLabel;

	const canSubmit =
		effectiveConnectionKey !== null &&
		selectedOptions !== null &&
		effectiveProjectId !== null &&
		text.trim().length > 0 &&
		!submitting &&
		// For a non-"main" work mode, require a concrete sub-option (a real
		// worktree/branch/PR) — otherwise `source` is still the MAIN fallback and
		// we'd silently create a main-checkout chat.
		(threadMode || sourceKind === "main" || source.kind === sourceKind) &&
		(!threadMode || threadContext !== null);

	const performSubmit = useCallback(async () => {
		const payload = buildNewChatCreatePayload({
			connectionKey: effectiveConnectionKey,
			projectId: effectiveProjectId,
			providerId: effectiveModelMode.providerId,
			model: effectiveModelMode.model,
			runtimeMode: effectiveModelMode.runtimeMode,
			permissionMode: effectiveModelMode.permissionMode,
			modelOptions: effectiveModelMode.modelOptions,
			source,
			text,
		});
		if (
			payload === null ||
			effectiveConnectionKey === null ||
			selectedOptions === null
		) {
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const requiresRichSend = attachments.length > 0 || goalMode;
			if (threadMode && threadContext !== null) {
				const session = await createSession(
					effectiveConnectionKey,
					selectedOptions,
					{
						chatId: threadContext.chat.id,
						providerId: payload.providerId,
						model: payload.model,
						initialPrompt: requiresRichSend ? "" : payload.initialPrompt,
						runtimeMode: payload.runtimeMode,
						permissionMode: payload.permissionMode,
						modelOptions: payload.modelOptions,
					},
				);
				if (requiresRichSend) {
					const uploaded = await Promise.all(
						attachments.map((attachment) =>
							uploadComposerAttachment(selectedOptions, session.id, attachment),
						),
					);
					await Effect.runPromise(
						sendMessage({
							connection: selectedOptions,
							sessionId: session.id,
							input: makeTextInput(payload.initialPrompt, uploaded, goalMode),
							asGoal: goalMode,
						}),
					);
				}
				Keyboard.dismiss();
				router.replace(
					`/c/${encodeURIComponent(effectiveConnectionKey)}/session/${encodeURIComponent(session.id)}`,
				);
				return;
			}

			const worktreeId =
				payload.createSource === null
					? payload.worktreeId
					: (
							await Effect.runPromise(
								createWorktree({
									connection: selectedOptions,
									projectId: payload.projectId,
									source: payload.createSource,
								}),
							)
						).id;
			const result = await createChat(effectiveConnectionKey, selectedOptions, {
				projectId: payload.projectId,
				providerId: payload.providerId,
				model: payload.model,
				initialPrompt: requiresRichSend ? "" : payload.initialPrompt,
				runtimeMode: payload.runtimeMode,
				permissionMode: payload.permissionMode,
				modelOptions: payload.modelOptions,
				worktreeId,
			});
			if (requiresRichSend) {
				const uploaded = await Promise.all(
					attachments.map((attachment) =>
						uploadComposerAttachment(
							selectedOptions,
							result.initialSession.id,
							attachment,
						),
					),
				);
				await Effect.runPromise(
					sendMessage({
						connection: selectedOptions,
						sessionId: result.initialSession.id,
						input: makeTextInput(payload.initialPrompt, uploaded, goalMode),
						asGoal: goalMode,
					}),
				);
			}
			Keyboard.dismiss();
			router.replace(
				`/c/${encodeURIComponent(effectiveConnectionKey)}/session/${encodeURIComponent(
					result.initialSession.id,
				)}`,
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSubmitting(false);
		}
	}, [
		createChat,
		createSession,
		attachments,
		goalMode,
		effectiveModelMode,
		effectiveConnectionKey,
		selectedOptions,
		effectiveProjectId,
		source,
		text,
		threadContext,
		threadMode,
	]);

	const submit = useCallback(() => {
		if (!threadMode || threadContext === null) {
			void performSubmit();
			return;
		}
		const siblingRunning = hasRunningChatThread(
			threadContext.threads,
			(thread) =>
				statusBySession[
					connectionSessionKey(effectiveConnectionKey ?? "", thread.id)
				] ?? thread.status,
		);
		if (!siblingRunning) {
			void performSubmit();
			return;
		}
		Alert.alert(
			"Another thread is running",
			"Both threads share this workspace and may edit the same files. Start this thread anyway?",
			[
				{ text: "Cancel", style: "cancel" },
				{ text: "Start thread", onPress: () => void performSubmit() },
			],
		);
	}, [
		effectiveConnectionKey,
		performSubmit,
		statusBySession,
		threadContext,
		threadMode,
	]);

	return (
		<KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
			<Stack.Screen
				options={{
					title: threadMode ? "New Thread" : "New Chat",
					headerBackVisible: false,
				}}
			/>
			<Stack.Toolbar placement="left">
				<Stack.Toolbar.Button
					icon="chevron.left"
					separateBackground
					onPress={() => router.back()}
				/>
			</Stack.Toolbar>
			<ScrollView
				className="flex-1"
				contentInsetAdjustmentBehavior="automatic"
				keyboardShouldPersistTaps="handled"
				contentContainerStyle={{
					padding: 18,
					paddingBottom: 24,
					gap: 18,
					flexGrow: 1,
				}}
			>
				<View className="flex-1" />

				{error === null ? null : (
					<Text
						selectable
						className="font-sans text-[13px] leading-5 text-danger"
					>
						{error}
					</Text>
				)}
			</ScrollView>

			<View
				className="px-3 pt-2"
				style={{ paddingBottom: insets.bottom > 0 ? insets.bottom : 12 }}
			>
				{threadMode && threadContext !== null ? (
					<View className="mb-4 gap-1 px-2">
						<Text className="font-sans-medium text-[15px] text-foreground">
							{threadContext.chat.title}
						</Text>
						<Text className="font-sans text-[12px] text-muted-foreground">
							{threadContext.project.name} · current workspace
						</Text>
					</View>
				) : (
					<View className="mb-4 gap-3 px-1">
						<SelectorRow
							symbol="laptopcomputer"
							label={machineLabel}
							options={machineOptions}
							emptyLabel="No machines"
						/>
						<SelectorRow
							symbol="folder"
							label={projectLabel}
							options={projectOptions}
							emptyLabel={loading ? "Loading projects" : "No projects"}
						/>
						<SelectorRow
							symbol="desktopcomputer"
							label={workModeLabel(sourceKind)}
							options={workModeOptions}
						/>
						<SelectorRow
							symbol="arrow.triangle.branch"
							label={branchLabel}
							options={branchOptions}
							disabled={sourceKind === "main"}
							emptyLabel={emptyBranchLabel}
						/>
					</View>
				)}
				<GlassSurface
					style={{
						gap: 8,
						padding: 10,
					}}
				>
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
							<TextInput
								className="max-h-36 min-h-12 px-1 py-2 font-sans text-[17px] leading-6 text-foreground"
								multiline
								placeholder="Ask Zuse"
								placeholderTextColor={colors.tertiaryFg}
								value={text}
								onChangeText={setText}
							/>
						}
						leadingAction={
							<View className="flex-row items-center gap-1">
								<ComposerActionSlot>
									<ComposerPlusMenu
										goalMode={goalMode}
										goalSupported={goalSupported}
										planMode={effectiveModelMode.permissionMode === "plan"}
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
											setModelMode((value) => ({
												...value,
												permissionMode: next ? "plan" : "default",
											}))
										}
									/>
								</ComposerActionSlot>
								<ComposerActionSlot>
									<ComposerApprovalMenu
										runtimeMode={effectiveModelMode.runtimeMode}
										onChange={(runtimeMode) =>
											setModelMode((value) => ({ ...value, runtimeMode }))
										}
									/>
								</ComposerActionSlot>
								{effectiveModelMode.permissionMode === "plan" ? (
									<ComposerModeChip
										label="Plan"
										plan
										onClear={() =>
											setModelMode((value) => ({
												...value,
												permissionMode: "default",
											}))
										}
									/>
								) : null}
								{goalMode ? (
									<ComposerModeChip
										label="Goal"
										onClear={() => setGoalMode(false)}
									/>
								) : null}
							</View>
						}
						trailingAction={
							<View className="min-w-0 flex-row items-center gap-1.5">
								<ModelSheetTrigger
									value={effectiveModelMode}
									onPress={() => setModelSheetOpen(true)}
								/>
								<Button
									size="sm"
									variant="primary"
									className="h-10 w-10 rounded-2xl px-0"
									hitSlop={4}
									disabled={!canSubmit}
									onPress={() => void submit()}
								>
									{submitting ? (
										<ActivityIndicator color={colors.primaryForeground} />
									) : selectedOptions === null ? (
										<HugeIcon
											icon={CloudOffIcon}
											size={15}
											color={colors.primaryForeground}
										/>
									) : (
										<HugeIcon
											icon={ArrowUpIcon}
											size={18}
											color={colors.primaryForeground}
										/>
									)}
								</Button>
							</View>
						}
					/>
				</GlassSurface>
				<ModelSheet
					open={modelSheetOpen}
					onOpenChange={setModelSheetOpen}
					value={effectiveModelMode}
					availableProviders={availableProviders}
					canChangeProvider
					canChangeReasoning
					onChange={setModelMode}
				/>
			</View>
		</KeyboardAvoidingView>
	);
}
