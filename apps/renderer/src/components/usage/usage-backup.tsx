import type { EnvironmentId, UsageBackupState } from "@zuse/contracts";
import "@zuse/i18n/english/usage";
import { formatDate } from "@zuse/i18n";
import { useMessages } from "@zuse/i18n/react";
import { CloudUpload } from "lucide-react";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import {
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "~/lib/renderer-account";
import {
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "~/lib/renderer-workspace";
import { loadUsageBackup, updateUsageBackup } from "~/lib/usage-profile-client";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";

/** Opt-in account backup of hourly usage history for the signed-in account. */
export function UsageBackup({
	environmentId,
}: {
	environmentId: EnvironmentId;
}) {
	const account = useSyncExternalStore(
		subscribeRendererAccount,
		rendererAccountSnapshot,
		rendererAccountSnapshot,
	);
	const workspace = useSyncExternalStore(
		subscribeRendererWorkspace,
		rendererWorkspaceSnapshot,
		rendererWorkspaceSnapshot,
	);
	const { message } = useMessages(["usage"]);
	const [open, setOpen] = useState(false);
	if (workspace.scope.kind !== "personal") return null;
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={<Button className="h-7 gap-1.5" size="sm" variant="ghost" />}
			>
				<CloudUpload className="size-3.5" aria-hidden="true" />
				{message("usage:backup_button")}
			</PopoverTrigger>
			<PopoverPopup
				align="end"
				sideOffset={8}
				className="w-80 max-w-[calc(100vw-1rem)]"
			>
				{open && (
					<BackupPanel
						key={`${account.epoch}:${environmentId}`}
						environmentId={environmentId}
					/>
				)}
			</PopoverPopup>
		</Popover>
	);
}

function BackupPanel({ environmentId }: { environmentId: EnvironmentId }) {
	const { message } = useMessages(["usage"]);
	const [state, setState] = useState<UsageBackupState | null>(null);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const [deleteRemote, setDeleteRemote] = useState(false);
	const fieldId = useId();

	useEffect(() => {
		let current = true;
		const account = rendererAccountSnapshot();
		loadUsageBackup(environmentId).then(
			(result) => {
				if (current && rendererAccountSnapshot() === account) setState(result);
			},
			() => {
				if (current) setFailed(true);
			},
		);
		return () => {
			current = false;
		};
	}, [environmentId]);

	const update = async (enabled: boolean) => {
		if (busy) return;
		setBusy(true);
		setFailed(false);
		const account = rendererAccountSnapshot();
		try {
			const result = await updateUsageBackup(environmentId, {
				enabled,
				...(enabled ? {} : { deleteRemote }),
			});
			if (rendererAccountSnapshot() === account) setState(result);
		} catch {
			if (rendererAccountSnapshot() === account) setFailed(true);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-3 p-1 text-xs">
			<div className="flex flex-col gap-1">
				<p className="font-medium">{message("usage:backup_title")}</p>
				<p className="leading-relaxed text-muted-foreground">
					{message("usage:backup_description")}
				</p>
			</div>
			<label
				htmlFor={`${fieldId}-enabled`}
				className="flex items-center justify-between gap-3"
			>
				{message("usage:backup_switch")}
				<Switch
					id={`${fieldId}-enabled`}
					checked={state?.enabled ?? false}
					onCheckedChange={(checked) => void update(checked)}
					disabled={busy || state === null}
				/>
			</label>
			{state?.enabled && (
				<>
					<p role="status" className="text-muted-foreground">
						{busy
							? message("usage:backup_saving")
							: state.lastSyncedAt === null
								? message("usage:backup_never")
								: message("usage:backup_synced", {
										time: formatDate(state.lastSyncedAt, {
											dateStyle: "medium",
											timeStyle: "short",
										}),
									})}{" "}
						{message("usage:backup_interval")}
					</p>
					<label
						htmlFor={`${fieldId}-delete`}
						className="flex items-center gap-2 text-muted-foreground"
					>
						<Checkbox
							id={`${fieldId}-delete`}
							checked={deleteRemote}
							onCheckedChange={(checked) => setDeleteRemote(checked === true)}
							disabled={busy}
						/>
						{message("usage:backup_delete")}
					</label>
				</>
			)}
			{busy && !state?.enabled && (
				<p role="status" className="text-muted-foreground">
					{message("usage:backup_saving")}
				</p>
			)}
			{state?.lastError && !busy && (
				<p role="alert" className="text-destructive">
					{message("usage:backup_error")}
				</p>
			)}
			{failed && (
				<p role="alert" className="text-destructive">
					{message("usage:backup_load_error")}
				</p>
			)}
			<p className="text-[11px] leading-relaxed text-muted-foreground">
				{message("usage:backup_privacy")}
			</p>
		</div>
	);
}
