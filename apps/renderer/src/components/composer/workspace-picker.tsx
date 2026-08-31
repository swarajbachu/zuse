import { HugeiconsIcon } from "@hugeicons/react";
import { Folder01Icon, GitBranchIcon } from "@zuse/icons/solid-rounded";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import {
	Menu,
	MenuPopup,
	MenuRadioGroup,
	MenuRadioItem,
	MenuTrigger,
} from "~/components/ui/menu";

export type ComposerWorkspaceMode = "worktree" | "local";

const OPTIONS = {
	worktree: {
		label: "Worktree",
		description: "Fresh isolated branch",
		icon: GitBranchIcon,
	},
	local: {
		label: "Local",
		description: "Use the main checkout",
		icon: Folder01Icon,
	},
} as const;

export function WorkspacePicker({
	value,
	onValueChange,
}: {
	readonly value: ComposerWorkspaceMode;
	readonly onValueChange: (value: ComposerWorkspaceMode) => void;
}) {
	const [open, setOpen] = useState(false);
	const current = OPTIONS[value];
	return (
		<Menu open={open} onOpenChange={setOpen}>
			<MenuTrigger
				className="flex h-7 min-w-0 items-center gap-1.5 rounded-full border border-transparent bg-transparent px-2.5 text-[11px] text-foreground transition-colors hover:bg-accent data-[popup-open]:bg-accent"
				aria-label="Choose workspace"
			>
				<HugeiconsIcon icon={current.icon} className="size-3.5" />
				<span>{current.label}</span>
				<ChevronDown className="size-3 opacity-60" />
			</MenuTrigger>
			<MenuPopup side="top" align="start" className="w-56 p-1">
				<div className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
					Workspace
				</div>
				<MenuRadioGroup
					value={value}
					onValueChange={(next) => {
						onValueChange(next as ComposerWorkspaceMode);
						setOpen(false);
					}}
				>
					{(Object.keys(OPTIONS) as ComposerWorkspaceMode[]).map((mode) => {
						const option = OPTIONS[mode];
						return (
							<MenuRadioItem
								key={mode}
								value={mode}
								className="min-h-10 items-center px-2 py-1"
							>
								<span className="flex min-w-0 items-center gap-2">
									<HugeiconsIcon
										icon={option.icon}
										className="size-3.5 shrink-0"
									/>
									<span className="min-w-0">
										<span className="block text-xs font-medium text-foreground">
											{option.label}
										</span>
										<span className="block truncate text-[10px] text-muted-foreground">
											{option.description}
										</span>
									</span>
								</span>
							</MenuRadioItem>
						);
					})}
				</MenuRadioGroup>
			</MenuPopup>
		</Menu>
	);
}
