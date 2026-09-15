import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import { CommandId } from "@zuse/contracts";
import { useState } from "react";
import { formatError } from "../lib/format-error.ts";
import { dispatchGitWorkspaceCommand } from "../lib/git-workspace-client-bus.ts";
import {
	Dialog,
	DialogDescription,
	DialogHeader,
	DialogPopup,
	DialogTitle,
} from "./ui/dialog.tsx";

export function CreateBranchDialog({
	executionRef,
	base,
	onClose,
}: {
	executionRef: ExecutionRef;
	base: "HEAD" | "origin/main";
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy) onClose();
			}}
		>
			<DialogPopup className="max-w-sm">
				<DialogHeader>
					<DialogTitle>Create branch</DialogTitle>
					<DialogDescription>
						{base === "HEAD"
							? "Continue from the current branch."
							: "Fetch origin/main and start a new branch. Commit or stash local changes first."}
					</DialogDescription>
				</DialogHeader>
				<form
					className="mt-3 space-y-3"
					onSubmit={async (event) => {
						event.preventDefault();
						if (busy || !name.trim()) return;
						setBusy(true);
						setError(null);
						try {
							await dispatchGitWorkspaceCommand({
								ref: executionRef,
								kind: "git.switchBranch",
								commandId: CommandId.make(
									`create-branch:${crypto.randomUUID()}`,
								),
								payload: {
									folderId: executionRef.folderId,
									worktreeId: executionRef.worktreeId,
									branch: name.trim(),
									createFrom: base,
								},
							});
							onClose();
						} catch (cause) {
							setError(formatError(cause));
						} finally {
							setBusy(false);
						}
					}}
				>
					<label className="block text-xs text-muted-foreground">
						Branch name
						<input
							autoFocus
							required
							value={name}
							disabled={busy}
							onChange={(event) => setName(event.target.value)}
							className="mt-1 h-7 w-full rounded-md bg-muted px-2 text-sm text-foreground outline-none focus-visible:bg-muted/70"
							placeholder="feature/my-change"
						/>
					</label>
					{error ? (
						<p role="alert" className="text-xs text-destructive">
							{error}
						</p>
					) : null}
					<div className="flex justify-end gap-2">
						<button
							type="button"
							disabled={busy}
							onClick={onClose}
							className="h-7 rounded-md px-3 text-xs hover:bg-muted"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={busy || !name.trim()}
							className="h-7 rounded-md bg-primary px-3 text-xs text-primary-foreground disabled:opacity-50"
						>
							{busy ? "Creating…" : "Create and checkout"}
						</button>
					</div>
				</form>
			</DialogPopup>
		</Dialog>
	);
}
