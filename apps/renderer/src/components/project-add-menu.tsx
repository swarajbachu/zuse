import { Plus } from "lucide-react";
import { lazy, Suspense } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
	openProjectSetupDialog,
	useProjectSetupDialogStore,
} from "../lib/project-setup-dialog-state.ts";
import { formatShortcut } from "../lib/shortcuts.ts";
import { TooltipShortcut } from "./projects-sidebar.tsx";

const loadProjectSetupDialog = () => import("./project-setup-dialog.tsx");
const ProjectSetupDialog = lazy(() =>
	loadProjectSetupDialog().then((module) => ({
		default: module.ProjectSetupDialog,
	})),
);

export function ProjectAddMenu() {
	const open = useProjectSetupDialogStore((state) => state.open);
	const setOpen = useProjectSetupDialogStore((state) => state.setOpen);

	return (
		<>
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							className="rounded p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
							aria-label="Add project"
							onClick={openProjectSetupDialog}
							onFocus={() => void loadProjectSetupDialog()}
							onPointerEnter={() => void loadProjectSetupDialog()}
						>
							<Plus className="size-3.5" strokeWidth={1.8} />
						</button>
					}
				/>
				<TooltipPopup>
					<TooltipShortcut
						label="Add project"
						shortcut={formatShortcut("open-project")}
					/>
				</TooltipPopup>
			</Tooltip>

			{open ? (
				<Suspense fallback={null}>
					<ProjectSetupDialog open onOpenChange={setOpen} />
				</Suspense>
			) : null}
		</>
	);
}
