import { useExtensionProviderCatalog } from "../lib/extension-provider-catalog.ts";
import "@zuse/i18n/english/providers";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	AgentAvailability,
	ChatId,
	EnvironmentId,
	ProviderId,
	RuntimeMode,
	SessionId,
} from "@zuse/contracts";
import {
	modelsForProvider as catalogModelsForProvider,
	catalogProviderIds,
	findModelDescriptor,
	isModelVisible,
	type ModelOption,
	PROVIDER_LABELS,
	type SelectOptionDescriptor,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	ArrowUpRight01Icon,
	Search01Icon,
	StarIcon,
	Tick01Icon,
} from "@zuse/icons/solid-rounded";
import { ChevronDown } from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { overlaySurface } from "~/components/ui/overlay-surface";
import { useExtensionCatalog } from "~/lib/extension-client-bus.ts";
import { isModelPickerProviderVisible } from "~/lib/model-picker-availability";
import { useOptionalRendererSessionTimeline } from "~/lib/session-timeline-hooks.ts";
import { useSettingsStore } from "~/lib/settings-client-bus.ts";
import { cn } from "~/lib/utils";
import { useModelCatalogStore } from "~/store/model-catalog";
import { useProvidersStore } from "~/store/providers";
import { useSessionsStore } from "~/store/sessions";
import { ProviderIcon } from "./provider-icons";
import { Popover, PopoverPrimitive, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const PROVIDER_LABEL = PROVIDER_LABELS;

const PROVIDER_CHIP_LABEL: Record<ProviderId, string> = {
	claude: "Claude",
	codex: "Codex",
	grok: "Grok",
	cursor: "Cursor",
	gemini: "Gemini",
	opencode: "OpenCode",
	opencode2: "OpenCode 2",
	kiro: "Kiro",
	pi: "Pi",
};

const useProviderDisplayName = (providerId: ProviderId | null): string => {
	const catalog = useExtensionCatalog();
	if (providerId === null) return "All";
	return (
		PROVIDER_LABEL[providerId] ??
		(
			catalog.knownProviders ?? catalog.items.flatMap((item) => item.providers)
		).find((provider) => provider.id === providerId)?.displayName ??
		providerId
	);
};

interface ModelPickerEntry {
	providerId: ProviderId;
	modelId: string;
	label: string;
	badgeLabel?: string;
	/**
	 * When set, render a small context-window pill on this row. We only show
	 * a pill when the model's `contextWindow` descriptor defaults to `"1m"`
	 * — otherwise the chip would clutter every legacy 200k row.
	 */
	contextWindowLabel?: string;
}

type Scope = ProviderId | "all";

export const compactModelLabel = (label: string): string =>
	label.replace(/^gpt[-\s]*/i, "").trim();

type ModelPickerProps =
	| {
			mode: "session";
			environmentId: EnvironmentId;
			sessionId: SessionId;
			chatId: ChatId;
			runtimeMode: RuntimeMode;
			providerId: ProviderId;
			currentModel: string;
			composer?: boolean;
			triggerDetail?: string;
			optionsPanel?: ReactNode;
			triggerClassName?: string;
			onOpenChange?: (open: boolean) => void;
	  }
	| {
			mode: "default";
			composer?: boolean;
			triggerClassName?: string;
			onOpenChange?: (open: boolean) => void;
	  };

export function ModelPicker(props: ModelPickerProps) {
	const { message: uiMessage } = useUiMessages(["providers"]);

	const isDefault = props.mode === "default";
	const composer = props.composer === true;
	const triggerDetail =
		props.mode === "session" ? props.triggerDetail : undefined;
	const optionsPanel =
		props.mode === "session" ? props.optionsPanel : undefined;
	const sessionId = props.mode === "session" ? props.sessionId : null;
	const providerEnvironmentId =
		props.mode === "session" ? props.environmentId : null;
	const timeline = useOptionalRendererSessionTimeline(
		sessionId,
		sessionId === null ? "cache-only" : "connect",
		props.mode === "session" ? props.environmentId : null,
	);

	// Live values
	const defaultProviderId = useSettingsStore((s) => s.defaultProviderId);
	const defaultModelByProvider = useSettingsStore(
		(s) => s.defaultModelByProvider,
	);
	const providerEnabled = useSettingsStore((s) => s.providerEnabled);
	const modelEnabledByProvider = useSettingsStore(
		(s) => s.modelEnabledByProvider,
	);
	const customModelIdsByProvider = useSettingsStore(
		(s) => s.customModelIdsByProvider,
	);
	const opencodeProviderVisible = useSettingsStore(
		(s) => s.opencodeProviderVisible,
	);
	const opencodeModelVisibleByProvider = useSettingsStore(
		(s) => s.opencodeModelVisibleByProvider,
	);
	const opencode2ProviderVisible = useSettingsStore(
		(s) => s.opencode2ProviderVisible,
	);
	const opencode2ModelVisibleByProvider = useSettingsStore(
		(s) => s.opencode2ModelVisibleByProvider,
	);

	const providerId = isDefault ? defaultProviderId : props.providerId;
	const currentModel = isDefault
		? (defaultModelByProvider[providerId] ?? "default")
		: props.currentModel;

	// Setters
	const setSessionModel = useSessionsStore((s) => s.setModel);
	const setSessionProvider = useSessionsStore((s) => s.setProvider);
	const createSession = useSessionsStore((s) => s.create);
	const setDefaultProviderAndModel = useSettingsStore(
		(s) => s.setDefaultProviderAndModel,
	);

	const defaultAvailability = useProvidersStore((s) => s.availability);
	const defaultAvailabilityLoaded = useProvidersStore(
		(s) => s.availabilityLoaded,
	);
	const defaultAvailabilityLoading = useProvidersStore((s) => s.loading);
	const environmentAvailability = useProvidersStore((s) =>
		providerEnvironmentId !== null
			? s.availabilityByEnvironment[providerEnvironmentId]
			: undefined,
	);
	const refresh = useProvidersStore((s) => s.refresh);
	const refreshFor = useProvidersStore((s) => s.refreshFor);
	const availability =
		props.mode === "session"
			? (environmentAvailability?.availability ?? [])
			: defaultAvailability;
	const availabilityLoaded =
		props.mode === "session"
			? (environmentAvailability?.availabilityLoaded ?? false)
			: defaultAvailabilityLoaded;
	const availabilityLoading =
		props.mode === "session"
			? (environmentAvailability?.loading ?? false)
			: defaultAvailabilityLoading;
	const refreshAvailability = useCallback(
		() =>
			providerEnvironmentId === null
				? refresh()
				: refreshFor(providerEnvironmentId),
		[providerEnvironmentId, refresh, refreshFor],
	);
	const catalog = useModelCatalogStore((s) => s.catalog);
	const ensureCatalog = useModelCatalogStore((s) => s.ensureLoaded);
	const { providers: extensionProviderById } = useExtensionProviderCatalog();

	let userMessageCount = 0;
	if (!isDefault) {
		for (const message of timeline.messages) {
			if (message.role === "user") userMessageCount += 1;
		}
	}
	const isFresh = isDefault ? true : userMessageCount === 0;

	useEffect(() => {
		void ensureCatalog();
	}, [ensureCatalog]);

	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<Scope>("all");
	// Inline feedback for failed picks. The session-mode handlers
	// (createSession / setSessionProvider / setSessionModel) used to fire-
	// and-forget, so a failed provider startup just closed the popover with no
	// clue why.
	// We now await them and surface the reason here.
	const [pickError, setPickError] = useState<string | null>(null);
	const [picking, setPicking] = useState(false);
	const popupRef = useRef<HTMLDivElement | null>(null);

	// Forward open state to parent so ChatComposer can block Enter submit
	const onOpenChange = props.onOpenChange;
	useEffect(() => {
		onOpenChange?.(open);
	}, [open, onOpenChange]);

	// Reset transient state every time the popover opens.
	useEffect(() => {
		if (open) {
			setQuery("");
			setScope("all");
			setPickError(null);
			setPicking(false);
			if (!availabilityLoaded && !availabilityLoading) {
				void refreshAvailability();
			}
		}
	}, [open, availabilityLoaded, availabilityLoading, refreshAvailability]);

	const modelsForProvider = useCallback(
		(
			pid: ProviderId,
		): ReadonlyArray<Pick<ModelOption, "id" | "label" | "badgeLabel">> => {
			const extensionProvider = extensionProviderById.get(pid);
			const providerModels =
				extensionProvider?.models ?? catalogModelsForProvider(catalog, pid);
			const selectedId = pid === providerId ? currentModel : null;
			// Authoritative live inventories (Codex, Cursor, Kiro, OpenCode) mark
			// curated models the account can't use as unavailable; keep the
			// current selection visible so the user can see what they're on.
			const available = providerModels.filter(
				(m) =>
					!("available" in m) || m.available !== false || m.id === selectedId,
			);
			// OpenCode ids are `<provider>/<model>`. The provider manager lets the
			// user hide connected providers / individual models from the picker;
			// respect both here (missing entry ⇒ visible).
			const visible =
				pid === "opencode" || pid === "opencode2"
					? available.filter((m) => {
							const slash = m.id.indexOf("/");
							const opencodeProvider = slash > 0 ? m.id.slice(0, slash) : m.id;
							const providerVisible =
								pid === "opencode2"
									? opencode2ProviderVisible
									: opencodeProviderVisible;
							const modelVisible =
								pid === "opencode2"
									? opencode2ModelVisibleByProvider
									: opencodeModelVisibleByProvider;
							return (
								providerVisible[opencodeProvider] !== false &&
								modelVisible[opencodeProvider]?.[m.id] !== false
							);
						})
					: available;
			const existingIds = new Set(visible.map((m) => m.id));
			return [
				...visible.map((m) => ({
					id: m.id,
					label: m.label,
					...("badgeLabel" in m && m.badgeLabel !== undefined
						? { badgeLabel: m.badgeLabel }
						: {}),
				})),
				...(customModelIdsByProvider[pid] ?? [])
					.filter((modelId) => !existingIds.has(modelId))
					.map((modelId) => ({ id: modelId, label: modelId })),
			];
		},
		[
			catalog,
			currentModel,
			customModelIdsByProvider,
			extensionProviderById,
			opencodeProviderVisible,
			opencodeModelVisibleByProvider,
			opencode2ProviderVisible,
			opencode2ModelVisibleByProvider,
			providerId,
		],
	);

	const availabilityById = useMemo(() => {
		const m = new globalThis.Map<ProviderId, AgentAvailability>();
		for (const a of availability) m.set(a.providerId, a);
		return m;
	}, [availability, uiMessage]);

	const pickableProviders = useMemo<ReadonlyArray<ProviderId>>(() => {
		const candidates = [
			...catalogProviderIds(catalog),
			...extensionProviderById.keys(),
		];
		return [...new Set(candidates)].filter((pid) => {
			// Settings must keep the selected provider's catalog editable even when
			// its local runtime is signed out. Session pickers remain restricted to
			// providers that can actually start a session.
			if (isDefault && pid === providerId) return true;
			return isModelPickerProviderVisible({
				providerId: pid,
				availability: availabilityById.get(pid),
				providerEnabled,
				availabilityLoaded,
				revealBeforeAvailabilityLoaded: isDefault,
			});
		});
	}, [
		catalog,
		extensionProviderById,
		isDefault,
		providerId,
		providerEnabled,
		availabilityById,
		availabilityLoaded,
		availability,
		extensionProviderById,
		uiMessage,
	]);
	const allModels = useMemo<ModelPickerEntry[]>(() => {
		const out: ModelPickerEntry[] = [];
		for (const pid of pickableProviders) {
			for (const m of modelsForProvider(pid)) {
				const visible = isModelVisible(
					catalog,
					pid,
					m.id,
					modelEnabledByProvider,
				);
				const selectedHidden = pid === providerId && m.id === currentModel;
				if (!visible && !selectedHidden) continue;
				// The resolved catalog folds live context-window facts into the
				// descriptor, so one lookup covers curated and live models alike.
				let contextWindowLabel: string | undefined;
				{
					const descriptor = findModelDescriptor(catalog, pid, m.id);
					const ctxDescriptor = descriptor?.optionDescriptors?.find(
						(d): d is SelectOptionDescriptor =>
							d.kind === "select" && d.id === "contextWindow",
					);
					const ctxDefault = ctxDescriptor?.defaultId;
					const ctxLabel =
						ctxDescriptor !== undefined
							? ctxDescriptor.options.find((o) => o.id === ctxDefault)?.label
							: undefined;
					// Only surface a pill when the default is the larger window —
					// 200k-by-default rows would be noise.
					if (ctxDefault === "1m") {
						contextWindowLabel = ctxLabel ?? "1M";
					}
				}
				out.push({
					providerId: pid,
					modelId: m.id,
					label: m.label,
					...("badgeLabel" in m && m.badgeLabel !== undefined
						? { badgeLabel: m.badgeLabel }
						: {}),
					...(contextWindowLabel !== undefined ? { contextWindowLabel } : {}),
				});
			}
		}
		return out;
	}, [
		catalog,
		pickableProviders,
		modelsForProvider,
		modelEnabledByProvider,
		providerId,
		currentModel,
		uiMessage,
	]);

	const countByProvider = useMemo(() => {
		const map = new globalThis.Map<ProviderId, number>();
		for (const m of allModels) {
			map.set(m.providerId, (map.get(m.providerId) ?? 0) + 1);
		}
		return map;
	}, [allModels, uiMessage]);
	const totalCount = allModels.length;

	const flatMatches = useMemo<ModelPickerEntry[]>(() => {
		const q = query.trim().toLowerCase();
		return allModels.filter((m) => {
			if (scope !== "all" && m.providerId !== scope) return false;
			if (q === "") return true;
			return (
				m.label.toLowerCase().includes(q) || m.modelId.toLowerCase().includes(q)
			);
		});
	}, [allModels, scope, query, uiMessage]);

	const modelGroups = useMemo(() => {
		if (scope !== "all") return [];
		const order: ProviderId[] = [
			providerId,
			...pickableProviders.filter((p) => p !== providerId),
		];
		return order
			.map((pid) => ({
				providerId: pid,
				models: allModels.filter((m) => m.providerId === pid),
			}))
			.filter((g) => g.models.length > 0);
	}, [scope, allModels, pickableProviders, providerId, uiMessage]);

	const handlePick = async (pid: ProviderId, modelId: string) => {
		if (isDefault) {
			setDefaultProviderAndModel(pid, modelId);
			setOpen(false);
			return;
		}

		if (props.mode !== "session") return;
		const { environmentId, sessionId, chatId, runtimeMode } = props;

		const isCross = pid !== providerId;
		// Await whatever store call we kick off so we can keep the popover
		// open + show the reason if it fails. Previously these were `void`-d
		// and the popover always closed, swallowing SessionStartError from
		// a missing/broken CLI behind a silent close.
		setPickError(null);
		setPicking(true);
		try {
			if (isCross && !isFresh && chatId !== undefined) {
				const newId = await createSession(chatId, pid, modelId, {
					runtimeMode,
				});
				if (newId === null) {
					const reason =
						useSessionsStore.getState().error ??
						`Couldn't start ${pid}. Check that its CLI is installed and signed in.`;
					setPickError(reason);
					return;
				}
			} else if (isCross) {
				const result = await setSessionProvider(
					sessionId,
					pid,
					modelId,
					environmentId,
				);
				if (!result.ok) {
					setPickError(result.reason);
					return;
				}
			} else if (modelId !== currentModel) {
				await setSessionModel(sessionId, modelId, environmentId);
				const reason = useSessionsStore.getState().error;
				if (reason !== null) {
					setPickError(reason);
					return;
				}
			}
			setOpen(false);
		} finally {
			setPicking(false);
		}
	};

	const currentLabel =
		modelsForProvider(providerId).find((m) => m.id === currentModel)?.label ??
		currentModel;
	const triggerLabel = composer
		? compactModelLabel(currentLabel)
		: currentLabel;

	const showEmpty = flatMatches.length === 0 && modelGroups.length === 0;

	const inGroupedView = scope === "all" && query.trim() === "";

	const shortcutTargets = useMemo<ModelPickerEntry[]>(() => {
		const out: ModelPickerEntry[] = [];
		if (inGroupedView) {
			for (const group of modelGroups) out.push(...group.models);
		} else {
			out.push(...flatMatches);
		}
		return out;
	}, [inGroupedView, modelGroups, flatMatches, uiMessage]);

	// STABLE REFS — this is the fix so shortcuts actually work while the
	// composer editor is focused and causing re-renders.
	const shortcutTargetsRef = useRef(shortcutTargets);
	const handlePickRef = useRef(handlePick);
	useEffect(() => {
		shortcutTargetsRef.current = shortcutTargets;
	}, [shortcutTargets]);
	useEffect(() => {
		handlePickRef.current = handlePick;
	}, [handlePick]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey)) return;
			if (e.altKey || e.shiftKey) return;
			if (e.key < "1" || e.key > "9") return;
			const idx = Number(e.key) - 1;
			const target = shortcutTargetsRef.current[idx];
			if (target === undefined) return;
			e.preventDefault();
			e.stopPropagation();
			void handlePickRef.current(target.providerId, target.modelId);
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [open]);

	const shortcutFor = (pid: ProviderId, modelId: string): number | null => {
		const i = shortcutTargets.findIndex(
			(t) => t.providerId === pid && t.modelId === modelId,
		);
		if (i < 0 || i >= 9) return null;
		return i + 1;
	};

	const trigger = (
		<PopoverTrigger
			className={cn(
				composer
					? "flex h-7 w-40 max-w-[40vw] items-center gap-1.5 rounded-full bg-muted/65 px-2.5 text-[11px] font-medium text-foreground hover:bg-muted data-[popup-open]:bg-muted"
					: "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-foreground hover:bg-muted/60 data-[popup-open]:bg-muted/60",
				props.triggerClassName,
			)}
			aria-label={uiMessage("providers:model_picker_change_model")}
			title={
				isDefault
					? uiMessage(
							"providers:model_picker_change_default_model_for_new_chats",
						)
					: uiMessage(
							"providers:model_picker_change_model_applies_to_next_message",
						)
			}
		>
			<ProviderIcon providerId={providerId} className="size-3 shrink-0" />
			<span className="min-w-0 flex-1 truncate text-left">{triggerLabel}</span>
			{triggerDetail !== undefined ? (
				<span className="shrink-0 capitalize text-muted-foreground">
					{triggerDetail}
				</span>
			) : null}
			<ChevronDown className="size-3 shrink-0 opacity-60" />
		</PopoverTrigger>
	);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			{trigger}
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Positioner
					align="start"
					side="top"
					sideOffset={6}
					className="z-50"
				>
					<PopoverPrimitive.Popup
						ref={popupRef}
						className={cn(
							"flex max-h-[480px] w-[380px] overflow-hidden outline-none",
							overlaySurface,
						)}
					>
						<div
							role="tablist"
							aria-label={uiMessage("providers:model_picker_model_provider")}
							className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border/50 bg-muted/20 p-1.5"
						>
							<ProviderSidebarItem
								active={scope === "all"}
								onClick={() => setScope("all")}
								label={uiMessage("providers:model_picker_all_models")}
								count={totalCount}
							/>
							{pickableProviders.map((pid) => {
								const live = catalog.providers[pid]?.live.status === "ok";
								return (
									<ProviderSidebarItem
										key={pid}
										active={scope === pid}
										onClick={() => setScope(pid)}
										providerId={pid}
										label={
											PROVIDER_CHIP_LABEL[pid] ??
											extensionProviderById.get(pid)?.displayName ??
											pid
										}
										count={countByProvider.get(pid) ?? 0}
										live={live}
									/>
								);
							})}
						</div>

						<div className="flex min-w-0 flex-1 flex-col">
							<div className="border-b border-border/50 p-2.5">
								<SearchField
									value={query}
									onChange={setQuery}
									totalCount={totalCount}
									scope={scope}
								/>
							</div>

							{pickError !== null && (
								<div className="mx-2.5 mt-2 flex items-start gap-2 rounded-md border border-rose-400/30 bg-rose-500/[0.08] px-2.5 py-2 text-[11px] text-rose-200">
									<span className="mt-px shrink-0">⚠</span>
									<span className="leading-snug">{pickError}</span>
								</div>
							)}

							<div
								className={cn(
									"min-h-0 flex-1 overflow-y-auto px-2.5 pb-2.5",
									picking && "pointer-events-none opacity-60",
								)}
							>
								{showEmpty && (
									<div
										className="px-3 py-6 text-center text-muted-foreground text-xs"
										role="status"
										aria-live="polite"
									>
										{availabilityLoading || !availabilityLoaded
											? uiMessage(
													"providers:model_picker_checking_available_agents",
												)
											: isDefault
												? uiMessage("providers:model_picker_no_models_match")
												: uiMessage(
														"providers:model_picker_no_authenticated_agents",
													)}
									</div>
								)}

								{inGroupedView ? (
									<>
										<SectionLabel
											title={uiMessage("providers:model_picker_models")}
										/>
										{modelGroups.map((g) => (
											<div
												key={g.providerId}
												className="border-t border-border/50 py-2 first:border-t-0 first:pt-0"
											>
												<ProviderSectionHeader
													providerId={g.providerId}
													count={g.models.length}
													current={g.providerId === providerId}
												/>
												<div className="flex flex-col gap-0.5">
													{g.models.map((m) => (
														<ModelRow
															key={`${m.providerId}-${m.modelId}`}
															entry={m}
															currentProviderId={providerId}
															currentModelId={currentModel}
															isFresh={isFresh}
															onSelect={handlePick}
															defaultProviderId={defaultProviderId}
															defaultModelByProvider={defaultModelByProvider}
															onSetDefault={setDefaultProviderAndModel}
															shortcut={shortcutFor(m.providerId, m.modelId)}
														/>
													))}
												</div>
											</div>
										))}
									</>
								) : (
									flatMatches.length > 0 && (
										<>
											<SectionLabel
												title={
													scope === "all"
														? uiMessage("providers:model_picker_match", {
																value1: String(flatMatches.length),
																value2: String(
																	flatMatches.length === 1 ? "" : "es",
																),
															})
														: uiMessage("providers:model_picker_model", {
																value1: String(flatMatches.length),
																value2: String(
																	flatMatches.length === 1 ? "" : "s",
																),
															})
												}
											/>
											<div className="flex flex-col gap-0.5">
												{flatMatches.map((m) => (
													<ModelRow
														key={`${m.providerId}-${m.modelId}`}
														entry={m}
														currentProviderId={providerId}
														currentModelId={currentModel}
														isFresh={isFresh}
														onSelect={handlePick}
														defaultProviderId={defaultProviderId}
														defaultModelByProvider={defaultModelByProvider}
														onSetDefault={setDefaultProviderAndModel}
														shortcut={shortcutFor(m.providerId, m.modelId)}
														showProvider={scope === "all"}
													/>
												))}
											</div>
										</>
									)
								)}
							</div>
							{optionsPanel !== undefined ? (
								<div className="shrink-0 border-t border-border/50 bg-muted/15 p-2.5">
									{optionsPanel}
								</div>
							) : null}
						</div>
					</PopoverPrimitive.Popup>
				</PopoverPrimitive.Positioner>
			</PopoverPrimitive.Portal>
		</Popover>
	);
}

function SearchField({
	value,
	onChange,
	totalCount,
	scope,
}: {
	value: string;
	onChange: (next: string) => void;
	totalCount: number;
	scope: Scope;
}) {
	const providerName = useProviderDisplayName(scope === "all" ? null : scope);
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => inputRef.current?.focus(), []);
	const placeholder =
		scope === "all" ? `Search ${totalCount} models` : `in ${providerName}…`;
	return (
		<div className="flex h-8 items-center gap-2 rounded-md border bg-background px-2.5 focus-within:border-foreground/60 focus-within:ring-2 focus-within:ring-primary/30">
			<HugeiconsIcon
				icon={Search01Icon}
				className="size-3.5 text-muted-foreground"
			/>
			<input
				ref={inputRef}
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
			/>
		</div>
	);
}

function ProviderSidebarItem({
	active,
	onClick,
	label,
	providerId,
	live = false,
}: {
	active: boolean;
	onClick: () => void;
	label: string;
	count: number;
	providerId?: ProviderId;
	live?: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["providers"]);

	const title = `${label} models`;
	return (
		<button
			type="button"
			onClick={onClick}
			role="tab"
			aria-selected={active}
			aria-label={title}
			title={title}
			className={cn(
				"relative flex size-8 shrink-0 items-center justify-center rounded-md text-[11px] transition-colors",
				active
					? "bg-primary/12 text-foreground ring-1 ring-primary/20"
					: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
			)}
		>
			{providerId !== undefined ? (
				<ProviderIcon providerId={providerId} className="size-3.5 shrink-0" />
			) : (
				<span className="font-semibold">
					{uiMessage("providers:model_picker_all")}
				</span>
			)}
			{live && (
				<span
					className="absolute right-1 bottom-1 size-1.5 rounded-full bg-primary"
					title={uiMessage("providers:model_picker_live_from_local_daemon")}
				/>
			)}
		</button>
	);
}

function ProviderSectionHeader({
	providerId,
	count,
	current,
}: {
	providerId: ProviderId;
	count: number;
	current: boolean;
}) {
	const providerName = useProviderDisplayName(providerId);
	const { message: uiMessage } = useUiMessages(["providers"]);

	return (
		<div className="flex items-center gap-2 px-2 pt-1.5 pb-1 text-xs">
			<ProviderIcon providerId={providerId} className="size-3.5" />
			<span className="font-medium text-foreground">{providerName}</span>
			{current && (
				<span className="rounded-[0.25rem] bg-primary/35 px-1.5 py-px text-[9px] font-semibold text-primary-foreground uppercase tracking-wide dark:bg-primary/15 dark:text-primary">
					{uiMessage("providers:model_picker_current")}
				</span>
			)}
			<span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
				{count}
			</span>
		</div>
	);
}

function SectionLabel({ title }: { title: string }) {
	return (
		<div className="px-2 pt-3 pb-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
			<span>{title}</span>
		</div>
	);
}

function ModelRow({
	entry,
	currentProviderId,
	currentModelId,
	defaultProviderId,
	defaultModelByProvider,
	isFresh,
	onSelect,
	onSetDefault,
	dense = false,
	shortcut,
	showProvider = false,
}: {
	entry: ModelPickerEntry;
	currentProviderId: ProviderId;
	currentModelId: string;
	defaultProviderId: ProviderId;
	defaultModelByProvider: Record<ProviderId, string>;
	isFresh: boolean;
	onSelect: (providerId: ProviderId, modelId: string) => void;
	onSetDefault: (providerId: ProviderId, modelId: string) => void;
	dense?: boolean;
	shortcut?: number | null;
	showProvider?: boolean;
}) {
	const providerName = useProviderDisplayName(entry.providerId);
	const { message: uiMessage } = useUiMessages(["providers"]);

	const isActive =
		entry.providerId === currentProviderId && entry.modelId === currentModelId;
	const isDefault =
		entry.providerId === defaultProviderId &&
		defaultModelByProvider[entry.providerId] === entry.modelId;
	const isCross = entry.providerId !== currentProviderId;
	const opensNewTab = isCross && !isFresh;
	const select = () => onSelect(entry.providerId, entry.modelId);
	const onRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		select();
	};
	const setDefault = (event: ReactMouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		event.stopPropagation();
		onSetDefault(entry.providerId, entry.modelId);
	};
	return (
		// biome-ignore lint/a11y/useSemanticElements: the row contains a separate nested star action, which cannot live inside a button.
		<div
			role="button"
			tabIndex={0}
			onClick={select}
			onKeyDown={onRowKeyDown}
			aria-current={isActive || undefined}
			title={
				opensNewTab
					? uiMessage("providers:model_picker_open_in_new_tab")
					: undefined
			}
			className={cn(
				"group relative flex min-h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs transition-colors",
				dense ? "py-1" : "py-1.5",
				isActive
					? "bg-primary/12 text-foreground ring-1 ring-primary/20"
					: "text-foreground hover:bg-muted/60",
			)}
		>
			{isActive && (
				<span className="-translate-y-1/2 absolute top-1/2 left-0 h-4 w-0.5 rounded-full bg-primary" />
			)}
			{!dense && (
				<ProviderIcon
					providerId={entry.providerId}
					className="size-4 shrink-0 text-muted-foreground"
				/>
			)}
			{/* Name + optional provider subtitle. Chips live outside this column so
			    two-line recent rows don't pull 1M / credit badges off the row center. */}
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="min-w-0 font-medium break-words leading-snug">
					{entry.label}
				</span>
				{showProvider && (
					<span className="truncate text-[11px] text-muted-foreground">
						{providerName}
					</span>
				)}
			</span>
			{(entry.contextWindowLabel !== undefined ||
				entry.badgeLabel !== undefined) && (
				<span className="flex shrink-0 items-center gap-1.5">
					{entry.contextWindowLabel !== undefined && (
						<span
							title={uiMessage("providers:model_picker_context_window", {
								value1: String(entry.contextWindowLabel),
							})}
							className="rounded-[0.25rem] bg-muted px-1.5 py-px text-[10px] font-medium text-foreground/70 dark:bg-muted/70 dark:px-1 dark:text-muted-foreground"
						>
							{entry.contextWindowLabel}
						</span>
					)}
					{entry.badgeLabel !== undefined && (
						<span
							title={
								/^\d+(\.\d+)?×$/.test(entry.badgeLabel)
									? uiMessage("providers:model_picker_credit_multiplier", {
											value1: String(entry.badgeLabel),
										})
									: entry.badgeLabel
							}
							className="rounded-[0.25rem] bg-primary/35 px-1.5 py-px text-[9px] font-semibold text-primary-foreground uppercase tracking-wide dark:bg-primary/15 dark:text-primary"
						>
							{entry.badgeLabel}
						</span>
					)}
				</span>
			)}
			<Tooltip>
				<TooltipTrigger
					type="button"
					onClick={setDefault}
					onKeyDown={(event) => event.stopPropagation()}
					aria-label={
						isDefault
							? uiMessage("providers:model_picker_default_model")
							: uiMessage("providers:model_picker_make_default_model")
					}
					title={undefined}
					className={cn(
						"flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
						isDefault
							? "text-primary opacity-100"
							: "opacity-0 group-hover:opacity-70 group-focus-within:opacity-70 hover:opacity-100",
					)}
				>
					<HugeiconsIcon icon={StarIcon} className="size-3.5" />
				</TooltipTrigger>
				<TooltipPopup side="top">
					{isDefault
						? uiMessage("providers:model_picker_default_model")
						: uiMessage("providers:model_picker_make_default")}
				</TooltipPopup>
			</Tooltip>
			{opensNewTab && (
				<HugeiconsIcon
					icon={ArrowUpRight01Icon}
					className="size-3 text-muted-foreground/70"
					aria-label={uiMessage("providers:model_picker_open_in_new_tab")}
				/>
			)}
			{isActive && (
				<HugeiconsIcon
					icon={Tick01Icon}
					className="size-3.5 shrink-0 text-primary"
					aria-label={uiMessage("providers:model_picker_selected")}
				/>
			)}
			{shortcut !== undefined && shortcut !== null && (
				<kbd className="ml-0.5 flex h-5 min-w-5 items-center justify-center rounded-[0.25rem] bg-muted px-1 font-medium text-[10px] text-foreground/70 tabular-nums dark:h-auto dark:min-w-0 dark:bg-muted/70 dark:text-muted-foreground">
					{shortcut}
				</kbd>
			)}
		</div>
	);
}
