import {
	Add01Icon,
	ArrowUpIcon,
	CancelCircleIcon,
	CloudOffIcon,
} from "@hugeicons-pro/core-solid-rounded";
import type {
	Folder,
	GitBranchInfo,
	GitPrSummary,
	Worktree,
} from "@zuse/contracts";
import { Effect } from "effect";
import { router, Stack } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	KeyboardAvoidingView,
	Pressable,
	ScrollView,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ModelModeValue } from "~/components/model-mode-menu";
import { ModelSheet } from "~/components/model-sheet";
import { ModelSheetTrigger } from "~/components/model-sheet-trigger";
import { SelectorRow } from "~/components/selector-row";
import { Button } from "~/components/ui/button";
import { GlassSurface } from "~/components/ui/glass-surface";
import { HugeIcon } from "~/components/ui/huge-icon";
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
import {
	createWorktree,
	listBranches,
	listPullRequests,
	listWorktrees,
} from "~/rpc/actions";
import { useAuthStore } from "~/store/auth";
import { useAvailabilityStore } from "~/store/availability";
import { useConnectionsStore } from "~/store/connections";
import { useSessionsStore } from "~/store/sessions";
import { colors } from "~/theme";

export default function NewChatScreen() {
	const insets = useSafeAreaInsets();
	const [text, setText] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [modelSheetOpen, setModelSheetOpen] = useState(false);
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
		selectedConnectionKey ?? connections[0]?.key ?? null;

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
		selectedProjectId !== null &&
		projectChoices.some((item) => item.project.id === selectedProjectId)
			? selectedProjectId
			: (projectChoices[0]?.project.id ?? null);

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

	useEffect(() => {
		if (selectedOptions === null || effectiveProjectId === null) return;
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
	}, [selectedOptions, effectiveProjectId]);

	const loading = Object.values(loadingByConnection).some(Boolean);
	const selectedProject = projectChoices.find(
		(item) => item.project.id === effectiveProjectId,
	)?.project;

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
		(sourceKind === "main" || source.kind === sourceKind);

	const submit = useCallback(async () => {
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
				initialPrompt: payload.initialPrompt,
				runtimeMode: payload.runtimeMode,
				permissionMode: payload.permissionMode,
				modelOptions: payload.modelOptions,
				worktreeId,
			});
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
		effectiveModelMode,
		effectiveConnectionKey,
		selectedOptions,
		effectiveProjectId,
		source,
		text,
	]);

	return (
		<KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
			<Stack.Screen options={{ title: "New Chat" }} />
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
				<View className="mb-2 gap-0.5 px-1">
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
				<GlassSurface
					style={{
						gap: 8,
						padding: 10,
					}}
				>
					{effectiveModelMode.permissionMode === "plan" ? (
						<PlanPill
							onClear={() =>
								setModelMode((value) => ({
									...value,
									permissionMode: "default",
								}))
							}
						/>
					) : null}
					<TextInput
						className="max-h-36 min-h-12 px-1 py-2 font-sans text-[17px] leading-6 text-foreground"
						multiline
						placeholder="Ask Zuse"
						placeholderTextColor={colors.tertiaryFg}
						value={text}
						onChangeText={setText}
					/>
					<View className="flex-row items-center gap-2">
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Add attachment"
							disabled
							className="h-9 w-9 items-center justify-center rounded-full opacity-40"
						>
							<HugeIcon icon={Add01Icon} size={18} color={colors.secondaryFg} />
						</Pressable>
						<View className="flex-1" />
						<ModelSheetTrigger
							value={effectiveModelMode}
							onPress={() => setModelSheetOpen(true)}
						/>
						<Button
							size="sm"
							variant="primary"
							className="h-10 w-10 rounded-2xl px-0"
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

const PlanPill = ({ onClear }: { onClear: () => void }) => (
	<View className="self-start flex-row items-center gap-2 rounded-full bg-card-elevated px-3 py-2">
		<Text className="font-sans-medium text-[15px] text-foreground">Plan</Text>
		<Pressable accessibilityRole="button" onPress={onClear} hitSlop={8}>
			<HugeIcon icon={CancelCircleIcon} size={15} color={colors.secondaryFg} />
		</Pressable>
	</View>
);
