import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowDown01Icon,
	CloudIcon,
	ComputerIcon,
	Tick01Icon,
} from "@hugeicons-pro/core-solid-rounded";

import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuTrigger,
} from "~/components/ui/menu";
import {
	type ComputerPickerItem,
	computerPickerItems,
	type LogicalProjectGroup,
	type NewChatTarget,
} from "~/lib/project-groups.ts";
import { cn } from "~/lib/utils";
import type { EnvironmentCatalogEntry } from "~/store/environment-catalog.ts";
import { openAddComputerDialog } from "../add-computer-dialog.tsx";

const statusText = (item: ComputerPickerItem): string =>
	item.retryable
		? "Retry"
		: !item.projectAvailable && item.status === "connected"
			? item.setupAvailable
				? "Clone project"
				: "Git remote required"
			: item.status === "connecting"
				? "Connecting…"
				: item.status === "error"
					? "Can't connect"
					: item.status === "offline"
						? "Offline"
						: "Connected";

export type CloudComputerPickerItem = {
	readonly providerId: string;
	readonly providerLabel: string;
	readonly disabled: boolean;
	readonly statusText: string | null;
};

/**
 * "Run on" control for the Chat Lander: picks which computer a new chat runs
 * on within the selected logical project. A pure controlled selector —
 * picking re-targets the pending draft ONLY. It never switches the active
 * environment, so the sidebar, the typed text, and the rest of the app stay
 * exactly where they are.
 *
 * Hidden when there is nothing to choose (the only member is on this
 * desktop); a static label when the only member is remote.
 */
export function ComputerPicker({
	group,
	target,
	entries,
	onPickTarget,
	cloudItems = [],
	selectedCloudProviderId = null,
	onPickCloud,
	onRetryEnvironment,
}: {
	group: LogicalProjectGroup | null;
	target: NewChatTarget | null;
	entries: ReadonlyArray<EnvironmentCatalogEntry>;
	onPickTarget: (target: NewChatTarget) => void;
	cloudItems?: ReadonlyArray<CloudComputerPickerItem>;
	selectedCloudProviderId?: string | null;
	onPickCloud?: (providerId: string) => void;
	onRetryEnvironment: (environmentId: string) => void;
}) {
	if (group === null) return null;
	const model = computerPickerItems(group, target, entries);
	if (model.kind === "hidden" && cloudItems.length === 0) return null;

	if (model.kind === "static" && cloudItems.length === 0) {
		return (
			<span className="flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground">
				<HugeiconsIcon icon={ComputerIcon} className="size-3.5" />
				<span className="truncate">{model.item.label}</span>
			</span>
		);
	}

	const computerItems = model.kind === "menu" ? model.items : [model.item];
	const current =
		computerItems.find((item) => item.selected) ?? computerItems[0] ?? null;
	const cloudSelected = selectedCloudProviderId !== null;
	const pick = (item: ComputerPickerItem): void => {
		if (item.retryable) {
			onRetryEnvironment(item.environmentId);
			return;
		}
		if (item.disabled || item.selected) return;
		onPickTarget({
			environmentId: item.environmentId,
			folderId: item.folderId,
		});
	};

	return (
		<Menu>
			<MenuTrigger
				className="flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-accent data-[popup-open]:bg-accent"
				aria-label="Run on computer"
			>
				<HugeiconsIcon
					icon={cloudSelected ? CloudIcon : ComputerIcon}
					className="size-3.5"
				/>
				<span className="truncate">
					{cloudSelected ? "Cloud Sandbox" : (current?.label ?? "Run on")}
				</span>
				<HugeiconsIcon icon={ArrowDown01Icon} className="size-3 opacity-60" />
			</MenuTrigger>
			<MenuPopup side="bottom" align="start" className="w-64 p-1">
				{computerItems.map((item) => (
					<MenuItem
						key={`${item.environmentId}:${item.folderId ?? "unavailable"}`}
						disabled={item.disabled}
						onClick={() => pick(item)}
						className={cn(
							"grid grid-cols-[1rem_auto_1fr_auto] items-center gap-x-2 rounded-md px-2 py-1.5 text-sm",
							item.selected
								? "bg-accent/40 text-accent-foreground data-highlighted:bg-accent/60"
								: undefined,
						)}
					>
						<span className="col-start-1 row-start-1 flex items-center justify-center">
							{item.selected && !cloudSelected && (
								<HugeiconsIcon
									icon={Tick01Icon}
									className="size-3.5 opacity-90"
								/>
							)}
						</span>
						<HugeiconsIcon
							icon={ComputerIcon}
							className="col-start-2 row-start-1 size-3.5 opacity-80"
						/>
						<span className="col-start-3 row-start-1 truncate">
							{item.label}
						</span>
						{!item.selected &&
						(item.status !== "connected" || !item.projectAvailable) ? (
							<span className="col-start-4 row-start-1 text-[10px] text-muted-foreground">
								{statusText(item)}
							</span>
						) : null}
					</MenuItem>
				))}
				{cloudItems.length > 0 ? (
					<>
						<MenuSeparator />
						{cloudItems.map((item) => {
							const selected = item.providerId === selectedCloudProviderId;
							return (
								<MenuItem
									key={`cloud:${item.providerId}`}
									disabled={item.disabled}
									onClick={() => onPickCloud?.(item.providerId)}
									className={cn(
										"grid grid-cols-[1rem_auto_1fr_auto] items-center gap-x-2 rounded-md px-2 py-1.5 text-sm",
										selected
											? "bg-accent/40 text-accent-foreground data-highlighted:bg-accent/60"
											: undefined,
									)}
								>
									<span className="col-start-1 flex items-center justify-center">
										{selected ? (
											<HugeiconsIcon icon={Tick01Icon} className="size-3.5" />
										) : null}
									</span>
									<HugeiconsIcon
										icon={CloudIcon}
										className="col-start-2 size-3.5 opacity-80"
									/>
									<span className="col-start-3 truncate">Cloud Sandbox</span>
									<span className="col-start-4 text-[10px] text-muted-foreground">
										{item.statusText ?? item.providerLabel}
									</span>
								</MenuItem>
							);
						})}
					</>
				) : null}
				<MenuSeparator />
				<MenuItem
					onClick={() => openAddComputerDialog()}
					className="grid grid-cols-[1rem_auto_1fr] items-center gap-x-2 rounded-md px-2 py-1.5 text-sm"
				>
					<span className="col-start-1 row-start-1" />
					<HugeiconsIcon
						icon={ComputerIcon}
						className="col-start-2 row-start-1 size-3.5 opacity-80"
					/>
					<span className="col-start-3 row-start-1">Add computer…</span>
				</MenuItem>
			</MenuPopup>
		</Menu>
	);
}
