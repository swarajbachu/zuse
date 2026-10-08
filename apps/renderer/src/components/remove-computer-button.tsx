import "@zuse/i18n/english/common";
import "@zuse/i18n/english/providers";
import { useMessages } from "@zuse/i18n/react";
import { Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import {
	type EnvironmentCatalogEntry,
	useEnvironmentCatalogStore,
} from "../store/environment-catalog.ts";
import {
	AlertDialog,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";

/** Unregister account computers; preserve projects and data on the host. */
export function RemoveComputerButton({
	entry,
}: {
	entry: EnvironmentCatalogEntry;
}) {
	const { message } = useMessages(["common", "providers"]);
	const activeId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	const remove = useEnvironmentCatalogStore((state) => state.remove);
	const removeApiEnvironment = useEnvironmentCatalogStore(
		(state) => state.removeApiEnvironment,
	);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pending = useRef(false);
	const disabled =
		entry.environmentId === activeId || entry.connectionKind === "local";

	const confirmRemoval = async () => {
		if (pending.current || disabled) return;
		pending.current = true;
		setBusy(true);
		setError(null);
		try {
			if (entry.connectionKind === "api") {
				await removeApiEnvironment(entry.environmentId);
			} else if (entry.profileId !== null) {
				await remove(entry.profileId);
			} else {
				throw new Error("Computer management is unavailable.");
			}
			setOpen(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			pending.current = false;
			setBusy(false);
		}
	};

	return (
		<>
			<Button
				className="h-7"
				size="icon-sm"
				variant="ghost"
				disabled={disabled}
				aria-label={message("providers:add_computer_dialog_remove", {
					value1: entry.label,
				})}
				onClick={() => {
					setError(null);
					setOpen(true);
				}}
			>
				<Trash2 aria-hidden />
			</Button>
			<AlertDialog
				open={open}
				onOpenChange={(next) => {
					if (!pending.current) setOpen(next);
				}}
			>
				<AlertDialogPopup className="max-w-sm">
					<AlertDialogHeader>
						<AlertDialogTitle>
							{message("providers:add_computer_dialog_remove_sentence", {
								value: entry.label,
							})}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{message(
								entry.connectionKind === "api"
									? "providers:remove_computer_account_description"
									: "providers:add_computer_dialog_zuse_will_forget_this_computer_on_this_device_projects_and_d_sentence",
								{ value: entry.label },
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{error !== null && (
						<p role="alert" className="text-xs text-destructive">
							{error}
						</p>
					)}
					<AlertDialogFooter>
						<Button
							className="h-7"
							variant="ghost"
							disabled={busy}
							onClick={() => setOpen(false)}
						>
							{message("common:cancel")}
						</Button>
						<Button
							className="h-7"
							variant="destructive"
							disabled={disabled || busy}
							loading={busy}
							onClick={() => void confirmRemoval()}
						>
							{message("common:remove")}
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</>
	);
}
