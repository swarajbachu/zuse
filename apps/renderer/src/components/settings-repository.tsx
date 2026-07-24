import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, GitBranchIcon } from "@hugeicons-pro/core-solid-rounded";
import {
	type FolderId,
	MODELS_BY_PROVIDER,
	type ProviderId,
	visibleModelsForProvider,
} from "@zuse/contracts";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { displayPath } from "~/lib/display-path";
import { cn } from "~/lib/utils";
import { useRepositorySettingsStore } from "../store/repository-settings.ts";
import { useSettingsStore } from "../store/settings.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import { PermissionsInspector } from "./permissions-inspector.tsx";
import { ProviderIcon } from "./provider-icons.tsx";
import { MODE_META, MODES_ORDER } from "./runtime-mode-meta.ts";
import {
	PROVIDER_LABEL,
	RadioCheck,
	SettingsGroup,
	SettingsRow,
} from "./settings-page.tsx";
import { Button } from "./ui/button.tsx";
import { Switch } from "./ui/switch.tsx";
import { Textarea } from "./ui/textarea.tsx";

/**
 * Per-repository settings: provider/model/permission overrides plus
 * worktree management. Every override is nullable — `null` means "fall
 * through to the global default in `useSettingsStore`."
 */
export function RepositorySettings({ projectId }: { projectId: FolderId }) {
	const folder = useWorkspaceStore((s) =>
		s.folders.find((f) => f.id === projectId),
	);
	const settings = useRepositorySettingsStore(
		(s) => s.byProject[projectId] ?? null,
	);
	const refresh = useRepositorySettingsStore((s) => s.refresh);
	const update = useRepositorySettingsStore((s) => s.update);
	const [permissionsOpen, setPermissionsOpen] = useState(false);

	useEffect(() => {
		if (settings === null) void refresh(projectId);
	}, [projectId, refresh, settings]);

	if (folder === undefined) {
		return (
			<p className="text-sm text-muted-foreground">
				Project no longer exists. Pick another from the sidebar.
			</p>
		);
	}

	if (settings === null) {
		return <p className="text-sm text-muted-foreground">Loading settings…</p>;
	}

	return (
		<>
			<SettingsGroup
				title="Defaults"
				description="Repository-specific defaults for new chats. Leave overrides off to inherit global settings."
			>
				<ProviderOverrideSection
					defaultProviderId={settings.defaultProviderId}
					defaultModel={settings.defaultModel}
					onProviderAndModelChange={(provider, model) =>
						void update(projectId, {
							defaultProviderId: provider,
							defaultModel: model,
						})
					}
				/>

				<RuntimeModeOverrideSection
					currentValue={settings.defaultRuntimeMode}
					onChange={(value) =>
						void update(projectId, { defaultRuntimeMode: value })
					}
				/>

				<SettingsRow
					title="Project permissions"
					description="Review and revoke saved tool permission decisions for this repository."
					action={
						<Button
							variant="settings"
							size="sm"
							onClick={() => setPermissionsOpen(true)}
						>
							Manage
						</Button>
					}
				/>
			</SettingsGroup>
			<PermissionsInspector
				open={permissionsOpen}
				onOpenChange={setPermissionsOpen}
				projectId={projectId}
				projectName={folder.name}
			/>

			<ScriptsSection
				setupScript={settings.setupScript}
				runScript={settings.runScript}
				archiveScript={settings.archiveCleanupScript}
				autoRunAfterSetup={settings.autoRunAfterSetup}
				environmentVariables={settings.environmentVariables}
				fileIncludeGlobs={settings.fileIncludeGlobs}
				onSetupScriptChange={(value) =>
					void update(projectId, { setupScript: value })
				}
				onRunScriptChange={(value) =>
					void update(projectId, { runScript: value })
				}
				onArchiveScriptChange={(value) =>
					void update(projectId, { archiveCleanupScript: value })
				}
				onAutoRunAfterSetupChange={(value) =>
					void update(projectId, { autoRunAfterSetup: value })
				}
				onEnvironmentVariablesChange={(value) =>
					void update(projectId, { environmentVariables: value })
				}
				onFileIncludeGlobsChange={(value) =>
					void update(projectId, { fileIncludeGlobs: value })
				}
			/>

			<WorktreeSection
				projectId={projectId}
				autoCreate={settings.autoCreateWorktree}
				onAutoCreateChange={(value) =>
					void update(projectId, { autoCreateWorktree: value })
				}
			/>
		</>
	);
}

function ProviderOverrideSection({
	defaultProviderId,
	defaultModel,
	onProviderAndModelChange,
}: {
	defaultProviderId: ProviderId | null;
	defaultModel: string | null;
	/**
	 * Update provider + model in a single patch. We deliberately don't expose
	 * separate setters: changing only the provider would leave a stale model
	 * id behind, and firing two patches in a row races against the server's
	 * read-then-write so the later response can clobber the earlier one.
	 */
	onProviderAndModelChange: (
		provider: ProviderId | null,
		model: string | null,
	) => void;
}) {
	const globalProviderId = useSettingsStore((s) => s.defaultProviderId);
	const globalModelByProvider = useSettingsStore(
		(s) => s.defaultModelByProvider,
	);
	const providerEnabled = useSettingsStore((s) => s.providerEnabled);
	const modelEnabledByProvider = useSettingsStore(
		(s) => s.modelEnabledByProvider,
	);
	const effectiveProvider: ProviderId = defaultProviderId ?? globalProviderId;
	const globalModel = globalModelByProvider[globalProviderId];
	const globalModelLabel =
		MODELS_BY_PROVIDER[globalProviderId].find((m) => m.id === globalModel)
			?.label ??
		globalModel ??
		"—";
	const isOverridden = defaultProviderId !== null || defaultModel !== null;

	// Mirror the global "Default agent" filter: skip providers the user
	// toggled off.
	const availableProviders = (
		["claude", "codex", "grok", "gemini", "cursor", "opencode"] as const
	).filter((pid) => {
		if (providerEnabled[pid] === false) return false;
		return true;
	});

	const firstModelFor = (pid: ProviderId): string | null =>
		visibleModelsForProvider(pid, modelEnabledByProvider)[0]?.id ??
		MODELS_BY_PROVIDER[pid]?.[0]?.id ??
		null;

	const onToggle = (next: boolean) => {
		if (next) {
			// Turning on: seed override with the currently-effective values so the
			// user sees the same state, but it's now persisted as a repo override.
			onProviderAndModelChange(
				effectiveProvider,
				globalModelByProvider[effectiveProvider] ??
					firstModelFor(effectiveProvider),
			);
		} else {
			onProviderAndModelChange(null, null);
		}
	};

	const onPickProvider = (pid: ProviderId) => {
		onProviderAndModelChange(
			pid,
			globalModelByProvider[pid] ?? firstModelFor(pid),
		);
	};

	const onPickModel = (model: string) => {
		onProviderAndModelChange(effectiveProvider, model);
	};
	const selectedModel =
		defaultModel ??
		globalModelByProvider[effectiveProvider] ??
		firstModelFor(effectiveProvider);

	return (
		<SettingsRow
			title="Default agent"
			description="Override the global default provider and model for new chats in this repo."
			action={<Switch checked={isOverridden} onCheckedChange={onToggle} />}
		>
			{isOverridden ? (
				<div
					role="radiogroup"
					aria-label="Repository default provider"
					className="overflow-hidden rounded-lg border border-border/40 bg-background/60"
				>
					{availableProviders.map((pid) => {
						const selected = effectiveProvider === pid;
						const models = visibleModelsForProvider(
							pid,
							modelEnabledByProvider,
							{
								includeModelId:
									selected && selectedModel !== null ? selectedModel : null,
							},
						);
						return (
							<div
								key={pid}
								className="flex flex-col border-b border-border/40 last:border-b-0"
							>
								<button
									type="button"
									role="radio"
									aria-checked={selected}
									onClick={() => onPickProvider(pid)}
									className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
								>
									<ProviderIcon providerId={pid} className="size-4 shrink-0" />
									<span className="flex-1 truncate text-sm font-medium text-foreground">
										{PROVIDER_LABEL[pid]}
									</span>
									<RadioCheck active={selected} />
								</button>
								{selected && models.length > 0 && (
									<div className="flex flex-col gap-1.5 px-3 pb-3 pl-10">
										<span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
											Model
										</span>
										<div
											role="radiogroup"
											aria-label={`Model for ${PROVIDER_LABEL[pid]}`}
											className="flex flex-col"
										>
											{models.map((m) => {
												const isCurrentModel = selectedModel === m.id;
												return (
													<button
														key={m.id}
														type="button"
														role="radio"
														aria-checked={isCurrentModel}
														onClick={() => onPickModel(m.id)}
														className="group flex items-center gap-3 py-1.5 text-left"
													>
														<RadioCheck active={isCurrentModel} />
														<span className="text-sm text-foreground">
															{m.label}
														</span>
													</button>
												);
											})}
										</div>
									</div>
								)}
							</div>
						);
					})}
				</div>
			) : (
				<p className="rounded-lg border border-border/40 bg-background/60 px-3 py-2.5 text-sm text-muted-foreground">
					Inheriting{" "}
					<span className="text-foreground">
						{PROVIDER_LABEL[globalProviderId]} · {globalModelLabel}
					</span>
				</p>
			)}
		</SettingsRow>
	);
}

function RuntimeModeOverrideSection({
	currentValue,
	onChange,
}: {
	currentValue: (typeof MODES_ORDER)[number] | null;
	onChange: (v: (typeof MODES_ORDER)[number] | null) => void;
}) {
	const globalMode = useSettingsStore((s) => s.defaultRuntimeMode);
	const effective = currentValue ?? globalMode;
	const isOverridden = currentValue !== null;
	const onToggle = (next: boolean) => {
		if (next) onChange(globalMode);
		else onChange(null);
	};
	return (
		<SettingsRow
			title="Default permission mode"
			description="Override the global permission posture for new chats in this repo."
			action={<Switch checked={isOverridden} onCheckedChange={onToggle} />}
		>
			{isOverridden ? (
				<div
					role="radiogroup"
					aria-label="Repository default permission mode"
					className="overflow-hidden rounded-lg border border-border/40 bg-background/60"
				>
					{MODES_ORDER.map((mode) => {
						const m = MODE_META[mode];
						const selected = effective === mode;
						return (
							<button
								key={mode}
								type="button"
								role="radio"
								aria-checked={selected}
								onClick={() => onChange(mode)}
								className="group flex w-full items-start gap-3 border-b border-border/40 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/40"
							>
								<HugeiconsIcon
									icon={m.Icon}
									className="mt-0.5 size-4 shrink-0 text-muted-foreground"
								/>
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="text-sm font-medium text-foreground">
										{m.label}
									</span>
									<span className="text-xs leading-snug text-muted-foreground">
										{m.description}
									</span>
								</span>
								<RadioCheck active={selected} className="mt-0.5" />
							</button>
						);
					})}
				</div>
			) : (
				<p className="rounded-lg border border-border/40 bg-background/60 px-3 py-2.5 text-sm text-muted-foreground">
					Inheriting{" "}
					<span className="text-foreground">{MODE_META[globalMode].label}</span>
				</p>
			)}
		</SettingsRow>
	);
}

function WorktreeSection({
	projectId,
	autoCreate,
	onAutoCreateChange,
}: {
	projectId: FolderId;
	autoCreate: boolean;
	onAutoCreateChange: (v: boolean) => void;
}) {
	const worktrees = useWorktreesStore(
		(s) => s.byProject[projectId] ?? EMPTY_WORKTREES,
	);
	const refresh = useWorktreesStore((s) => s.refresh);
	const remove = useWorktreesStore((s) => s.remove);
	const [removingId, setRemovingId] = useState<
		(typeof worktrees)[number]["id"] | null
	>(null);
	const [pendingError, setPendingError] = useState<string | null>(null);

	useEffect(() => {
		void refresh(projectId);
	}, [projectId, refresh]);

	const sorted = useMemo(
		() =>
			[...worktrees].sort(
				(a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
			),
		[worktrees],
	);

	const onRemove = async (worktreeId: (typeof worktrees)[number]["id"]) => {
		if (removingId !== null) return;
		setRemovingId(worktreeId);
		setPendingError(null);
		try {
			const result = await remove(projectId, worktreeId);
			if (result.ok) return;
			setPendingError(result.reason);
		} finally {
			setRemovingId(null);
		}
	};

	return (
		<SettingsGroup
			title="Worktrees"
			description="Controls for automatic chat worktrees and the existing checkouts for this repository."
			trailing={
				<span className="text-[11px] text-muted-foreground/80">
					{sorted.length} {sorted.length === 1 ? "worktree" : "worktrees"}
				</span>
			}
		>
			<SettingsRow
				title="Auto-create a worktree for new chats"
				description={`When on, the composer's workspace picker pre-selects a fresh worktree. You can still flip back to "Current checkout" before sending the first message.`}
				action={
					<Switch checked={autoCreate} onCheckedChange={onAutoCreateChange} />
				}
			/>

			<div className="flex flex-col">
				{sorted.length === 0 ? (
					<p className="px-4 py-8 text-center text-xs text-muted-foreground">
						No worktrees yet. Zuse (Beta) creates one for you when you start a
						new chat.
					</p>
				) : (
					<ul className="flex flex-col divide-y divide-border/40">
						{sorted.map((wt) => (
							<li
								key={wt.id}
								className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/20"
							>
								<HugeiconsIcon
									icon={GitBranchIcon}
									className="size-4 shrink-0 text-muted-foreground"
								/>
								<div
									className="flex min-w-0 flex-col gap-0.5"
									title={displayPath(wt.path)}
								>
									<span className="truncate text-sm font-medium text-foreground">
										{wt.name}
									</span>
									<span className="truncate font-mono text-[11px] text-muted-foreground">
										{wt.branch}
										<span className="text-muted-foreground/60">
											{" "}
											· off {wt.baseBranch}
										</span>
									</span>
								</div>
								<Button
									variant="settings"
									size="sm"
									loading={removingId === wt.id}
									onClick={() => void onRemove(wt.id)}
									title="Remove the checkout; uncommitted changes are saved to its branch"
								>
									<HugeiconsIcon icon={Delete02Icon} className="size-3" />
									Remove
								</Button>
							</li>
						))}
					</ul>
				)}
			</div>

			<div className="px-4 py-3">
				{pendingError !== null ? (
					<p className="text-xs leading-relaxed text-red-400">{pendingError}</p>
				) : (
					<p className="text-xs leading-relaxed text-muted-foreground">
						Git worktrees for this repo. Each lives under
						~/.zuse/&lt;repo&gt;/&lt;name&gt;/ on disk.
					</p>
				)}
			</div>
		</SettingsGroup>
	);
}

function ScriptsSection({
	setupScript,
	runScript,
	archiveScript,
	autoRunAfterSetup,
	environmentVariables,
	fileIncludeGlobs,
	onSetupScriptChange,
	onRunScriptChange,
	onArchiveScriptChange,
	onAutoRunAfterSetupChange,
	onEnvironmentVariablesChange,
	onFileIncludeGlobsChange,
}: {
	setupScript: string | null;
	runScript: string | null;
	archiveScript: string | null;
	autoRunAfterSetup: boolean;
	environmentVariables: Readonly<Record<string, string>>;
	fileIncludeGlobs: string;
	onSetupScriptChange: (v: string | null) => void;
	onRunScriptChange: (v: string | null) => void;
	onArchiveScriptChange: (v: string | null) => void;
	onAutoRunAfterSetupChange: (v: boolean) => void;
	onEnvironmentVariablesChange: (v: Record<string, string>) => void;
	onFileIncludeGlobsChange: (v: string) => void;
}) {
	const envText = Object.entries(environmentVariables)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
	const [envDraft, setEnvDraft] = useState(envText);
	useEffect(() => setEnvDraft(envText), [envText]);
	const persistEnv = () => {
		const next: Record<string, string> = {};
		for (const line of envDraft.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
			const idx = trimmed.indexOf("=");
			if (idx <= 0) continue;
			next[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
		}
		onEnvironmentVariablesChange(next);
	};

	return (
		<SettingsGroup
			title="Scripts"
			description="Commands that run when worktrees are set up, run, or archived."
		>
			<ScriptEditor
				title="Setup script"
				description="Runs when a new worktree is created"
				value={setupScript}
				placeholder="bun i"
				onChange={onSetupScriptChange}
			/>
			<ScriptEditor
				title="Run script"
				description="Runs when you click Run"
				value={runScript}
				placeholder="bun run dev"
				onChange={onRunScriptChange}
			/>
			<SettingsRow
				title="Auto-run after setup"
				description="Start this repository's run script automatically after setup."
				action={
					<Switch
						checked={autoRunAfterSetup}
						onCheckedChange={onAutoRunAfterSetupChange}
					/>
				}
			/>
			<ScriptEditor
				title="Archive script"
				description="Optional hook that runs before the archive checkpoint"
				value={archiveScript}
				placeholder={'rm -rf node_modules .next\npkill -f "next dev" || true'}
				onChange={onArchiveScriptChange}
			/>
			<div className="px-4 py-3.5">
				<div className="mb-2">
					<p className="text-sm font-medium text-foreground">
						Environment variables
					</p>
					<p className="text-xs text-muted-foreground">
						KEY=value pairs passed to setup, run, and archive scripts.
					</p>
				</div>
				<CodeTextarea
					value={envDraft}
					onChange={(event) => setEnvDraft(event.currentTarget.value)}
					onBlur={persistEnv}
					placeholder="ZUSE_PORT=5733"
					minHeightClassName="min-h-24"
				/>
			</div>
			<FileIncludesEditor
				value={fileIncludeGlobs}
				onChange={onFileIncludeGlobsChange}
			/>
			<div className="px-4 py-3">
				<p className="text-xs leading-relaxed text-muted-foreground">
					Want to hand-edit or share repository settings? Use{" "}
					<span className="font-mono">.zuse/settings.toml</span>.
				</p>
			</div>
		</SettingsGroup>
	);
}

function FileIncludesEditor({
	value,
	onChange,
}: {
	value: string;
	onChange: (v: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	const persist = () => {
		if (draft !== value) onChange(draft);
	};
	return (
		<div className="px-4 py-3.5">
			<div className="mb-2">
				<p className="text-sm font-medium text-foreground">
					Worktree file includes
				</p>
				<p className="text-xs text-muted-foreground">
					One pattern per line, linked from the main checkout into each new
					worktree.
				</p>
			</div>
			<CodeTextarea
				value={draft}
				onChange={(event) => setDraft(event.currentTarget.value)}
				onBlur={persist}
				placeholder={".env\n.env.local\n.env.*.local"}
				minHeightClassName="min-h-20"
			/>
		</div>
	);
}

function ScriptEditor({
	title,
	description,
	value,
	placeholder,
	onChange,
}: {
	title: string;
	description: string;
	value: string | null;
	placeholder: string;
	onChange: (v: string | null) => void;
}) {
	const [draft, setDraft] = useState(value ?? "");
	useEffect(() => setDraft(value ?? ""), [value]);
	const persist = () => {
		const next = draft.trim().length === 0 ? null : draft;
		if ((value ?? "") !== (next ?? "")) onChange(next);
	};
	return (
		<div className="px-4 py-3.5">
			<div className="mb-2 flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-sm font-medium text-foreground">{title}</p>
					<p className="text-xs text-muted-foreground">{description}</p>
				</div>
				<span className="rounded-md border border-border/40 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
					shell
				</span>
			</div>
			<CodeTextarea
				value={draft}
				onChange={(event) => setDraft(event.currentTarget.value)}
				onBlur={persist}
				placeholder={placeholder}
				minHeightClassName="min-h-18"
			/>
		</div>
	);
}

function CodeTextarea({
	className,
	minHeightClassName,
	...props
}: React.ComponentProps<typeof Textarea> & {
	minHeightClassName?: string;
}) {
	return (
		<div className="overflow-hidden rounded-lg border border-border/60 bg-background/70 shadow-xs/5 focus-within:border-ring/70 focus-within:ring-[3px] focus-within:ring-ring/20">
			<Textarea
				spellCheck={false}
				className={cn(
					"resize-y border-0 bg-transparent px-3 py-2.5 font-mono text-xs leading-5 shadow-none outline-none placeholder:text-muted-foreground/50 focus-visible:ring-0",
					minHeightClassName,
					className,
				)}
				{...props}
			/>
		</div>
	);
}
