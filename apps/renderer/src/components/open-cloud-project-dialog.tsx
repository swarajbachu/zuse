import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { useUiStore } from "~/store/ui";
import { useWorkspaceStore } from "~/store/workspace";

export function OpenCloudProjectDialog() {
	const open = useUiStore((state) => state.cloudProjectPathDialogOpen);
	const setOpen = useUiStore((state) => state.setCloudProjectPathDialogOpen);
	const addPath = useWorkspaceStore((state) => state.addPath);
	const [path, setPath] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (open) return;
		setPath("");
		setSubmitting(false);
		setError(null);
	}, [open]);

	const trimmedPath = path.trim();
	const pathError =
		trimmedPath.length > 0 && !trimmedPath.startsWith("/")
			? "Enter an absolute path beginning with /."
			: null;
	const canSubmit = trimmedPath.length > 0 && pathError === null && !submitting;

	const submit = async () => {
		if (!canSubmit) return;
		setSubmitting(true);
		setError(null);
		try {
			await addPath(trimmedPath);
			setOpen(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSubmitting(false);
		}
	};

	const handleOpenChange = (next: boolean) => {
		if (submitting && !next) return;
		setOpen(next);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogPopup className="max-w-md">
				<DialogHeader>
					<DialogTitle>Open cloud project</DialogTitle>
					<DialogDescription>
						Add an existing folder from this cloud machine. Its files and
						terminals stay on the machine.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel
					className="flex flex-col gap-2"
					onKeyDown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
							event.preventDefault();
							void submit();
						}
					}}
				>
					<label className="font-medium text-xs" htmlFor="cloud-project-path">
						Folder path
					</label>
					<Input
						aria-describedby="cloud-project-path-help"
						aria-invalid={pathError !== null || error !== null || undefined}
						autoComplete="off"
						autoFocus
						id="cloud-project-path"
						onChange={(event) => {
							setPath(event.currentTarget.value);
							setError(null);
						}}
						placeholder="/home/zuse/project"
						spellCheck={false}
						value={path}
					/>
					<p
						className={
							pathError !== null || error !== null
								? "text-destructive text-xs"
								: "text-muted-foreground text-xs"
						}
						id="cloud-project-path-help"
						role={pathError !== null || error !== null ? "alert" : undefined}
					>
						{pathError ?? error ?? "Enter the full path to an existing folder."}
					</p>
				</DialogPanel>

				<DialogFooter>
					<DialogClose
						render={
							<Button disabled={submitting} type="button" variant="ghost">
								Cancel
							</Button>
						}
					/>
					<Button
						disabled={!canSubmit}
						onClick={() => void submit()}
						type="button"
					>
						{submitting ? (
							<>
								<Spinner className="size-3.5" />
								Opening…
							</>
						) : (
							"Open project"
						)}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
