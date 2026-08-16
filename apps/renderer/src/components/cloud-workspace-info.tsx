import { HugeiconsIcon } from "@hugeicons/react";
import type { CloudChatSummary } from "@zuse/contracts";
import {
	Activity01Icon,
	Copy01Icon,
	CpuIcon,
	HardDriveIcon,
	RamMemoryIcon,
	Refresh01Icon,
} from "@zuse/icons/solid-rounded";
import { ChevronDown, SquareTerminal } from "lucide-react";
import { useState } from "react";

import type { OpenTarget } from "../lib/bridge.ts";
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
	pickCloudSyncFolder,
	useCloudSyncStatus,
} from "../lib/cloud-sync-client-bus.ts";
import { useCloudChatCatalogStore } from "../lib/cloud-workspace-catalog.ts";
import { runControlPlane } from "../lib/control-plane-client.ts";
import { displayPath } from "../lib/display-path.ts";
import { useMachineResources } from "../lib/machine-resources-client-bus.ts";
import { copyText } from "../lib/platform-capabilities.ts";
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
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuShortcut,
	MenuTrigger,
} from "./ui/menu.tsx";
import { Switch } from "./ui/switch.tsx";
import { toastManager } from "./ui/toast.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

/** Shared row idiom for the Summary aside (also used by EnvironmentSummary). */
export const summaryRowClass =
	"group flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

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

const errorMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

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
			title: "Could not open via SSH",
			description: errorMessage(cause),
		});
	}
};

const copySshCommand = async (workspaceId: string): Promise<void> => {
	try {
		const prepared = await prepareCloudWorkspaceSsh(workspaceId);
		await copyText(prepared.sshCommand);
		toastManager.add({
			type: "success",
			title: "SSH command copied",
			description: prepared.sshCommand,
		});
	} catch (cause) {
		toastManager.add({
			type: "error",
			title: "Could not prepare SSH access",
			description: errorMessage(cause),
		});
	}
};

const SSH_TARGETS: ReadonlyArray<{
	readonly id: CloudSshTarget;
	readonly label: string;
}> = [
	{ id: "cursor", label: "Cursor" },
	{ id: "zed", label: "Zed" },
	{ id: "terminal", label: "Terminal" },
];

/**
 * Top-bar split button for cloud workspaces — replaces the local "Open in…"
 * menu, which cannot act on a remote workspace path. Also hosts the
 * cloud→local directory sync toggle, mirroring the SSH/sync pairing.
 */
export function CloudWorkspaceOpenSshMenu({
	workspaceId,
	className = "",
}: {
	readonly workspaceId: string;
	readonly className?: string;
}) {
	const summary = useCloudSummary(workspaceId);
	const syncPrefs = useCloudChatCatalogStore(
		(state) => state.syncPrefs[workspaceId] ?? null,
	);
	const syncStatus = useCloudSyncStatus(workspaceId);
	const [syncBusy, setSyncBusy] = useState(false);
	const [installedTargets, setInstalledTargets] = useState<
		ReadonlyArray<OpenTarget>
	>([]);
	if (!cloudSshSupported() || summary === null) return null;
	const running = summary.state === "ready";
	const syncEnabled = syncPrefs?.enabled === true;

	const toggleSync = async (): Promise<void> => {
		if (syncBusy) return;
		setSyncBusy(true);
		try {
			if (syncEnabled) {
				await disableCloudSync(workspaceId);
				return;
			}
			const localPath =
				syncPrefs?.localPath ?? (await pickCloudSyncFolder()) ?? null;
			if (localPath === null) return;
			await enableCloudSync(workspaceId, localPath);
		} catch (cause) {
			toastManager.add({
				type: "error",
				title: "Could not sync this workspace",
				description: errorMessage(cause),
			});
		} finally {
			setSyncBusy(false);
		}
	};

	const syncState = syncStatus?.state ?? "idle";
	const syncDotClass =
		syncState === "in-sync"
			? "bg-[var(--accent-green)]"
			: syncState === "syncing"
				? "animate-pulse bg-[var(--accent-yellow,#eab308)]"
				: syncState === "error"
					? "bg-[var(--accent-red)]"
					: "bg-muted-foreground/50";
	const syncStateLabel =
		syncState === "in-sync"
			? "In sync"
			: syncState === "syncing"
				? "Syncing…"
				: syncState === "error"
					? "Sync error"
					: "Waiting";

	const refreshTargets = async (): Promise<void> => {
		const list = await (
			globalThis.window?.zuse ?? globalThis.window?.memoize
		)?.app?.listOpenTargets?.("");
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
		<Menu>
			<Tooltip>
				<TooltipTrigger
					render={
						<MenuTrigger
							disabled={!running}
							onClick={() => void refreshTargets()}
							className={`${className} flex h-7 items-center gap-1.5 overflow-hidden rounded-md border border-border/80 px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:pointer-events-none disabled:opacity-50`}
							aria-label="Open workspace via SSH"
						>
							<SquareTerminal className="size-3.5 shrink-0" />
							<span>Open via SSH</span>
							<ChevronDown className="size-3.5 shrink-0" />
						</MenuTrigger>
					}
				/>
				<TooltipPopup>
					{running
						? "Open this workspace in an editor or terminal over SSH"
						: "The workspace must be running for SSH access"}
				</TooltipPopup>
			</Tooltip>
			<MenuPopup align="end" className="min-w-56">
				{SSH_TARGETS.map((target, index) => (
					<MenuItem
						key={target.id}
						onClick={() => void launchSsh(workspaceId, target.id)}
						className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-sidebar-accent"
					>
						<OpenTargetIcon target={iconTarget(target.id, target.label)} />
						<span className="min-w-0 flex-1 truncate">{target.label}</span>
						<MenuShortcut>{index + 1}</MenuShortcut>
					</MenuItem>
				))}
				<MenuSeparator />
				<MenuItem
					onClick={() => void copySshCommand(workspaceId)}
					className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-sidebar-accent"
				>
					<HugeiconsIcon
						icon={Copy01Icon}
						className="size-5 shrink-0 text-muted-foreground"
					/>
					<span className="min-w-0 flex-1 truncate">Copy SSH command</span>
					<MenuShortcut>{SSH_TARGETS.length + 1}</MenuShortcut>
				</MenuItem>
				{cloudSyncSupported() ? (
					<>
						<MenuSeparator />
						<MenuItem
							closeOnClick={false}
							onClick={() => void toggleSync()}
							className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-sidebar-accent"
						>
							<span className="min-w-0 flex-1 truncate">
								Sync to a local directory
							</span>
							<Switch
								checked={syncEnabled}
								disabled={syncBusy || (!running && !syncEnabled)}
								className="pointer-events-none"
							/>
						</MenuItem>
						{syncEnabled ? (
							<div
								className="flex items-center gap-2 px-2 pb-1.5 pt-0.5 text-xs text-muted-foreground"
								title={syncStatus?.error ?? undefined}
							>
								<span
									className={`size-1.5 shrink-0 rounded-full ${syncDotClass}`}
								/>
								<span className="shrink-0">{syncStateLabel}</span>
								{syncPrefs !== null ? (
									<span className="min-w-0 flex-1 truncate text-right font-mono text-[10px]">
										{displayPath(syncPrefs.localPath)}
									</span>
								) : null}
							</div>
						) : null}
					</>
				) : null}
			</MenuPopup>
		</Menu>
	);
}

/**
 * Summary-aside row for cloud workspaces: "Performance" opens a side menu
 * with status + restart and live CPU/memory/disk, mirroring the "Running on"
 * row idiom. SSH and sync live in the top bar (`CloudWorkspaceOpenSshMenu`).
 */
export function CloudWorkspaceInfo({
	workspaceId,
}: {
	readonly workspaceId: string;
}) {
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
				title: "Could not restart the workspace",
				description: errorMessage(cause),
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
						icon={Activity01Icon}
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<span className="min-w-0 flex-1 truncate">Performance</span>
					<span className="shrink-0 text-[10px] text-muted-foreground">
						{workspaceStateLabel(summary)}
					</span>
				</MenuTrigger>
				<MenuPopup
					side="left"
					align="start"
					sideOffset={8}
					className="w-72 rounded-2xl p-1.5"
				>
					<div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
						Performance
					</div>
					<div className="flex min-h-7 items-center gap-2 px-2 py-1 text-xs">
						<HugeiconsIcon
							icon={Activity01Icon}
							className="size-3.5 text-muted-foreground"
						/>
						<span className="flex-1">Status</span>
						<span
							className={`text-[11px] ${running ? "text-[var(--accent-green)]" : "text-muted-foreground"}`}
						>
							{workspaceStateLabel(summary)}
						</span>
					</div>
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
							Live usage needs the updated workspace runtime.
						</div>
					) : null}
					<MenuSeparator />
					<MenuItem
						disabled={!running}
						onClick={() => setRestartOpen(true)}
						className="gap-2 px-2 py-1 text-xs"
					>
						<HugeiconsIcon icon={Refresh01Icon} className="size-3.5" />
						<span className="flex-1">Restart workspace</span>
					</MenuItem>
				</MenuPopup>
			</Menu>
			<AlertDialog open={restartOpen} onOpenChange={setRestartOpen}>
				<AlertDialogPopup className="max-w-sm">
					<AlertDialogHeader>
						<AlertDialogTitle>Restart this workspace?</AlertDialogTitle>
						<AlertDialogDescription>
							The runtime restarts in place: any agent turn in progress is
							interrupted, and open terminals reconnect. Files in the workspace
							are preserved.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button size="xs" variant="ghost" />}>
							Cancel
						</AlertDialogClose>
						<Button
							size="xs"
							loading={restarting}
							onClick={() => void restart()}
						>
							Restart
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</>
	);
}
