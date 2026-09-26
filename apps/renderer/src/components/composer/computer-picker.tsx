import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { ComputerIcon } from "@zuse/icons/solid-rounded";
import { ChevronDown } from "lucide-react";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSelectionIndicator,
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
import { cloudProviderLabel } from "../../lib/cloud-provider-presentation.ts";
import { openAddComputerDialog } from "../add-computer-dialog.tsx";
import { DitherCloudIcon } from "../dither-cloud-icon.tsx";

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

export type CloudComputerPickerSize = {
	readonly sizeId: string;
	readonly displayName: string;
};

export type CloudComputerPickerItem = {
	readonly providerId: string;
	readonly disabled: boolean;
	readonly needsSetup: boolean;
	readonly statusText: string | null;
	readonly sizes?: ReadonlyArray<CloudComputerPickerSize>;
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
	includeComputers = true,
	selectedCloudProviderId = null,
	selectedCloudSizeId = null,
	onPickCloud,
	onPickCloudSize,
	onRetryEnvironment,
}: {
	group: LogicalProjectGroup | null;
	target: NewChatTarget | null;
	entries: ReadonlyArray<EnvironmentCatalogEntry>;
	onPickTarget: (target: NewChatTarget) => void;
	cloudItems?: ReadonlyArray<CloudComputerPickerItem>;
	includeComputers?: boolean;
	selectedCloudProviderId?: string | null;
	selectedCloudSizeId?: string | null;
	onPickCloud?: (providerId: string) => void;
	onPickCloudSize?: (sizeId: string) => void;
	onRetryEnvironment: (environmentId: string) => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);

	if (group === null) return null;
	const model = computerPickerItems(group, target, entries);
	if (model.kind === "hidden" && cloudItems.length === 0) return null;

	if (model.kind === "static" && cloudItems.length === 0) {
		return (
			<span className="flex h-7 min-w-0 max-w-[14rem] items-center gap-1.5 rounded-full px-2.5 text-[11px] text-muted-foreground">
				<HugeiconsIcon icon={ComputerIcon} className="size-3.5" />
				<span className="truncate">{model.item.label}</span>
			</span>
		);
	}

	const computerItems = !includeComputers
		? []
		: model.kind === "menu"
			? model.items
			: [model.item];
	const current =
		computerItems.find((item) => item.selected) ?? computerItems[0] ?? null;
	const cloudSelected = selectedCloudProviderId !== null;
	const pick = (item: ComputerPickerItem): void => {
		if (item.retryable) {
			onRetryEnvironment(item.environmentId);
			return;
		}
		if (item.disabled || (item.selected && !cloudSelected)) return;
		onPickTarget({
			environmentId: item.environmentId,
			folderId: item.folderId,
		});
	};

	return (
		<Menu>
			<MenuTrigger
				className="flex h-7 min-w-0 max-w-[14rem] items-center gap-1.5 rounded-full border border-transparent bg-transparent px-2.5 text-[11px] text-foreground transition-colors hover:bg-accent data-[popup-open]:bg-accent"
				aria-label={uiMessage(
					includeComputers
						? "chat:computer_picker_run_on_computer"
						: "chat:computer_picker_cloud_sandbox",
				)}
			>
				{cloudSelected ? (
					<DitherCloudIcon className="size-4" />
				) : (
					<HugeiconsIcon icon={ComputerIcon} className="size-3.5" />
				)}
				<span className="truncate">
					{cloudSelected
						? `${uiMessage("chat:computer_picker_cloud_sandbox")} · ${cloudProviderLabel(selectedCloudProviderId)}`
						: (current?.label ?? "Run on")}
				</span>

				<ChevronDown className="size-3 opacity-60" />
			</MenuTrigger>
			<MenuPopup side="top" align="start" className="w-64 p-1">
				{computerItems.map((item) => (
					<MenuItem
						key={`${item.environmentId}:${item.folderId ?? "unavailable"}`}
						role="menuitemradio"
						aria-checked={item.selected && !cloudSelected}
						disabled={item.disabled}
						onClick={() => pick(item)}
						className={cn(
							"grid h-7 grid-cols-[auto_1fr_auto_auto] items-center gap-x-2 rounded-md px-2 text-xs",
							item.selected && !cloudSelected
								? "bg-accent/40 text-accent-foreground data-highlighted:bg-accent/60"
								: undefined,
						)}
					>
						<HugeiconsIcon
							icon={ComputerIcon}
							className="col-start-1 row-start-1 size-3.5 opacity-80"
						/>
						<span className="col-start-2 row-start-1 truncate">
							{item.label}
						</span>
						{(!item.selected || cloudSelected) &&
						(item.status !== "connected" || !item.projectAvailable) ? (
							<span className="col-start-3 row-start-1 text-[10px] text-muted-foreground">
								{statusText(item)}
							</span>
						) : null}
						<MenuSelectionIndicator
							checked={item.selected && !cloudSelected}
							className="col-start-4 row-start-1 justify-self-end"
						/>
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
									role="menuitemradio"
									aria-checked={selected}
									disabled={item.disabled}
									onClick={() => onPickCloud?.(item.providerId)}
									className={cn(
										"grid h-7 grid-cols-[auto_1fr_auto_auto] items-center gap-x-2 rounded-md px-2 text-xs",
										selected
											? "bg-accent/40 text-accent-foreground data-highlighted:bg-accent/60"
											: undefined,
									)}
								>
									<DitherCloudIcon className="col-start-1 size-4" />
									<span className="col-start-2 flex min-w-0 items-center gap-1.5">
										<span className="truncate">
											{`${uiMessage("chat:computer_picker_cloud_sandbox")} · ${cloudProviderLabel(item.providerId)}`}
										</span>
										<span className="text-[10px] text-muted-foreground">
											{uiMessage("chat:computer_picker_beta")}
										</span>
									</span>
									<span className="col-start-3 text-[10px] text-muted-foreground">
										{item.statusText}
									</span>
									<MenuSelectionIndicator
										checked={selected}
										className="col-start-4 justify-self-end"
									/>
								</MenuItem>
							);
						})}
						{(() => {
							const selectedItem = cloudItems.find(
								(item) => item.providerId === selectedCloudProviderId,
							);
							const sizes = selectedItem?.sizes ?? [];
							if (sizes.length < 2) return null;
							return (
								<>
									<MenuSeparator />
									<div className="px-2 pt-1 text-[10px] text-muted-foreground">
										{uiMessage("chat:computer_picker_machine_size")}
									</div>
									{sizes.map((size, index) => {
										const sizeSelected =
											size.sizeId === selectedCloudSizeId ||
											(selectedCloudSizeId === null && index === 0);
										return (
											<MenuItem
												key={`cloud-size:${size.sizeId}`}
												role="menuitemradio"
												aria-checked={sizeSelected}
												onClick={() => onPickCloudSize?.(size.sizeId)}
												className={cn(
													"grid h-7 grid-cols-[1fr_auto] items-center gap-x-2 rounded-md px-2 text-xs",
													sizeSelected
														? "bg-accent/40 text-accent-foreground data-highlighted:bg-accent/60"
														: undefined,
												)}
											>
												<span className="col-start-2 row-start-1 flex items-center justify-end">
													<MenuSelectionIndicator checked={sizeSelected} />
												</span>
												<span className="col-start-1 row-start-1 truncate">
													{size.displayName}
												</span>
											</MenuItem>
										);
									})}
								</>
							);
						})()}
					</>
				) : null}
				{includeComputers && (
					<>
						<MenuSeparator />
						<MenuItem
							onClick={() => openAddComputerDialog()}
							className="grid h-7 grid-cols-[auto_1fr] items-center gap-x-2 rounded-md px-2 text-xs"
						>
							<HugeiconsIcon
								icon={ComputerIcon}
								className="col-start-1 row-start-1 size-3.5 opacity-80"
							/>
							<span className="col-start-2 row-start-1">
								{uiMessage("chat:computer_picker_add_computer")}
							</span>
						</MenuItem>
					</>
				)}
			</MenuPopup>
		</Menu>
	);
}
