import { HugeiconsIcon } from "@hugeicons/react";
import {
	FileAddIcon,
	FolderOpenIcon,
	GlobeIcon,
} from "@hugeicons-pro/core-solid-rounded";
import { Plus } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { dispatchCommand } from "../lib/commands.ts";
import { formatShortcut } from "../lib/shortcuts.ts";
import { TooltipShortcut } from "./projects-sidebar.tsx";

const loadCloneRepoDialog = () => import("./clone-repo-dialog.tsx");
const CloneRepoDialog = lazy(() =>
	loadCloneRepoDialog().then((module) => ({
		default: module.CloneRepoDialog,
	})),
);
const loadCreateProjectDialog = () => import("./create-project-dialog.tsx");
const CreateProjectDialog = lazy(() =>
	loadCreateProjectDialog().then((module) => ({
		default: module.CreateProjectDialog,
	})),
);

/**
 * Replaces the bare `+` button in the projects sidebar with a three-way
 * popover, mirroring the screenshot:
 *
 *   • Open project       — existing pick-a-folder flow
 *   • Open GitHub project — clone a repo, then register it
 *   • Quick start        — scaffold a fresh project from a template
 *
 * The "Open project" item keeps the `Cmd+O` accelerator so the fast path
 * stays one keypress away; the other two are mouse-driven for v1.
 */
export function ProjectAddMenu() {
	const [cloneOpen, setCloneOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);

	return (
		<>
			<Menu>
				<Tooltip>
					<TooltipTrigger
						render={
							<MenuTrigger
								className="rounded p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
								aria-label="Add project"
							>
								<Plus className="size-3.5" strokeWidth={1.8} />
							</MenuTrigger>
						}
					/>
					<TooltipPopup>
						<TooltipShortcut
							label="Add project"
							shortcut={formatShortcut("open-project")}
						/>
					</TooltipPopup>
				</Tooltip>
				<MenuPopup align="end" className="min-w-[200px]">
					<MenuItem
						onClick={() => dispatchCommand("open-project")}
						className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-sidebar-accent"
					>
						<HugeiconsIcon
							icon={FolderOpenIcon}
							className="size-3.5 text-muted-foreground"
						/>
						Open project
					</MenuItem>
					<MenuItem
						onFocus={() => void loadCloneRepoDialog()}
						onPointerEnter={() => void loadCloneRepoDialog()}
						onClick={() => setCloneOpen(true)}
						className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-sidebar-accent"
					>
						<HugeiconsIcon
							icon={GlobeIcon}
							className="size-3.5 text-muted-foreground"
						/>
						Open GitHub project
					</MenuItem>
					<MenuItem
						onFocus={() => void loadCreateProjectDialog()}
						onPointerEnter={() => void loadCreateProjectDialog()}
						onClick={() => setCreateOpen(true)}
						className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-sidebar-accent"
					>
						<HugeiconsIcon
							icon={FileAddIcon}
							className="size-3.5 text-muted-foreground"
						/>
						Quick start
					</MenuItem>
				</MenuPopup>
			</Menu>

			{cloneOpen ? (
				<Suspense fallback={null}>
					<CloneRepoDialog open onOpenChange={setCloneOpen} />
				</Suspense>
			) : null}
			{createOpen ? (
				<Suspense fallback={null}>
					<CreateProjectDialog open onOpenChange={setCreateOpen} />
				</Suspense>
			) : null}
		</>
	);
}
