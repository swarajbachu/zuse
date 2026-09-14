import "@zuse/i18n/english/settings";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	catalogProviderIds,
	EnvironmentId,
	type FolderId,
	findModelDescriptor,
	type ProviderId,
	visibleModelsForProvider,
} from "@zuse/contracts";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import { Delete02Icon, GitBranchIcon } from "@zuse/icons/solid-rounded";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { displayPath } from "~/lib/display-path";
import { cn } from "~/lib/utils";
import { useModelCatalogStore } from "~/store/model-catalog";
import { useSettingsStore } from "../lib/settings-client-bus.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import {
	repositorySettingsKey,
	useRepositorySettingsStore,
} from "../store/repository-settings.ts";
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore((state) => state.activeEnvironmentId),
	);
	const folder = useWorkspaceStore((s) =>
		s.folders.find((f) => f.id === projectId),
	);
	const settings = useRepositorySettingsStore(
		(s) => s.byProject[repositorySettingsKey(environmentId, projectId)] ?? null,
	);
	const refresh = useRepositorySettingsStore((s) => s.refresh);
	const update = useRepositorySettingsStore((s) => s.update);
	const [permissionsOpen, setPermissionsOpen] = useState(false);

	useEffect(() => {
		if (settings === null) void refresh(environmentId, projectId);
	}, [environmentId, projectId, refresh, settings]);

	if (folder === undefined) {
		return (
			<p className="text-xs text-muted-foreground">
				{uiMessage(
					"settings:settings_repository_project_no_longer_exists_pick_another_from_the_sidebar",
				)}
			</p>
		);
	}

	if (settings === null) {
		return (
			<p className="text-xs text-muted-foreground">
				{uiMessage("settings:settings_repository_loading_settings")}
			</p>
		);
	}

	return (
		<>
			<SettingsGroup
				title={uiMessage("settings:settings_repository_defaults")}
				description={uiMessage(
					"settings:settings_repository_repository_specific_defaults_for_new_chats_leave_overrides_off_to_inhe",
				)}
			>
				<ProviderOverrideSection
					defaultProviderId={settings.defaultProviderId}
					defaultModel={settings.defaultModel}
					onProviderAndModelChange={(provider, model) =>
						void update(environmentId, projectId, {
							defaultProviderId: provider,
							defaultModel: model,
						})
					}
				/>

				<RuntimeModeOverrideSection
					currentValue={settings.defaultRuntimeMode}
					onChange={(value) =>
						void update(environmentId, projectId, { defaultRuntimeMode: value })
					}
				/>

				<SettingsRow
					title={uiMessage("settings:settings_repository_project_permissions")}
					description={uiMessage(
						"settings:settings_repository_review_and_revoke_saved_tool_permission_decisions_for_this_repository",
					)}
					action={
						<Button
							variant="settings"
							size="sm"
							onClick={() => setPermissionsOpen(true)}
						>
							{uiMessage("settings:settings_repository_manage")}
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
					void update(environmentId, projectId, { setupScript: value })
				}
				onRunScriptChange={(value) =>
					void update(environmentId, projectId, { runScript: value })
				}
				onArchiveScriptChange={(value) =>
					void update(environmentId, projectId, { archiveCleanupScript: value })
				}
				onAutoRunAfterSetupChange={(value) =>
					void update(environmentId, projectId, { autoRunAfterSetup: value })
				}
				onEnvironmentVariablesChange={(value) =>
					void update(environmentId, projectId, { environmentVariables: value })
				}
				onFileIncludeGlobsChange={(value) =>
					void update(environmentId, projectId, { fileIncludeGlobs: value })
				}
			/>

			<WorktreeSection
				projectId={projectId}
				autoCreate={settings.autoCreateWorktree}
				onAutoCreateChange={(value) =>
					void update(environmentId, projectId, { autoCreateWorktree: value })
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

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
	const catalog = useModelCatalogStore((s) => s.catalog);
	const globalModelLabel =
		findModelDescriptor(catalog, globalProviderId, globalModel)?.label ??
		globalModel ??
		"—";
	const isOverridden = defaultProviderId !== null || defaultModel !== null;

	// Mirror the global "Default agent" filter: skip providers the user
	// toggled off.
	const availableProviders = catalogProviderIds(catalog).filter((pid) => {
		if (providerEnabled[pid] === false) return false;
		return true;
	});

	const firstModelFor = (pid: ProviderId): string | null =>
		visibleModelsForProvider(catalog, pid, modelEnabledByProvider)[0]?.id ??
		catalog.providers[pid].models[0]?.id ??
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
			title={uiMessage("settings:settings_repository_default_agent")}
			description={uiMessage(
				"settings:settings_repository_override_the_global_default_provider_and_model_for_new_chats_in_this_r",
			)}
			action={<Switch checked={isOverridden} onCheckedChange={onToggle} />}
		>
			{isOverridden ? (
				<div
					role="radiogroup"
					aria-label={uiMessage(
						"settings:settings_repository_repository_default_provider",
					)}
					className="overflow-hidden rounded-lg border border-border/40 bg-background/60"
				>
					{availableProviders.map((pid) => {
						const selected = effectiveProvider === pid;
						const models = visibleModelsForProvider(
							catalog,
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
									className="group flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/40"
								>
									<ProviderIcon providerId={pid} className="size-4 shrink-0" />
									<span className="flex-1 truncate text-xs font-medium text-foreground">
										{PROVIDER_LABEL[pid]}
									</span>
									<RadioCheck active={selected} />
								</button>
								{selected && models.length > 0 && (
									<div className="flex flex-col gap-1.5 px-3 pb-3 pl-10">
										<span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
											{uiMessage("settings:settings_repository_model")}
										</span>
										<div
											role="radiogroup"
											aria-label={uiMessage(
												"settings:settings_repository_model_for",
												{ value1: String(PROVIDER_LABEL[pid]) },
											)}
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
														className="group flex items-center gap-2.5 py-1 text-left"
													>
														<RadioCheck active={isCurrentModel} />
														<span className="text-xs text-foreground">
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
				<p className="rounded-lg border border-border/40 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
					<RichMessage
						id="settings:settings_repository_inheriting_sentence"
						values={{
							value: PROVIDER_LABEL[globalProviderId],
							globalModelLabel: globalModelLabel,
						}}
						components={{ part0: <span className="text-foreground" /> }}
					/>
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const globalMode = useSettingsStore((s) => s.defaultRuntimeMode);
	const effective = currentValue ?? globalMode;
	const isOverridden = currentValue !== null;
	const onToggle = (next: boolean) => {
		if (next) onChange(globalMode);
		else onChange(null);
	};
	return (
		<SettingsRow
			title={uiMessage("settings:settings_repository_default_permission_mode")}
			description={uiMessage(
				"settings:settings_repository_override_the_global_permission_posture_for_new_chats_in_this_repo",
			)}
			action={<Switch checked={isOverridden} onCheckedChange={onToggle} />}
		>
			{isOverridden ? (
				<div
					role="radiogroup"
					aria-label={uiMessage(
						"settings:settings_repository_repository_default_permission_mode",
					)}
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
								className="group flex w-full items-start gap-2.5 border-b border-border/40 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-muted/40"
							>
								<HugeiconsIcon
									icon={m.Icon}
									className="mt-0.5 size-4 shrink-0 text-muted-foreground"
								/>
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="text-xs font-medium text-foreground">
										{m.label}
									</span>
									<span className="text-[11px] leading-snug text-muted-foreground">
										{m.description}
									</span>
								</span>
								<RadioCheck active={selected} className="mt-0.5" />
							</button>
						);
					})}
				</div>
			) : (
				<p className="rounded-lg border border-border/40 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
					<RichMessage
						id="settings:settings_repository_inheriting_sentence_2"
						values={{ value: MODE_META[globalMode].label }}
						components={{ part0: <span className="text-foreground" /> }}
					/>
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

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
		[worktrees, uiMessage],
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
			title={uiMessage("settings:settings_repository_worktrees")}
			description={uiMessage(
				"settings:settings_repository_controls_for_automatic_chat_worktrees_and_the_existing_checkouts_for_t",
			)}
			trailing={
				<span className="text-[11px] text-muted-foreground/80">
					{sorted.length}{" "}
					{sorted.length === 1
						? uiMessage("settings:settings_repository_worktree")
						: uiMessage("settings:settings_repository_worktrees_2")}
				</span>
			}
		>
			<SettingsRow
				title={uiMessage(
					"settings:settings_repository_auto_create_a_worktree_for_new_chats",
				)}
				description={uiMessage(
					"settings:settings_repository_when_on_the_composer_s_workspace_picker_pre_selects_a_fresh_worktree_y",
				)}
				action={
					<Switch checked={autoCreate} onCheckedChange={onAutoCreateChange} />
				}
			/>

			<div className="flex flex-col">
				{sorted.length === 0 ? (
					<p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
						{uiMessage(
							"settings:settings_repository_no_worktrees_yet_zuse_beta_creates_one_for_you_when_you_start_a_new_ch",
						)}
					</p>
				) : (
					<ul className="flex flex-col divide-y divide-border/40">
						{sorted.map((wt) => (
							<li
								key={wt.id}
								className="grid grid-cols-[auto_1fr_auto] items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-muted/20"
							>
								<HugeiconsIcon
									icon={GitBranchIcon}
									className="size-4 shrink-0 text-muted-foreground"
								/>
								<div
									className="flex min-w-0 flex-col gap-0.5"
									title={displayPath(wt.path)}
								>
									<RichMessage
										id="settings:settings_repository_off_sentence"
										values={{
											value: wt.name,
											value2: wt.branch,
											value3: wt.baseBranch,
										}}
										components={{
											part0: (
												<span className="truncate text-xs font-medium text-foreground" />
											),
											part1: (
												<span className="truncate font-mono text-[11px] text-muted-foreground" />
											),
											part2: <span className="text-muted-foreground/60" />,
										}}
									/>
								</div>
								<Button
									variant="settings"
									size="sm"
									loading={removingId === wt.id}
									onClick={() => void onRemove(wt.id)}
									title={uiMessage(
										"settings:settings_repository_remove_the_checkout_uncommitted_changes_are_saved_to_its_branch",
									)}
								>
									<HugeiconsIcon icon={Delete02Icon} className="size-3" />
									{uiMessage("common:remove")}
								</Button>
							</li>
						))}
					</ul>
				)}
			</div>

			<div className="px-3 py-2.5">
				{pendingError !== null ? (
					<p className="text-[11px] leading-relaxed text-red-400">
						{pendingError}
					</p>
				) : (
					<p className="text-[11px] leading-relaxed text-muted-foreground">
						{uiMessage(
							"settings:settings_repository_git_worktrees_for_this_repo_each_lives_under_zuse_lt_repo_gt_lt_name_g",
						)}
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

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
			title={uiMessage("settings:settings_repository_scripts")}
			description={uiMessage(
				"settings:settings_repository_commands_that_run_when_worktrees_are_set_up_run_or_archived",
			)}
		>
			<ScriptEditor
				title={uiMessage("settings:settings_repository_setup_script")}
				description={uiMessage(
					"settings:settings_repository_runs_when_a_new_worktree_is_created",
				)}
				value={setupScript}
				placeholder={uiMessage("settings:settings_repository_bun_i")}
				onChange={onSetupScriptChange}
			/>
			<ScriptEditor
				title={uiMessage("settings:settings_repository_run_script")}
				description={uiMessage(
					"settings:settings_repository_runs_when_you_click_run",
				)}
				value={runScript}
				placeholder={uiMessage("settings:settings_repository_bun_run_dev")}
				onChange={onRunScriptChange}
			/>
			<SettingsRow
				title={uiMessage("settings:settings_repository_auto_run_after_setup")}
				description={uiMessage(
					"settings:settings_repository_start_this_repository_s_run_script_automatically_after_setup",
				)}
				action={
					<Switch
						checked={autoRunAfterSetup}
						onCheckedChange={onAutoRunAfterSetupChange}
					/>
				}
			/>
			<ScriptEditor
				title={uiMessage("settings:settings_repository_archive_script")}
				description={uiMessage(
					"settings:settings_repository_optional_hook_that_runs_before_the_archive_checkpoint",
				)}
				value={archiveScript}
				placeholder={uiMessage(
					"settings:settings_repository_rm_rf_node_modules_next_pkill_f_next_dev_true",
				)}
				onChange={onArchiveScriptChange}
			/>
			<div className="px-3 py-2.5">
				<div className="mb-2">
					<p className="text-xs font-medium text-foreground">
						{uiMessage("settings:settings_repository_environment_variables")}
					</p>
					<p className="text-[11px] text-muted-foreground">
						{uiMessage(
							"settings:settings_repository_key_value_pairs_passed_to_setup_run_and_archive_scripts",
						)}
					</p>
				</div>
				<CodeTextarea
					value={envDraft}
					onChange={(event) => setEnvDraft(event.currentTarget.value)}
					onBlur={persistEnv}
					placeholder={uiMessage("settings:settings_repository_zuse_port_5733")}
					minHeightClassName="min-h-24"
				/>
			</div>
			<FileIncludesEditor
				value={fileIncludeGlobs}
				onChange={onFileIncludeGlobsChange}
			/>
			<div className="px-3 py-2.5">
				<p className="text-[11px] leading-relaxed text-muted-foreground">
					<RichMessage
						id="settings:settings_repository_want_to_hand_edit_or_share_repository_settings_use_zuse_sett_sentence"
						components={{ part0: <span className="font-mono" /> }}
					/>
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	const persist = () => {
		if (draft !== value) onChange(draft);
	};
	return (
		<div className="px-3 py-2.5">
			<div className="mb-2">
				<p className="text-xs font-medium text-foreground">
					{uiMessage("settings:settings_repository_worktree_file_includes")}
				</p>
				<p className="text-[11px] text-muted-foreground">
					{uiMessage(
						"settings:settings_repository_one_pattern_per_line_linked_from_the_main_checkout_into_each_new_workt",
					)}
				</p>
			</div>
			<CodeTextarea
				value={draft}
				onChange={(event) => setDraft(event.currentTarget.value)}
				onBlur={persist}
				placeholder={uiMessage(
					"settings:settings_repository_env_env_local_env_local",
				)}
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const [draft, setDraft] = useState(value ?? "");
	useEffect(() => setDraft(value ?? ""), [value]);
	const persist = () => {
		const next = draft.trim().length === 0 ? null : draft;
		if ((value ?? "") !== (next ?? "")) onChange(next);
	};
	return (
		<div className="px-3 py-2.5">
			<div className="mb-2 flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-xs font-medium text-foreground">{title}</p>
					<p className="text-[11px] text-muted-foreground">{description}</p>
				</div>
				<span className="rounded-md border border-border/40 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
					{uiMessage("settings:settings_repository_shell")}
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
					"resize-y border-0 bg-transparent px-3 py-2 font-mono text-[11px] leading-4 shadow-none outline-none placeholder:text-muted-foreground/50 focus-visible:ring-0",
					minHeightClassName,
					className,
				)}
				{...props}
			/>
		</div>
	);
}
