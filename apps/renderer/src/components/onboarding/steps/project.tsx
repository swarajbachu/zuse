import { HugeiconsIcon } from "@hugeicons/react";
import {
	Folder01Icon,
	FolderAddIcon,
	Tick01Icon,
} from "@hugeicons-pro/core-stroke-rounded";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { useWorkspaceStore } from "../../../store/workspace.ts";
import { StepHeader } from "./shared.tsx";

export function ProjectStep() {
	const folders = useWorkspaceStore((s) => s.folders);
	const add = useWorkspaceStore((s) => s.add);
	const error = useWorkspaceStore((s) => s.error);
	const [busy, setBusy] = useState(false);

	const pick = async () => {
		setBusy(true);
		try {
			await add();
		} finally {
			setBusy(false);
		}
	};

	const justAdded = folders[folders.length - 1] ?? null;

	return (
		<div className="flex flex-col gap-7">
			<StepHeader
				title="Add your first project"
				subtitle="Any folder on your machine. We'll list it in the sidebar, no copies made."
			/>

			{justAdded === null ? (
				<button
					type="button"
					onClick={() => void pick()}
					disabled={busy}
					className="group flex flex-col items-center justify-center gap-4 rounded-2xl bg-muted/60 px-6 py-12 text-center transition-all hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
				>
					<span className="flex size-12 items-center justify-center rounded-2xl bg-background/70 text-foreground transition-transform group-hover:scale-105">
						<HugeiconsIcon icon={FolderAddIcon} className="size-5" />
					</span>
					<span className="flex flex-col gap-1">
						<span className="text-[14px] font-medium text-foreground">
							{busy ? "Opening picker…" : "Choose a folder"}
						</span>
						<span className="text-[11px] text-muted-foreground">
							Click to browse, or drag one in
						</span>
					</span>
				</button>
			) : (
				<div className="flex flex-col gap-3">
					<div className="flex items-center gap-3 rounded-2xl bg-alert-success-bg px-4 py-3.5">
						<span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background/70 text-foreground">
							<HugeiconsIcon icon={Folder01Icon} className="size-4" />
						</span>
						<div className="flex min-w-0 flex-1 flex-col">
							<span className="truncate text-[14px] font-medium text-foreground">
								{justAdded.name}
							</span>
							<span className="truncate font-mono text-[11px] text-muted-foreground">
								{justAdded.path}
							</span>
						</div>
						<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/20 text-success">
							<HugeiconsIcon icon={Tick01Icon} className="size-3" />
						</span>
					</div>
					<div className="flex justify-end">
						<Button
							size="sm"
							variant="ghost"
							onClick={() => void pick()}
							disabled={busy}
							className="rounded-full px-3 text-[12px] text-muted-foreground hover:text-foreground"
						>
							Pick a different folder
						</Button>
					</div>
				</div>
			)}

			{error !== null && (
				<p className="text-[11px] text-destructive">{error}</p>
			)}
		</div>
	);
}
