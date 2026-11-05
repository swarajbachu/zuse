import { HugeiconsIcon } from "@hugeicons/react";
import {
	type Automation,
	type AutomationCapabilities,
	type AutomationConfig,
	type AutomationTemplate,
	type CloudProviderOption,
	defaultModelFor,
	type FolderId,
} from "@zuse/contracts";
import {
	AiChat02Icon,
	Copy01Icon,
	DashboardSquare01Icon,
	Delete02Icon,
	MoreHorizontalIcon,
	PencilEdit02Icon,
	PlayIcon,
	PlusSignIcon,
	Search01Icon,
	SparklesIcon,
	Time04Icon,
} from "@zuse/icons/solid-rounded";
import {
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { automationClient } from "~/lib/automation-client.ts";
import {
	AGENT_SOURCE_KEY,
	type AutomationStatusFilter,
	type AutomationTriggerKind,
	describeTrigger,
	filterAutomations,
	formatAutomationTime,
	isAgentDraft,
	localTimezone,
} from "~/lib/automation-format.ts";
import {
	cloudProviderLabel,
	orderedCloudProviders,
} from "~/lib/cloud-provider-presentation.ts";
import { loadCloudProviders } from "~/lib/cloud-workspace-session-cache.ts";
import { useActiveEnvironmentEntities } from "~/lib/environment-entity-hooks.ts";
import { formatError } from "~/lib/format-error.ts";
import { PROVIDER_SHORT_LABEL } from "~/lib/provider-labels.ts";
import { useSettingsStore } from "~/lib/settings-client-bus.ts";
import { cn } from "~/lib/utils";
import { useEnvironmentCatalogStore } from "~/store/environment-catalog.ts";
import { currentModelCatalog } from "~/store/model-catalog.ts";
import { useWorkspaceStore } from "~/store/workspace.ts";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "../ui/alert-dialog.tsx";
import { Button } from "../ui/button.tsx";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuTrigger,
} from "../ui/menu.tsx";
import { Skeleton } from "../ui/skeleton.tsx";
import { Switch } from "../ui/switch.tsx";
import { toastManager } from "../ui/toast.tsx";
import {
	AutomationAgentDialog,
	type AutomationAgentIntent,
} from "./automation-agent-dialog.tsx";
import {
	AutomationNotice,
	AutomationSelect,
	TriggerIcon,
} from "./automation-controls.tsx";
import { AutomationEditor } from "./automation-editor.tsx";
import { AutomationHistory } from "./automation-history.tsx";

export function defaultAutomationConfig(projectId: FolderId): AutomationConfig {
	const settings = useSettingsStore.getState();
	return {
		projectId,
		name: "",
		description: "",
		enabled: false,
		triggers: [
			{ _tag: "schedule", cron: "0 9 * * *", timezone: localTimezone() },
		],
		action: "new_session",
		sessionId: null,
		prompt: "",
		providerId: settings.defaultProviderId,
		model:
			settings.defaultModelByProvider[settings.defaultProviderId] ??
			defaultModelFor(currentModelCatalog(), settings.defaultProviderId),
		modelOptions: {},
		runtimeMode: settings.defaultRuntimeMode,
		runAs: "owner",
		worktreeId: null,
		environment: "local",
		mcpServerIds: [],
		allowChildSessions: false,
		network: { enabled: true, allowedDomains: [] },
		metadata: {},
		spendLimitUsd: null,
		rateLimit: { count: 50, windowSeconds: 3600 },
		queue: { enabled: true, maxConcurrency: 1 },
		notifications: [],
	};
}

const ENDPOINT_TRIGGERS = new Set([
	"webhook",
	"security_scan",
	"snapshot_build",
]);
type Pending = "toggle" | "run" | "open" | "delete";

export function AutomationsPage() {
	const environmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	return (
		<EnvironmentAutomations key={environmentId} environmentId={environmentId} />
	);
}

function EnvironmentAutomations({ environmentId }: { environmentId: string }) {
	const client = useMemo(
		() => automationClient(environmentId),
		[environmentId],
	);
	const { folders } = useActiveEnvironmentEntities();
	const selectedFolderId = useWorkspaceStore((state) => state.selectedFolderId);
	const projectId = selectedFolderId ?? folders[0]?.id ?? null;
	const projectName = (id: string) =>
		folders.find((folder) => folder.id === id)?.name ?? "Unknown project";
	const [capabilities, setCapabilities] =
		useState<AutomationCapabilities | null>(null);
	const [records, setRecords] = useState<ReadonlyArray<Automation> | null>(
		null,
	);
	const [templates, setTemplates] = useState<ReadonlyArray<AutomationTemplate>>(
		[],
	);
	const [cloudProviders, setCloudProviders] = useState<
		ReadonlyArray<CloudProviderOption>
	>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [retrying, setRetrying] = useState(false);
	const [search, setSearch] = useState("");
	const deferredSearch = useDeferredValue(search);
	const [statusFilter, setStatusFilter] =
		useState<AutomationStatusFilter>("all");
	const [category, setCategory] = useState("All");
	const [editor, setEditor] = useState<{
		initial: AutomationConfig;
		record?: Automation;
	} | null>(null);
	const [history, setHistory] = useState<Automation | null>(null);
	const [agentIntent, setAgentIntent] = useState<AutomationAgentIntent | null>(
		null,
	);
	const [deleteRecord, setDeleteRecord] = useState<Automation | null>(null);
	const [pending, setPending] = useState<ReadonlyMap<string, Pending>>(
		new Map(),
	);
	const alive = useRef(true);
	const loadVersion = useRef(0);
	const pendingRunRequests = useRef(new Map<string, string>());
	const templatesRef = useRef<HTMLElement>(null);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const setPendingFor = (id: string, value: Pending | null) =>
		setPending((current) => {
			const next = new Map(current);
			if (value) next.set(id, value);
			else next.delete(id);
			return next;
		});
	const replaceRecord = (record: Automation) =>
		setRecords((current) =>
			current?.some((item) => item.id === record.id)
				? current.map((item) => (item.id === record.id ? record : item))
				: [record, ...(current ?? [])],
		);
	const reload = useCallback(async () => {
		const version = ++loadVersion.current;
		const result = await client.list();
		if (alive.current && version === loadVersion.current) {
			setRecords(result);
			setLoadError(null);
		}
	}, [client]);
	const loadAll = useCallback(async () => {
		const version = ++loadVersion.current;
		const [items, catalog, availability] = await Promise.all([
			client.list(),
			client.templates(),
			client.capabilities(),
		]);
		if (!alive.current) return;
		if (version === loadVersion.current) setRecords(items);
		setTemplates(catalog);
		setCapabilities(availability);
		setLoadError(null);
	}, [client]);
	useEffect(() => {
		void loadAll().catch((cause) => {
			if (alive.current) setLoadError(formatError(cause));
		});
	}, [loadAll]);
	const cloudMachines = capabilities?.cloudMachines === true;
	useEffect(() => {
		if (!cloudMachines) return;
		let active = true;
		// Signed-out or unentitled accounts simply have no cloud machines to offer.
		void loadCloudProviders()
			.then((list) => {
				if (active) setCloudProviders(list.providers);
			})
			.catch(() => {
				if (active) setCloudProviders([]);
			});
		return () => {
			active = false;
		};
	}, [cloudMachines]);
	useEffect(() => {
		const interval = window.setInterval(() => {
			if (document.visibilityState === "visible")
				void reload().catch(() => {
					// Keep the last good list; the next poll or an action retries.
				});
		}, 15000);
		return () => window.clearInterval(interval);
	}, [reload]);

	const failed = (title: string, cause: unknown, record?: Automation) =>
		toastManager.add({
			type: "error",
			title,
			description: formatError(cause),
			...(record
				? {
						actionProps: {
							children: "Edit",
							onClick: () => openEditor(record),
						},
					}
				: {}),
		});
	const openEditor = (record: Automation) => {
		setPendingFor(record.id, "open");
		void client
			.get(record.id)
			.then(
				(latest) => {
					if (alive.current)
						setEditor({ initial: latest.config, record: latest });
				},
				(cause) => failed("Could not open the automation", cause),
			)
			.finally(() => setPendingFor(record.id, null));
	};
	const toggle = (record: Automation, enabled: boolean) => {
		setPendingFor(record.id, "toggle");
		void client
			.save({ ...record.config, enabled }, record)
			.then(replaceRecord, (cause) =>
				failed(
					enabled
						? "Could not enable the automation"
						: "Could not pause the automation",
					cause,
					record,
				),
			)
			.finally(() => setPendingFor(record.id, null));
	};
	const run = (record: Automation) => {
		const requestId =
			pendingRunRequests.current.get(record.id) ?? crypto.randomUUID();
		pendingRunRequests.current.set(record.id, requestId);
		setPendingFor(record.id, "run");
		void client
			.run(record.id, requestId)
			.then(
				(result) => {
					pendingRunRequests.current.delete(record.id);
					toastManager.add({
						type: result.status === "skipped" ? "info" : "success",
						title:
							result.status === "skipped"
								? `${record.config.name} was skipped`
								: `${record.config.name} started`,
						description: result.error ?? undefined,
						actionProps: {
							children: "View runs",
							onClick: () => setHistory(record),
						},
					});
				},
				(cause) => failed("Could not start the run", cause, record),
			)
			.finally(() => setPendingFor(record.id, null));
	};
	const remove = (record: Automation) => {
		setPendingFor(record.id, "delete");
		void client
			.remove(record.id)
			.then(
				() => {
					setRecords(
						(current) =>
							current?.filter((item) => item.id !== record.id) ?? null,
					);
					setDeleteRecord(null);
					toastManager.add({
						type: "success",
						title: `Deleted ${record.config.name}`,
					});
				},
				(cause) => failed("Could not delete the automation", cause),
			)
			.finally(() => setPendingFor(record.id, null));
	};
	const create = (initial?: Partial<AutomationConfig>) => {
		if (!projectId) {
			toastManager.add({
				type: "error",
				title: "Add a project before creating an automation.",
			});
			return;
		}
		const preferred = orderedCloudProviders(cloudProviders)[0];
		setEditor({
			initial: {
				...defaultAutomationConfig(projectId),
				environment: capabilities?.environment ?? "local",
				// Automations default to cloud agents wherever this runtime can start them.
				...(cloudMachines && preferred
					? {
							cloudMachine: {
								providerId: preferred.providerId,
								fallback: true,
							},
							allowChildSessions: true,
						}
					: {}),
				...initial,
			},
		});
	};
	const fromTemplate = (template: AutomationTemplate) =>
		create({
			name: template.name,
			description: template.description,
			prompt: template.prompt,
			// Templates use UTC; schedule them in the user's own timezone.
			triggers: [
				template.trigger._tag === "schedule"
					? { ...template.trigger, timezone: localTimezone() }
					: template.trigger,
			],
			action: template.action,
			// Read-only scans are enforced only on this computer.
			...(template.action === "code_scan" ? { cloudMachine: null } : {}),
		});
	const duplicate = (record: Automation) => {
		const { [AGENT_SOURCE_KEY]: _source, ...metadata } = record.config.metadata;
		create({
			...record.config,
			name: `${record.config.name} (copy)`,
			enabled: false,
			metadata,
		});
	};
	const showTemplates = () => {
		templatesRef.current?.scrollIntoView({ behavior: "smooth" });
		templatesRef.current
			?.querySelector<HTMLButtonElement>("[data-template]")
			?.focus({ preventScroll: true });
	};

	const all = records ?? [];
	const drafts = all.filter(
		(record) => isAgentDraft(record.config) && !record.config.enabled,
	);
	const filtered = filterAutomations(all, deferredSearch, statusFilter, null);
	const categories = [
		"All",
		...new Set(templates.map((template) => template.category)),
	];
	const visibleTemplates = templates.filter(
		(template) => category === "All" || template.category === category,
	);

	return (
		<main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-8 py-10 text-xs max-[800px]:px-4">
				<header className="flex items-start justify-between gap-4 px-2">
					<div className="min-w-0">
						<h1 className="text-xl font-medium tracking-[-0.01em]">
							Automations
						</h1>
						<p className="mt-1 text-muted-foreground">
							Run agents on a schedule or when something happens.
						</p>
					</div>
					<Menu>
						<MenuTrigger render={<Button className="h-7" />}>
							<HugeiconsIcon icon={PlusSignIcon} aria-hidden />
							New
						</MenuTrigger>
						<MenuPopup align="end" className="w-52">
							<MenuItem
								className="h-7 gap-2"
								disabled={!projectId}
								onClick={() => create()}
							>
								<HugeiconsIcon icon={PencilEdit02Icon} aria-hidden />
								Blank automation
							</MenuItem>
							<MenuItem className="h-7 gap-2" onClick={showTemplates}>
								<HugeiconsIcon icon={DashboardSquare01Icon} aria-hidden />
								From a template
							</MenuItem>
							<MenuSeparator />
							<MenuItem
								className="h-7 gap-2"
								disabled={!projectId}
								onClick={() => setAgentIntent("generate")}
							>
								<HugeiconsIcon icon={AiChat02Icon} aria-hidden />
								Describe to an agent
							</MenuItem>
							<MenuItem
								className="h-7 gap-2"
								disabled={!projectId}
								onClick={() => setAgentIntent("suggest")}
							>
								<HugeiconsIcon icon={SparklesIcon} aria-hidden />
								Suggest automations
							</MenuItem>
						</MenuPopup>
					</Menu>
				</header>

				{loadError && (
					<AutomationNotice
						tone="error"
						action={
							<Button
								className="h-7"
								variant="ghost"
								loading={retrying}
								onClick={() => {
									setRetrying(true);
									void loadAll()
										.catch((cause) => {
											if (alive.current) setLoadError(formatError(cause));
										})
										.finally(() => setRetrying(false));
								}}
							>
								Retry
							</Button>
						}
					>
						Couldn’t load automations. {loadError}
					</AutomationNotice>
				)}

				<section aria-label="Your automations" className="flex flex-col gap-1">
					{records === null && !loadError ? (
						<div
							role="status"
							aria-busy="true"
							aria-label="Loading automations"
							className="space-y-1"
						>
							{[0, 1].map((key) => (
								<Skeleton key={key} className="h-12 rounded-lg" />
							))}
						</div>
					) : all.length === 0 ? (
						!loadError && (
							<div className="flex flex-col items-center rounded-xl bg-muted/25 px-6 py-10 text-center">
								<p className="text-[13px] font-medium">No automations yet</p>
								<p className="mt-1 max-w-xs text-muted-foreground">
									Pick a template below, or describe what you want and let an
									agent set it up.
								</p>
								<div className="mt-4 flex gap-1.5">
									<Button
										className="h-7"
										variant="outline"
										disabled={!projectId}
										onClick={() => setAgentIntent("generate")}
									>
										<HugeiconsIcon icon={AiChat02Icon} aria-hidden />
										Describe to an agent
									</Button>
									<Button
										className="h-7"
										variant="ghost"
										disabled={!projectId}
										onClick={() => setAgentIntent("suggest")}
									>
										Suggest for me
									</Button>
								</div>
							</div>
						)
					) : (
						<>
							<div className="flex h-7 items-center justify-between gap-3 px-2 pb-1">
								<h2 className="text-[13px] font-medium">
									{statusFilter === "drafts"
										? "Agent drafts"
										: "Your automations"}
								</h2>
								{statusFilter === "drafts" ? (
									<Button
										variant="ghost"
										className="h-7 text-muted-foreground"
										onClick={() => setStatusFilter("all")}
									>
										Show all
									</Button>
								) : drafts.length > 0 ? (
									<Button
										variant="ghost"
										className="h-7 text-muted-foreground"
										onClick={() => setStatusFilter("drafts")}
									>
										<span
											className="size-1.5 rounded-full bg-info"
											aria-hidden
										/>
										{drafts.length === 1
											? "1 draft to review"
											: `${drafts.length} drafts to review`}
									</Button>
								) : all.length > 6 ? (
									<label className="flex h-7 w-48 items-center gap-2 rounded-md bg-muted/55 px-2.5 focus-within:ring-2 focus-within:ring-ring/24">
										<HugeiconsIcon
											icon={Search01Icon}
											className="size-3.5 shrink-0 text-muted-foreground"
											aria-hidden
										/>
										<input
											type="search"
											aria-label="Search automations"
											placeholder="Search"
											className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
											value={search}
											onChange={(event) => setSearch(event.target.value)}
										/>
									</label>
								) : null}
							</div>
							{filtered.length === 0 ? (
								<p className="px-2 py-4 text-muted-foreground">
									Nothing matches.
								</p>
							) : (
								<ul className="flex flex-col gap-0.5">
									{filtered.map((record) => (
										<AutomationRowItem
											key={record.id}
											record={record}
											pending={pending.get(record.id) ?? null}
											projectName={
												folders.length > 1
													? projectName(record.config.projectId)
													: null
											}
											onEdit={() => openEditor(record)}
											onToggle={(enabled) => toggle(record, enabled)}
											onRun={() => run(record)}
											onHistory={() => setHistory(record)}
											onDuplicate={() => duplicate(record)}
											onDelete={() => setDeleteRecord(record)}
										/>
									))}
								</ul>
							)}
						</>
					)}
				</section>

				<section
					ref={templatesRef}
					aria-labelledby="automation-templates"
					className="flex scroll-mt-6 flex-col gap-1"
				>
					<div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-1">
						<h2 id="automation-templates" className="text-[13px] font-medium">
							Templates
						</h2>
						{categories.length > 1 && (
							<div className="w-44">
								<AutomationSelect
									label="Template category"
									value={category}
									onChange={setCategory}
									options={categories.map((value) => ({
										value,
										label: value === "All" ? "All categories" : value,
									}))}
								/>
							</div>
						)}
					</div>
					{templates.length === 0 && records === null && !loadError ? (
						<div className="grid gap-1 lg:grid-cols-2">
							{[0, 1, 2, 3].map((key) => (
								<Skeleton key={key} className="h-12 rounded-lg" />
							))}
						</div>
					) : (
						<div className="grid grid-cols-1 gap-x-4 gap-y-0.5 lg:grid-cols-2">
							{visibleTemplates.map((template) => (
								<button
									type="button"
									key={template.id}
									data-template
									disabled={!projectId}
									className="group flex items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
									onClick={() => fromTemplate(template)}
								>
									<TriggerGlyph kind={template.trigger._tag} />
									<span className="min-w-0 flex-1">
										<span className="block truncate text-[13px] font-medium">
											{template.name}
										</span>
										<span className="block truncate text-muted-foreground">
											{template.description}
										</span>
									</span>
								</button>
							))}
						</div>
					)}
				</section>
			</div>

			{editor && (
				<AutomationEditor
					key={editor.record?.id ?? "new"}
					initial={editor.initial}
					capabilities={capabilities}
					cloudProviders={cloudProviders}
					record={editor.record}
					onClose={() => setEditor(null)}
					onSave={async (config, record, requestId) => {
						const saved = await client.save(config, record, requestId);
						if (!alive.current) return;
						replaceRecord(saved);
						const needsEndpoint =
							!record &&
							saved.webhook !== undefined &&
							saved.config.triggers.some((trigger) =>
								ENDPOINT_TRIGGERS.has(trigger._tag),
							);
						toastManager.add({
							type: "success",
							title: record
								? `Saved ${saved.config.name}`
								: `Created ${saved.config.name}`,
							description: needsEndpoint
								? "Copy the endpoint URL and token into the event source."
								: saved.config.enabled
									? "It now accepts triggers."
									: "It stays paused until you enable it.",
						});
						// Keep the editor open on a new event automation so its
						// endpoint can be copied right away.
						setEditor(
							needsEndpoint ? { initial: saved.config, record: saved } : null,
						);
					}}
				/>
			)}
			{agentIntent && (
				<AutomationAgentDialog
					intent={agentIntent}
					projectId={projectId}
					onClose={() => setAgentIntent(null)}
				/>
			)}
			{history && (
				<AutomationHistory
					client={client}
					automation={history}
					running={pending.get(history.id) === "run"}
					onRun={() => run(history)}
					onClose={() => setHistory(null)}
				/>
			)}
			<AlertDialog
				open={deleteRecord !== null}
				onOpenChange={(open) => {
					if (
						!open &&
						deleteRecord &&
						pending.get(deleteRecord.id) !== "delete"
					)
						setDeleteRecord(null);
				}}
			>
				<AlertDialogPopup className="max-w-sm">
					<AlertDialogHeader>
						<AlertDialogTitle>
							Delete {deleteRecord?.config.name ?? "automation"}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							Future triggers stop immediately. Sessions from earlier runs are
							kept.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose
							render={<Button className="h-7" variant="ghost" />}
						>
							Cancel
						</AlertDialogClose>
						<Button
							className="h-7"
							variant="destructive"
							loading={
								deleteRecord ? pending.get(deleteRecord.id) === "delete" : false
							}
							onClick={() => {
								if (deleteRecord) remove(deleteRecord);
							}}
						>
							Delete
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</main>
	);
}

function TriggerGlyph({ kind }: { kind: AutomationTriggerKind }) {
	return (
		<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/55 text-muted-foreground">
			<TriggerIcon kind={kind} className="size-4" />
		</span>
	);
}

function AutomationRowItem({
	record,
	pending,
	projectName,
	onEdit,
	onToggle,
	onRun,
	onHistory,
	onDuplicate,
	onDelete,
}: {
	record: Automation;
	pending: Pending | null;
	projectName: string | null;
	onEdit: () => void;
	onToggle: (enabled: boolean) => void;
	onRun: () => void;
	onHistory: () => void;
	onDuplicate: () => void;
	onDelete: () => void;
}) {
	const { config } = record;
	const draft = isAgentDraft(config) && !config.enabled;
	const status = !config.enabled
		? draft
			? "Draft"
			: "Off"
		: record.nextRunAt
			? `Next ${formatAutomationTime(record.nextRunAt)}`
			: "On";
	return (
		<li
			className={cn(
				"group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted/45",
				pending === "delete" && "opacity-50",
			)}
		>
			<button
				type="button"
				className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
				aria-label={`Edit ${config.name}`}
				disabled={pending === "open"}
				onClick={onEdit}
			>
				<TriggerGlyph kind={config.triggers[0]?._tag ?? "manual"} />
				<span className="min-w-0 flex-1">
					<span
						className={cn(
							"block truncate text-[13px] font-medium",
							!config.enabled && "text-muted-foreground",
						)}
					>
						{config.name}
					</span>
					<span className="block truncate text-muted-foreground">
						{config.triggers.map(describeTrigger).join(" or ")} ·{" "}
						{PROVIDER_SHORT_LABEL[config.providerId]}
						{config.cloudMachine
							? ` on ${cloudProviderLabel(config.cloudMachine.providerId)}`
							: ""}
						{projectName ? ` · ${projectName}` : ""}
					</span>
				</span>
			</button>
			<span
				className={cn(
					"hidden w-32 shrink-0 truncate text-right text-[11px] tabular-nums sm:block",
					draft ? "text-info" : "text-muted-foreground",
				)}
			>
				{pending === "run" ? "Starting…" : status}
			</span>
			<Switch
				aria-label={
					config.enabled ? `Turn off ${config.name}` : `Turn on ${config.name}`
				}
				checked={config.enabled}
				disabled={pending !== null}
				onCheckedChange={onToggle}
			/>
			<Menu>
				<MenuTrigger
					render={
						<Button
							size="icon-sm"
							variant="ghost"
							className="text-muted-foreground"
							aria-label={`More actions for ${config.name}`}
						/>
					}
				>
					<HugeiconsIcon icon={MoreHorizontalIcon} aria-hidden />
				</MenuTrigger>
				<MenuPopup align="end" className="w-40">
					<MenuItem
						className="h-7 gap-2"
						disabled={pending !== null}
						onClick={onRun}
					>
						<HugeiconsIcon icon={PlayIcon} aria-hidden />
						Run now
					</MenuItem>
					<MenuItem className="h-7 gap-2" onClick={onHistory}>
						<HugeiconsIcon icon={Time04Icon} aria-hidden />
						Runs
					</MenuItem>
					<MenuItem className="h-7 gap-2" onClick={onEdit}>
						<HugeiconsIcon icon={PencilEdit02Icon} aria-hidden />
						Edit
					</MenuItem>
					<MenuItem className="h-7 gap-2" onClick={onDuplicate}>
						<HugeiconsIcon icon={Copy01Icon} aria-hidden />
						Duplicate
					</MenuItem>
					<MenuSeparator />
					<MenuItem
						className="h-7 gap-2"
						variant="destructive"
						onClick={onDelete}
					>
						<HugeiconsIcon icon={Delete02Icon} aria-hidden />
						Delete
					</MenuItem>
				</MenuPopup>
			</Menu>
		</li>
	);
}
