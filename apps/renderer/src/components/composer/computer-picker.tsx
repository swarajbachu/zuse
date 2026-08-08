import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowDown01Icon,
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
} from "~/lib/project-groups.ts";
import { switchToEnvironment } from "~/lib/switch-environment.ts";
import { cn } from "~/lib/utils";
import { useComposerDraftsStore } from "~/store/composer-drafts";
import { openAddComputerDialog } from "../add-computer-dialog.tsx";

const statusText = (item: ComputerPickerItem): string =>
	item.status === "connecting"
		? "Connecting…"
		: item.status === "error"
			? "Can't connect"
			: item.status === "offline"
				? "Offline"
				: "Connected";

/**
 * "Run on" control for the Chat Lander: picks which computer a new chat runs
 * on within the selected logical project. Picking another computer carries
 * the typed draft across the switch; everything else in the UI stays put.
 *
 * Hidden when there is nothing to choose (the only member is on the active
 * environment); a static label when the only member is remote.
 */
export function ComputerPicker({
	group,
	activeEnvironmentId,
	currentDraftKey,
}: {
	group: LogicalProjectGroup | null;
	activeEnvironmentId: string;
	currentDraftKey: string;
}) {
	if (group === null) return null;
	const model = computerPickerItems(group, activeEnvironmentId);
	if (model.kind === "hidden") return null;

	if (model.kind === "static") {
		return (
			<span className="flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground">
				<HugeiconsIcon icon={ComputerIcon} className="size-3.5" />
				<span className="truncate">{model.item.label}</span>
			</span>
		);
	}

	const current =
		model.items.find((item) => item.isActive) ?? model.items[0] ?? null;
	const pick = (item: ComputerPickerItem): void => {
		if (item.disabled || item.isActive) return;
		// Carry whatever the user already typed into the destination folder's
		// landing draft so switching computers never loses the prompt.
		const doc =
			useComposerDraftsStore.getState().draftsByKey[currentDraftKey]?.doc ?? "";
		void switchToEnvironment({
			environmentId: item.environmentId,
			folderId: item.folderId,
			...(doc.length > 0 ? { carryComposerDraft: { doc } } : {}),
		});
	};

	return (
		<Menu>
			<MenuTrigger
				className="flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-accent data-[popup-open]:bg-accent"
				aria-label="Run on computer"
			>
				<HugeiconsIcon icon={ComputerIcon} className="size-3.5" />
				<span className="truncate">{current?.label ?? "Run on"}</span>
				<HugeiconsIcon icon={ArrowDown01Icon} className="size-3 opacity-60" />
			</MenuTrigger>
			<MenuPopup side="bottom" align="start" className="w-64 p-1">
				{model.items.map((item) => (
					<MenuItem
						key={`${item.environmentId}:${item.folderId}`}
						disabled={item.disabled}
						onClick={() => pick(item)}
						className={cn(
							"grid grid-cols-[1rem_auto_1fr_auto] items-center gap-x-2 rounded-md px-2 py-1.5 text-sm",
							item.isActive
								? "bg-accent/40 text-accent-foreground data-highlighted:bg-accent/60"
								: undefined,
						)}
					>
						<span className="col-start-1 row-start-1 flex items-center justify-center">
							{item.isActive && (
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
						{!item.isActive && item.status !== "connected" ? (
							<span className="col-start-4 row-start-1 text-[10px] text-muted-foreground">
								{statusText(item)}
							</span>
						) : null}
					</MenuItem>
				))}
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
