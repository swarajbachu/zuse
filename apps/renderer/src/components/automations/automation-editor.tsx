import {
	type Automation,
	type AutomationCapabilities,
	AutomationConfig,
	type CloudProviderOption,
	defaultModelFor,
	PROVIDER_IDS,
	type ProviderId,
	type RuntimeMode,
	SessionId,
} from "@zuse/contracts";
import { automationPolicyIssues } from "@zuse/utils/automation-policy";
import { Schema } from "effect";
import { useId, useMemo, useRef, useState } from "react";
import { ACTION_META } from "~/lib/automation-format.ts";
import {
	cloudProviderLabel,
	orderedCloudProviders,
} from "~/lib/cloud-provider-presentation.ts";
import { useActiveEnvironmentEntities } from "~/lib/environment-entity-hooks.ts";
import { formatError } from "~/lib/format-error.ts";
import { PROVIDER_LABEL } from "~/lib/provider-labels.ts";
import { useSettingsStore } from "~/lib/settings-client-bus.ts";
import { cn } from "~/lib/utils";
import {
	currentModelCatalog,
	useProviderModels,
} from "~/store/model-catalog.ts";
import { ProviderIcon } from "../provider-icons.tsx";
import { MODE_META, MODES_ORDER } from "../runtime-mode-meta.ts";
import { Button } from "../ui/button.tsx";
import {
	Sheet,
	SheetBody,
	SheetFooter,
	SheetHeader,
	SheetPopup,
	SheetTitle,
} from "../ui/sheet.tsx";
import { Switch } from "../ui/switch.tsx";
import { Textarea } from "../ui/textarea.tsx";
import {
	AutomationField,
	AutomationSection,
	AutomationSelect,
} from "./automation-controls.tsx";
import {
	FieldError,
	issuesFor,
	type MetadataRow,
	MoreOptions,
	PolicyIssues,
} from "./automation-editor-sections.tsx";
import {
	AddTriggerMenu,
	AutomationTriggerCard,
	scheduleError,
} from "./automation-trigger-editor.tsx";

const LOCAL_MACHINE = "local";

const metadataRows = (metadata: Readonly<Record<string, string>>) =>
	Object.entries(metadata).map(([key, value]) => ({
		id: crypto.randomUUID(),
		key,
		value,
	}));

/** Field problems the schema or server would reject regardless of policy. */
function formErrors(
	config: AutomationConfig,
	metadata: ReadonlyArray<MetadataRow>,
): Partial<Record<string, string>> {
	const errors: Partial<Record<string, string>> = {};
	if (!config.name.trim()) errors.name = "Name the automation.";
	if (!config.prompt.trim())
		errors.prompt = "Describe what the agent should do.";
	if (config.triggers.length === 0)
		errors.triggers = "Add at least one trigger.";
	config.triggers.forEach((trigger, index) => {
		const issue =
			scheduleError(trigger) ??
			((trigger._tag === "github" || trigger._tag === "slack") &&
			trigger.events.length === 0
				? "Choose at least one event."
				: null);
		if (issue) errors[`trigger-${index}`] = issue;
	});
	if (!config.model.trim()) errors.model = "Choose a model.";
	config.notifications.forEach((notification, index) => {
		if (!notification.destination.trim())
			errors[`notification-${index}`] =
				notification.channel === "email"
					? "Enter an email address."
					: "Enter a Slack channel ID.";
	});
	const keys = new Set<string>();
	for (const row of metadata) {
		const key = row.key.trim();
		if (!key && !row.value.trim()) continue;
		if (!key || keys.has(key)) {
			errors.metadata = key
				? `Metadata key “${key}” is duplicated.`
				: "Every metadata value needs a key.";
			break;
		}
		keys.add(key);
	}
	if (
		config.spendLimitUsd !== null &&
		!(Number.isFinite(config.spendLimitUsd) && config.spendLimitUsd > 0)
	)
		errors.spendLimit = "Enter a positive amount, or leave it blank.";
	if (
		!Number.isInteger(config.rateLimit.count) ||
		config.rateLimit.count < 1 ||
		config.rateLimit.count > 10000
	)
		errors.rateLimit = "Allow between 1 and 10,000 runs.";
	if (
		!Number.isInteger(config.queue.maxConcurrency) ||
		config.queue.maxConcurrency < 1 ||
		config.queue.maxConcurrency > 20
	)
		errors.queue = "Allow between 1 and 20 concurrent runs.";
	return errors;
}

export function AutomationEditor({
	initial,
	record,
	onClose,
	onSave,
	capabilities,
	cloudProviders,
}: {
	initial: AutomationConfig;
	capabilities: AutomationCapabilities | null;
	/** Sandbox providers this account can start cloud agents on. */
	cloudProviders: ReadonlyArray<CloudProviderOption>;
	record?: Automation;
	onClose: () => void;
	onSave: (
		config: AutomationConfig,
		record?: Automation,
		requestId?: string,
	) => Promise<void>;
}) {
	const id = useId();
	const [config, setConfig] = useState(initial);
	// Triggers have no identity; stable keys keep per-trigger drafts in place.
	const [triggerKeys, setTriggerKeys] = useState<string[]>(() =>
		initial.triggers.map(() => crypto.randomUUID()),
	);
	const [metadata, setMetadata] = useState<MetadataRow[]>(() =>
		metadataRows(initial.metadata),
	);
	const [initialMetadata] = useState(metadata);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [attempted, setAttempted] = useState(false);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const creationRequest = useRef<{ fingerprint: string; id: string } | null>(
		null,
	);
	const body = useRef<HTMLDivElement>(null);
	const nameInput = useRef<HTMLInputElement>(null);
	const { folders, sessionsByProject } = useActiveEnvironmentEntities();
	const providerEnabled = useSettingsStore((state) => state.providerEnabled);
	const modelEnabled = useSettingsStore(
		(state) => state.modelEnabledByProvider[config.providerId],
	);
	const customModels = useSettingsStore(
		(state) => state.customModelIdsByProvider[config.providerId],
	);
	const catalogModels = useProviderModels(config.providerId);
	const patch = (value: Partial<AutomationConfig>) => {
		setError(null);
		setConfig((current) => ({ ...current, ...value }));
	};
	const setTriggers = (
		triggers: AutomationConfig["triggers"],
		keys: ReadonlyArray<string>,
	) => {
		setTriggerKeys([...keys]);
		patch({ triggers });
	};
	const metadataRecord = () =>
		Object.fromEntries(
			metadata
				.filter((row) => row.key.trim() || row.value.trim())
				.map((row) => [row.key.trim(), row.value]),
		);
	const dirty =
		JSON.stringify(config) !== JSON.stringify(initial) ||
		JSON.stringify(metadata) !== JSON.stringify(initialMetadata);

	const issues = useMemo(
		() =>
			capabilities
				? automationPolicyIssues(config, {
						environment: capabilities.environment,
						emailNotifications: capabilities.emailNotifications,
						cloudMachines: capabilities.cloudMachines ?? false,
					})
				: [],
		[capabilities, config],
	);
	const errors = formErrors(config, metadata);
	const shown = (key: string) => (attempted ? errors[key] : undefined);

	const existingSession = config.action === "existing_session";
	const restrictionReason = (
		providers: ReadonlyArray<ProviderId> | undefined,
		feature: string,
	): string | null => {
		if (!providers) return "Checking availability…";
		if (providers.length === 0) return "Unavailable in this environment.";
		if (!providers.includes(config.providerId))
			return `${feature} only for ${providers.map((provider) => PROVIDER_LABEL[provider]).join(" or ")}.`;
		if (existingSession) return `${feature} only for new sessions.`;
		if (config.allowChildSessions)
			return `${feature} needs child sessions turned off.`;
		return null;
	};
	const spendReason = restrictionReason(
		capabilities?.spendLimitProviders,
		"Available",
	);

	const sessions = (sessionsByProject[config.projectId] ?? []).filter(
		(session) => session.archivedAt === null || session.id === config.sessionId,
	);
	const providerOptions = PROVIDER_IDS.filter(
		(provider) =>
			providerEnabled[provider] !== false || provider === config.providerId,
	).map((provider) => ({
		value: provider,
		label: PROVIDER_LABEL[provider],
		icon: <ProviderIcon providerId={provider} />,
	}));
	const modelOptions = [
		...catalogModels
			.filter(
				(model) =>
					modelEnabled?.[model.id] !== false || model.id === config.model,
			)
			.map((model) => ({ value: model.id, label: model.label })),
		...(customModels ?? []).map((model) => ({ value: model, label: model })),
	];
	if (
		config.model &&
		!modelOptions.some((model) => model.value === config.model)
	)
		modelOptions.unshift({ value: config.model, label: config.model });
	const modeOptions = [
		...MODES_ORDER,
		...(MODES_ORDER.includes(config.runtimeMode) ? [] : [config.runtimeMode]),
	].map((mode) => ({
		value: mode,
		label: MODE_META[mode].label,
	}));
	const slackOnly =
		config.triggers.length > 0 &&
		config.triggers.every((trigger) => trigger._tag === "slack");
	const actionOptions = (
		Object.keys(ACTION_META) as Array<AutomationConfig["action"]>
	).map((action) => ({
		value: action,
		label: ACTION_META[action].label,
		...(action === "auto_triage" && !slackOnly
			? { description: "Slack triggers only" }
			: {}),
		disabled:
			action === "auto_triage" && !slackOnly && config.action !== action,
	}));

	const setAction = (action: AutomationConfig["action"]) =>
		patch(
			action === "existing_session"
				? {
						action,
						// Existing sessions keep their own delegation policy and tools.
						allowChildSessions: true,
						spendLimitUsd: null,
						mcpServerIds: [],
					}
				: { action, sessionId: null },
		);
	const setSession = (sessionId: string) => {
		const session = sessions.find((candidate) => candidate.id === sessionId);
		if (!session) return;
		patch({
			sessionId: SessionId.make(session.id),
			providerId: session.providerId,
			model: session.model,
			runtimeMode: session.runtimeMode,
		});
	};
	const machine = config.cloudMachine ?? null;
	const machineOptions = [
		{ value: LOCAL_MACHINE, label: "This computer" },
		...orderedCloudProviders(cloudProviders).map((provider) => ({
			value: provider.providerId,
			label: cloudProviderLabel(provider.providerId),
		})),
		...(machine &&
		!cloudProviders.some(
			(provider) => provider.providerId === machine.providerId,
		)
			? [
					{
						value: machine.providerId,
						label: `${cloudProviderLabel(machine.providerId)} (unavailable)`,
					},
				]
			: []),
	];
	const showMachine =
		Boolean(capabilities?.cloudMachines && cloudProviders.length > 0) ||
		machine !== null;
	const setMachine = (value: string) =>
		patch(
			value === LOCAL_MACHINE
				? { cloudMachine: null }
				: {
						cloudMachine: {
							providerId: value,
							fallback: machine?.fallback ?? true,
						},
						// Cloud agents manage their own child sessions and tools.
						allowChildSessions: true,
						spendLimitUsd: null,
						mcpServerIds: [],
					},
		);
	const setProvider = (providerId: ProviderId) =>
		patch({
			providerId,
			model:
				useSettingsStore.getState().defaultModelByProvider[providerId] ??
				defaultModelFor(currentModelCatalog(), providerId),
		});

	const close = () => {
		if (saving) return;
		if (dirty && !confirmDiscard) {
			setConfirmDiscard(true);
			return;
		}
		onClose();
	};
	const revealProblem = () =>
		requestAnimationFrame(() =>
			body.current
				?.querySelector("[role=alert], [data-slot=automation-notice]")
				?.scrollIntoView({ behavior: "smooth", block: "center" }),
		);
	const blocked =
		Object.keys(errors).length > 0
			? "Fix the highlighted fields to save."
			: config.enabled && issues.length > 0
				? "This environment cannot enforce some settings. Resolve them, or turn off Enabled to save a paused draft."
				: null;
	const footerError = error ?? (attempted ? blocked : null);
	const save = async () => {
		setAttempted(true);
		setError(null);
		if (blocked) {
			revealProblem();
			return;
		}
		setSaving(true);
		try {
			const validated = Schema.decodeUnknownSync(AutomationConfig)({
				...config,
				metadata: metadataRecord(),
			});
			const fingerprint = JSON.stringify(validated);
			if (creationRequest.current?.fingerprint !== fingerprint)
				creationRequest.current = { fingerprint, id: crypto.randomUUID() };
			await onSave(
				validated,
				record,
				record ? undefined : creationRequest.current.id,
			);
		} catch (cause) {
			setError(formatError(cause));
		} finally {
			setSaving(false);
		}
	};

	const triggerSection = (
		<AutomationSection
			id={`${id}-triggers`}
			title="Triggers"
			action={
				<AddTriggerMenu
					onAdd={(trigger) =>
						setTriggers(
							[...config.triggers, trigger],
							[...triggerKeys, crypto.randomUUID()],
						)
					}
				/>
			}
		>
			{config.triggers.length === 0 ? (
				<p className="rounded-lg bg-muted/30 px-3 py-3 text-muted-foreground">
					Add a schedule, an event, or a manual trigger.
				</p>
			) : (
				<ol className="space-y-1.5">
					{config.triggers.map((trigger, index) => (
						<li key={triggerKeys[index] ?? index}>
							<AutomationTriggerCard
								trigger={trigger}
								index={index}
								webhook={record?.webhook}
								saved={Boolean(record)}
								environment={capabilities?.environment ?? null}
								onChange={(replacement) =>
									patch({
										triggers: config.triggers.map((item, position) =>
											position === index ? replacement : item,
										),
									})
								}
								onRemove={() =>
									setTriggers(
										config.triggers.filter((_, position) => position !== index),
										triggerKeys.filter((_, position) => position !== index),
									)
								}
							/>
						</li>
					))}
				</ol>
			)}
			<FieldError message={shown("triggers")} />
		</AutomationSection>
	);

	const agentSection = (
		<AutomationSection id={`${id}-agent`} title="Instructions">
			<Textarea
				id={`${id}-prompt`}
				aria-labelledby={`${id}-agent`}
				aria-invalid={shown("prompt") ? true : undefined}
				className="min-h-28 text-xs"
				value={config.prompt}
				onChange={(event) => patch({ prompt: event.target.value })}
				placeholder="What should the agent do each time this runs?"
			/>
			<FieldError message={shown("prompt")} />
			<div className="grid grid-cols-2 gap-x-3 gap-y-2.5 pt-1">
				{showMachine && (
					<>
						<AutomationField label="Runs on" htmlFor={`${id}-machine`}>
							<AutomationSelect
								id={`${id}-machine`}
								label="Runs on"
								value={machine?.providerId ?? LOCAL_MACHINE}
								options={machineOptions}
								onChange={setMachine}
							/>
						</AutomationField>
						{machine ? (
							<AutomationField
								label="If unavailable"
								htmlFor={`${id}-fallback`}
							>
								<label
									htmlFor={`${id}-fallback`}
									className="flex h-7 items-center justify-between gap-2"
								>
									<span aria-hidden>
										{machine.fallback ? "Try another provider" : "Fail the run"}
									</span>
									<Switch
										id={`${id}-fallback`}
										aria-label="Fall back to another provider"
										checked={machine.fallback}
										onCheckedChange={(fallback) =>
											patch({ cloudMachine: { ...machine, fallback } })
										}
									/>
								</label>
							</AutomationField>
						) : (
							<div />
						)}
					</>
				)}
				<AutomationField label="Action" htmlFor={`${id}-action`}>
					<AutomationSelect
						id={`${id}-action`}
						label="Action"
						value={config.action}
						options={actionOptions}
						onChange={setAction}
					/>
				</AutomationField>
				{existingSession ? (
					<AutomationField label="Session" htmlFor={`${id}-session`}>
						<AutomationSelect
							id={`${id}-session`}
							label="Session"
							value={config.sessionId ?? ""}
							disabled={sessions.length === 0}
							options={[
								...(config.sessionId
									? []
									: [
											{
												value: "",
												label:
													sessions.length === 0
														? "No sessions yet"
														: "Choose a session…",
												disabled: true,
											},
										]),
								...sessions.map((session) => ({
									value: session.id as string,
									label: session.title || "Untitled session",
									icon: <ProviderIcon providerId={session.providerId} />,
								})),
							]}
							onChange={setSession}
						/>
					</AutomationField>
				) : (
					<AutomationField label="Agent" htmlFor={`${id}-provider`}>
						<AutomationSelect
							id={`${id}-provider`}
							label="Agent"
							value={config.providerId}
							options={providerOptions}
							onChange={setProvider}
						/>
					</AutomationField>
				)}
				<AutomationField label="Model" htmlFor={`${id}-model`}>
					<AutomationSelect
						id={`${id}-model`}
						label="Model"
						value={config.model}
						disabled={existingSession}
						options={modelOptions}
						onChange={(model) => patch({ model })}
					/>
				</AutomationField>
				<AutomationField label="Permissions" htmlFor={`${id}-mode`}>
					<AutomationSelect
						id={`${id}-mode`}
						label="Permissions"
						value={config.runtimeMode}
						disabled={existingSession}
						options={modeOptions}
						onChange={(runtimeMode: RuntimeMode) => patch({ runtimeMode })}
					/>
				</AutomationField>
			</div>
			<FieldError message={shown("model")} />
			<PolicyIssues
				issues={issuesFor(issues, "machine", "action", "session", "runAs")}
			/>
		</AutomationSection>
	);

	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<SheetPopup
				showCloseButton={false}
				initialFocus={record ? undefined : nameInput}
			>
				<SheetHeader className="border-b border-border/60 pb-3">
					<SheetTitle className="min-w-0 flex-1 truncate">
						{record ? "Edit automation" : "New automation"}
					</SheetTitle>
					<label
						htmlFor={`${id}-enabled`}
						className="flex items-center gap-2 text-xs text-muted-foreground"
					>
						<span aria-hidden>{config.enabled ? "On" : "Off"}</span>
						<Switch
							id={`${id}-enabled`}
							aria-label="Enabled"
							checked={config.enabled}
							onCheckedChange={(enabled) => patch({ enabled })}
						/>
					</label>
				</SheetHeader>
				<SheetBody className="pt-4">
					<div ref={body} className="space-y-6 text-xs">
						<div className="space-y-0.5">
							<input
								aria-label="Automation name"
								aria-invalid={shown("name") ? true : undefined}
								placeholder="Untitled automation"
								className="h-8 w-full bg-transparent text-base font-medium outline-none placeholder:text-muted-foreground/60"
								value={config.name}
								ref={nameInput}
								onChange={(event) => patch({ name: event.target.value })}
							/>
							<input
								aria-label="Description"
								placeholder="Add a description"
								className="h-6 w-full bg-transparent text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/50"
								value={config.description}
								onChange={(event) => patch({ description: event.target.value })}
							/>
							<FieldError message={shown("name")} />
						</div>
						{triggerSection}
						{agentSection}
						<MoreOptions
							config={config}
							patch={patch}
							issues={issues}
							capabilities={capabilities}
							shown={shown}
							spendReason={spendReason}
							metadata={metadata}
							setMetadata={setMetadata}
							folders={folders}
							onLeave={onClose}
						/>
					</div>
				</SheetBody>
				<SheetFooter>
					{confirmDiscard ? (
						<>
							<p className="min-w-0 flex-1 text-xs" role="alert">
								Discard unsaved changes?
							</p>
							<Button
								className="h-7"
								variant="ghost"
								onClick={() => setConfirmDiscard(false)}
							>
								Keep editing
							</Button>
							<Button className="h-7" variant="destructive" onClick={onClose}>
								Discard
							</Button>
						</>
					) : (
						<>
							<p
								className={cn(
									"min-w-0 flex-1 truncate text-[11px]",
									footerError ? "text-destructive" : "text-muted-foreground",
								)}
								title={footerError ?? undefined}
								role={footerError ? "alert" : undefined}
								aria-live="polite"
							>
								{footerError ??
									(issues.length > 0
										? "Some settings need attention before this can run."
										: "")}
							</p>
							<Button
								className="h-7"
								variant="ghost"
								disabled={saving}
								onClick={close}
							>
								Cancel
							</Button>
							<Button
								className="h-7"
								loading={saving}
								onClick={() => void save()}
							>
								{record ? "Save" : "Create"}
							</Button>
						</>
					)}
				</SheetFooter>
			</SheetPopup>
		</Sheet>
	);
}
