import "@zuse/i18n/english/connections";
import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/settings";
import { HugeiconsIcon } from "@hugeicons/react";
import type { CloudChatSummary } from "@zuse/contracts";
import { formatDate, message as uiMessage } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	Activity01Icon,
	ArrowDown01Icon,
	Calendar03Icon,
	CloudIcon,
	Copy01Icon,
	CpuIcon,
	Folder01Icon,
	HardDriveIcon,
	RamMemoryIcon,
	Refresh01Icon,
} from "@zuse/icons/solid-rounded";
import { useState } from "react";
import { getAppBridge, type OpenTarget } from "../lib/bridge.ts";
import { cloudProviderLabel } from "../lib/cloud-provider-presentation.ts";
import {
	type CloudSshTarget,
	cloudSshSupported,
	openCloudWorkspaceSsh,
	prepareCloudWorkspaceSsh,
} from "../lib/cloud-ssh-client-bus.ts";
import {
	cloudSyncSupported,
	disableCloudSync,
	enableCloudSync,
	useCloudSyncStatus,
} from "../lib/cloud-sync-client-bus.ts";
import { cloudSyncPresentation } from "../lib/cloud-sync-presentation.ts";
import {
	cloudSyncPreferenceEnabled,
	useCloudChatCatalogStore,
} from "../lib/cloud-workspace-catalog.ts";
import { isCloudWorkspaceReady } from "../lib/cloud-workspace-lifecycle.ts";
import { runControlPlane } from "../lib/control-plane-client.ts";
import { errorMessage } from "../lib/error-message.ts";
import { useMachineResources } from "../lib/machine-resources-client-bus.ts";
import { openPathInTarget } from "../lib/open-path-in-target.ts";
import { copyText } from "../lib/platform-capabilities.ts";

import { DitherCloudIcon } from "./dither-cloud-icon.tsx";
import { OpenTargetIcon } from "./open-target-icon.tsx";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";
import {
	compactMenuItemClass,
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuSub,
	MenuSubPopup,
	MenuSubTrigger,
	MenuTrigger,
} from "./ui/menu.tsx";
import { Switch } from "./ui/switch.tsx";
import { toastManager } from "./ui/toast.tsx";

/** Shared row idiom for the Summary aside (also used by EnvironmentSummary). */
export const summaryRowClass =
	"group flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

const workspaceMenuRowClass = `flex w-full min-w-0 items-center ${compactMenuItemClass}`;

const formatGigabytes = (bytes: number): string =>
	`${(bytes / 1_000_000_000).toFixed(1)} GB`;

const formatPercent = (value: number): string => `${value.toFixed(1)}%`;

const workspaceStateLabel = (summary: CloudChatSummary): string => {
	switch (summary.state) {
		case "ready":
			return "Running";
		case "paused":
			return "Paused";
		case "pausing":
			return "Pausing…";
		case "failed":
			return "Failed";
		case "archiving":
		case "archived":
			return "Archived";
		case "deleting":
		case "deleted":
			return "Deleted";
		default:
			return "Starting…";
	}
};

const workspaceStateDotClass = (summary: CloudChatSummary): string => {
	switch (summary.state) {
		case "ready":
			return "bg-[var(--accent-green)]";
		case "failed":
			return "bg-[var(--accent-red)]";
		case "paused":
		case "archiving":
		case "archived":
		case "deleting":
		case "deleted":
			return "bg-muted-foreground/50";
		default:
			return "bg-[var(--accent-amber)]";
	}
};

const useCloudSummary = (workspaceId: string): CloudChatSummary | null =>
	useCloudChatCatalogStore(
		(state) =>
			state.summaries.find(
				(candidate) => candidate.workspaceId === workspaceId,
			) ?? null,
	);

/** True when the active environment is a cloud workspace chat. */
export const useIsCloudWorkspace = (environmentId: string | null): boolean =>
	useCloudChatCatalogStore(
		(state) =>
			environmentId !== null &&
			state.summaries.some(
				(candidate) => candidate.workspaceId === environmentId,
			),
	);

const launchSsh = async (
	workspaceId: string,
	target: CloudSshTarget,
): Promise<void> => {
	try {
		await openCloudWorkspaceSsh(workspaceId, target);
	} catch (cause) {
		toastManager.add({
			type: "error",
			title: uiMessage(
				"connections:cloud_workspace_info_could_not_open_via_ssh",
			),
			description: errorMessage(cause, "SSH access failed."),
		});
	}
};

const copySshCommand = async (workspaceId: string): Promise<void> => {
	try {
		const prepared = await prepareCloudWorkspaceSsh(workspaceId);
		await copyText(prepared.sshCommand);
		toastManager.add({
			type: "success",
			title: uiMessage("connections:cloud_workspace_info_ssh_command_copied"),
			description: prepared.sshCommand,
		});
	} catch (cause) {
		toastManager.add({
			type: "error",
			title: uiMessage(
				"connections:cloud_workspace_info_could_not_prepare_ssh_access",
			),
			description: errorMessage(cause, "SSH access failed."),
		});
	}
};

const SSH_TARGETS: ReadonlyArray<{
	readonly id: CloudSshTarget;
	readonly label: string;
}> = [
	{
		id: "cursor",
		get label() {
			return uiMessage("connections:cloud_workspace_info_cursor");
		},
	},
	{
		id: "zed",
		get label() {
			return uiMessage("connections:cloud_workspace_info_zed");
		},
	},
	{
		id: "terminal",
		get label() {
			return uiMessage("connections:cloud_workspace_info_terminal");
		},
	},
];

/**
 * Compact workspace identity and actions, with SSH nested below its details.
 * Performance remains in the Environment Summary.
 */
export function CloudWorkspaceMenu({
	workspaceId,
	className = "",
}: {
	readonly workspaceId: string;
	readonly className?: string;
}) {
	const { message: uiMessage } = useUiMessages([
		"common",
		"connections",
		"chat",
	]);

	const summary = useCloudSummary(workspaceId);
	const syncPrefs = useCloudChatCatalogStore(
		(state) => state.syncPrefs[workspaceId] ?? null,
	);
	const syncStatus = useCloudSyncStatus(workspaceId);
	const [syncBusy, setSyncBusy] = useState(false);
	const [installedTargets, setInstalledTargets] = useState<
		ReadonlyArray<OpenTarget>
	>([]);
	const [menuOpen, setMenuOpen] = useState(false);
	if (summary === null) return null;
	const running = isCloudWorkspaceReady(summary);
	const syncEnabled = cloudSyncPreferenceEnabled(syncPrefs);

	const toggleSync = async (): Promise<void> => {
		if (syncBusy) return;
		setSyncBusy(true);
		try {
			if (syncEnabled) {
				await disableCloudSync(workspaceId);
				return;
			}
			await enableCloudSync(workspaceId);
		} catch (cause) {
			toastManager.add({
				type: "error",
				title: uiMessage(
					"connections:cloud_workspace_info_could_not_sync_this_workspace",
				),
				description: errorMessage(cause, "Cloud sync failed."),
			});
		} finally {
			setSyncBusy(false);
		}
	};

	const syncPresentation = cloudSyncPresentation(syncStatus);

	const refreshTargets = async (): Promise<void> => {
		const list = await getAppBridge()
			?.listOpenTargets?.(syncStatus?.localPath ?? "")
			.catch(() => undefined);
		if (list !== undefined) setInstalledTargets(list);
	};

	const iconTarget = (id: CloudSshTarget, label: string): OpenTarget =>
		installedTargets.find((candidate) => candidate.id === id) ?? {
			id,
			label,
			available: true,
			iconDataUrl: null,
		};

	return (
		<div className={`flex min-w-0 items-center gap-0.5 ${className}`}>
			<Menu open={menuOpen} onOpenChange={setMenuOpen}>
				<MenuTrigger
					onClick={() => void refreshTargets()}
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-muted/60 data-[popup-open]:bg-muted/60"
					title={uiMessage("connections:cloud_workspace_menu_details")}
					aria-label={uiMessage("connections:cloud_workspace_menu_details")}
				>
					<DitherCloudIcon
						className={`size-4 shrink-0 ${running ? "text-[var(--accent-green)]" : "text-muted-foreground"}`}
					/>
				</MenuTrigger>
				<MenuPopup align="end" className="w-80 max-w-[calc(100vw-1rem)]">
					<div className="divide-y divide-border">
						{[
							{
								label: uiMessage("connections:cloud_workspace_menu_repository"),
								icon: Folder01Icon,
								value: summary.repositoryDisplayName,
								title: summary.repositoryIdentity,
							},
							{
								label: uiMessage(
									"connections:cloud_workspace_menu_environment",
								),
								icon: CloudIcon,
								value: cloudProviderLabel(summary.providerId),
							},
							{
								label: uiMessage("connections:cloud_workspace_info_status"),
								icon: Activity01Icon,
								value: workspaceStateLabel(summary),
							},
							{
								label: uiMessage("connections:cloud_workspace_menu_created"),
								icon: Calendar03Icon,
								value: (
									<time dateTime={new Date(summary.createdAt).toISOString()}>
										{formatDate(summary.createdAt, {
											month: "short",
											day: "numeric",
											hour: "numeric",
											minute: "2-digit",
										})}
									</time>
								),
							},
						].map(({ label, icon, value, title }) => (
							<div key={label} className={workspaceMenuRowClass} title={title}>
								<HugeiconsIcon
									icon={icon}
									className="size-3.5 text-muted-foreground"
								/>
								<span className="shrink-0">{label}</span>
								<span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
									{value}
								</span>
							</div>
						))}
					</div>
					{cloudSshSupported() ? (
						<>
							<MenuSeparator />
							<MenuSub>
								<MenuSubTrigger
									disabled={!running}
									className={`${workspaceMenuRowClass} my-2 w-[calc(100%-1rem)] mx-2 border border-foreground/15 bg-black/5 pr-0 font-mono text-foreground dark:bg-black/30 [&>svg:last-child]:hidden [&_svg]:text-muted-foreground`}
								>
									<span className="size-4 shrink-0 [&>*]:size-4">
										<OpenTargetIcon
											target={
												installedTargets.find(
													(target) =>
														target.available &&
														SSH_TARGETS.some((ssh) => ssh.id === target.id),
												) ??
												iconTarget(
													"cursor",
													uiMessage("connections:cloud_workspace_info_cursor"),
												)
											}
										/>
									</span>
									<span className="min-w-0 flex-1 truncate">
										{uiMessage("connections:cloud_workspace_info_open_via_ssh")}
									</span>
									<span className="flex h-7 w-7 shrink-0 items-center justify-center border-l border-foreground/15">
										<HugeiconsIcon
											icon={ArrowDown01Icon}
											className="size-3.5"
										/>
									</span>
								</MenuSubTrigger>
								<MenuSubPopup className="w-52">
									{SSH_TARGETS.map((target) => (
										<MenuItem
											key={target.id}
											onClick={() => void launchSsh(workspaceId, target.id)}
											className={workspaceMenuRowClass}
										>
											<span className="size-4 shrink-0 [&>*]:size-4">
												<OpenTargetIcon
													target={iconTarget(target.id, target.label)}
												/>
											</span>
											<span className="min-w-0 flex-1 truncate">
												{target.label}
											</span>
										</MenuItem>
									))}
									<MenuSeparator />
									<MenuItem
										onClick={() => void copySshCommand(workspaceId)}
										className={workspaceMenuRowClass}
									>
										<span className="size-4 shrink-0">
											<HugeiconsIcon
												icon={Copy01Icon}
												className="size-4 text-muted-foreground"
											/>
										</span>
										<span className="min-w-0 flex-1 truncate">
											{uiMessage(
												"connections:cloud_workspace_info_copy_ssh_command",
											)}
										</span>
									</MenuItem>
								</MenuSubPopup>
							</MenuSub>
						</>
					) : null}
					{cloudSyncSupported() ? (
						<>
							<MenuSeparator />
							<div className={`${workspaceMenuRowClass} mt-2`}>
								<span className="min-w-0 flex-1 truncate">
									{uiMessage(
										"connections:cloud_workspace_info_sync_to_a_local_directory",
									)}
								</span>
								<Switch
									checked={syncEnabled}
									disabled={syncBusy || (!running && !syncEnabled)}
									onCheckedChange={() => void toggleSync()}
									aria-label={uiMessage(
										"connections:cloud_workspace_info_sync_to_a_local_directory",
									)}
								/>
							</div>
							{syncEnabled ? (
								<div className="px-2 pb-2 text-xs text-muted-foreground">
									<div
										className="flex h-7 items-center gap-2"
										title={syncPresentation.detail ?? undefined}
									>
										<span
											className={`size-1.5 shrink-0 rounded-full ${syncPresentation.dotClass}`}
										/>
										<span className="truncate">{syncPresentation.label}</span>
									</div>
									{syncStatus?.localPath ? (
										<MenuSub>
											<MenuSubTrigger
												className={`${workspaceMenuRowClass} mt-1 border border-foreground/15 bg-black/5 pr-0 font-mono text-foreground dark:bg-black/30 [&>svg:last-child]:hidden`}
												aria-label={uiMessage("chat:top_bar_open_in")}
												title={syncStatus.localPath}
											>
												<HugeiconsIcon
													icon={Folder01Icon}
													className="size-4 text-muted-foreground"
												/>
												<span className="min-w-0 flex-1 truncate">
													{syncStatus.localPath}
												</span>
												<span className="flex h-7 w-7 shrink-0 items-center justify-center border-l border-foreground/15">
													<HugeiconsIcon
														icon={ArrowDown01Icon}
														className="size-3.5"
													/>
												</span>
											</MenuSubTrigger>
											<MenuSubPopup className="w-52">
												{installedTargets
													.filter((target) => target.available)
													.map((target) => (
														<MenuItem
															key={target.id}
															className={workspaceMenuRowClass}
															onClick={() => {
																const path = syncStatus?.localPath;
																if (path)
																	void openPathInTarget(path, target.id).catch(
																		(cause) =>
																			toastManager.add({
																				type: "error",
																				title: errorMessage(
																					cause,
																					"Could not open folder.",
																				),
																			}),
																	);
															}}
														>
															<span className="size-4 shrink-0 [&>*]:size-4">
																<OpenTargetIcon target={target} />
															</span>
															<span className="min-w-0 flex-1 truncate">
																{target.label}
															</span>
														</MenuItem>
													))}
												<MenuSeparator />
												<MenuItem
													className={workspaceMenuRowClass}
													onClick={() => {
														const path = syncStatus?.localPath;
														if (path)
															void copyText(path).catch((cause) =>
																toastManager.add({
																	type: "error",
																	title: errorMessage(
																		cause,
																		"Could not copy folder path.",
																	),
																}),
															);
													}}
												>
													<span className="size-4 shrink-0">
														<HugeiconsIcon
															icon={Copy01Icon}
															className="size-4 text-muted-foreground"
														/>
													</span>
													<span className="min-w-0 flex-1 truncate">
														{uiMessage("chat:top_bar_copy_path")}
													</span>
												</MenuItem>
											</MenuSubPopup>
										</MenuSub>
									) : null}
									{syncPresentation.detail ? (
										<div className="mt-1 line-clamp-2 text-[11px] leading-relaxed">
											{syncPresentation.detail}
										</div>
									) : null}
								</div>
							) : null}
						</>
					) : null}
				</MenuPopup>
			</Menu>
		</div>
	);
}

/**
 * Summary-aside environment row for cloud workspaces: names the sandbox
 * provider with its live state, and opens a side menu with CPU/memory/disk and
 * restart. SSH and sync live in the top bar (`CloudWorkspaceMenu`).
 */
export function CloudWorkspaceInfo({
	workspaceId,
}: {
	readonly workspaceId: string;
}) {
	const { message: uiMessage } = useUiMessages([
		"common",
		"connections",
		"settings",
	]);

	const summary = useCloudSummary(workspaceId);
	const running = summary?.state === "ready";
	const [menuOpen, setMenuOpen] = useState(false);
	// Stream stats only while the menu is open and the runtime is online: the
	// stream itself counts as workspace activity, and retaining it against a
	// pausing workspace would race its shutdown.
	const resources = useMachineResources(
		menuOpen && running && summary.runtimeState === "online"
			? { environmentId: workspaceId as never }
			: null,
	);
	const sample = resources.data?.sample ?? null;
	const [restartOpen, setRestartOpen] = useState(false);
	const [restarting, setRestarting] = useState(false);
	if (summary === null) return null;

	const restart = async (): Promise<void> => {
		setRestarting(true);
		try {
			await runControlPlane((client) =>
				client["cloud.workspaces.restart"]({
					workspaceId,
					commandId: crypto.randomUUID(),
				}),
			);
			setRestartOpen(false);
		} catch (cause) {
			toastManager.add({
				type: "error",
				title: uiMessage(
					"connections:cloud_workspace_info_could_not_restart_the_workspace",
				),
				description: errorMessage(cause, "Workspace restart failed."),
			});
		} finally {
			setRestarting(false);
		}
	};

	const statRow = (
		icon: React.ComponentProps<typeof HugeiconsIcon>["icon"],
		label: string,
		value: string | null,
	) => (
		<div className="flex min-h-7 items-center gap-2 px-2 py-1 text-xs">
			<HugeiconsIcon icon={icon} className="size-3.5 text-muted-foreground" />
			<span className="flex-1">{label}</span>
			<span className="truncate text-right text-[11px] tabular-nums text-muted-foreground">
				{value ?? "—"}
			</span>
		</div>
	);

	return (
		<>
			<Menu open={menuOpen} onOpenChange={setMenuOpen}>
				<MenuTrigger
					className={`${summaryRowClass} hover:bg-muted/60 data-[popup-open]:bg-muted/60`}
				>
					<HugeiconsIcon
						icon={CloudIcon}
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<span className="min-w-0 flex-1 truncate">
						{cloudProviderLabel(summary.providerId)}
					</span>
					<span className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
						{workspaceStateLabel(summary)}
						<span
							className={`size-1.5 rounded-full ${workspaceStateDotClass(summary)}`}
						/>
					</span>
				</MenuTrigger>
				<MenuPopup
					side="left"
					align="start"
					sideOffset={8}
					className="w-72 p-1"
				>
					<div className="flex h-7 items-center gap-2 px-2 text-xs">
						<span className="min-w-0 flex-1 truncate font-medium">
							{cloudProviderLabel(summary.providerId)}
						</span>
						<span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
							{workspaceStateLabel(summary)}
							<span
								className={`size-1.5 rounded-full ${workspaceStateDotClass(summary)}`}
							/>
						</span>
					</div>
					<MenuSeparator />
					{statRow(
						CpuIcon,
						"CPU",
						sample === null
							? null
							: `${sample.cpuCores} cores · ${formatPercent(sample.cpuPercent)} used`,
					)}
					{statRow(
						RamMemoryIcon,
						"Memory",
						sample === null
							? null
							: `${formatGigabytes(sample.memTotalBytes)} · ${formatPercent(
									sample.memTotalBytes > 0
										? (sample.memUsedBytes / sample.memTotalBytes) * 100
										: 0,
								)} used`,
					)}
					{statRow(
						HardDriveIcon,
						"Disk",
						sample === null
							? null
							: `${formatGigabytes(sample.diskTotalBytes)} · ${formatPercent(
									sample.diskTotalBytes > 0
										? (sample.diskUsedBytes / sample.diskTotalBytes) * 100
										: 0,
								)} used`,
					)}
					{sample === null && running ? (
						<div className="px-2 py-1 text-[10px] leading-4 text-muted-foreground/70">
							{resources.sync === "failed"
								? uiMessage(
										"settings:cloud_workspace_pool_usage_details_are_temporarily_unavailable",
									)
								: uiMessage("common:loading")}
						</div>
					) : null}
					<MenuSeparator />
					<MenuItem
						disabled={!running}
						onClick={() => setRestartOpen(true)}
						className="gap-2 px-2 py-1 text-xs"
					>
						<HugeiconsIcon icon={Refresh01Icon} className="size-3.5" />
						<span className="flex-1">
							{uiMessage("connections:cloud_workspace_info_restart_workspace")}
						</span>
					</MenuItem>
				</MenuPopup>
			</Menu>
			<AlertDialog open={restartOpen} onOpenChange={setRestartOpen}>
				<AlertDialogPopup className="max-w-sm">
					<AlertDialogHeader>
						<AlertDialogTitle>
							{uiMessage(
								"connections:cloud_workspace_info_restart_this_workspace",
							)}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{uiMessage(
								"connections:cloud_workspace_info_the_runtime_restarts_in_place_any_agent_turn_in_progress_is_interrupte",
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button size="xs" variant="ghost" />}>
							{uiMessage("common:cancel")}
						</AlertDialogClose>
						<Button
							size="xs"
							loading={restarting}
							onClick={() => void restart()}
						>
							{uiMessage("connections:cloud_workspace_info_restart")}
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</>
	);
}
