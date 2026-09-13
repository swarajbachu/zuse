import "@zuse/i18n/english/settings";
import type { UpdateChannel } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { useEffect, useState } from "react";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "../ui/select.tsx";
import { SettingsGroup, SettingsRow } from "../ui/settings-panel.tsx";

export function UpdateChannelSettings() {
	const { message } = useMessages(["settings", "common"]);
	const channelOptions = [
		{ value: "stable", label: message("settings:update_channel_stable") },
		{ value: "preview", label: message("settings:update_channel_preview") },
	];
	const updates = window.zuse?.updates;
	const [channel, setChannel] = useState<UpdateChannel | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<"load" | "save" | null>(null);
	useEffect(() => {
		let active = true;
		updates
			?.getChannel()
			.then((value) => {
				if (active) setChannel(value);
			})
			.catch(() => {
				if (active) setError("load");
			});
		return () => {
			active = false;
		};
	}, [updates]);
	if (!updates) return null;
	const changeChannel = async (value: UpdateChannel) => {
		setBusy(true);
		setError(null);
		try {
			setChannel(await updates.setChannel(value));
		} catch {
			setError("save");
		} finally {
			setBusy(false);
		}
	};
	return (
		<SettingsGroup title={message("settings:update_channel_updates")}>
			<SettingsRow
				title={message("settings:update_channel_label")}
				description={
					channel === "preview"
						? message("settings:update_channel_preview_description")
						: message("settings:update_channel_stable_description")
				}
				action={
					<Select
						items={channelOptions}
						value={channel}
						disabled={busy || channel === null}
						onValueChange={(value) => {
							if (
								(value === "stable" || value === "preview") &&
								value !== channel
							)
								void changeChannel(value);
						}}
					>
						<SelectTrigger
							aria-label={message("settings:update_channel_label")}
							className="h-7 w-28 text-xs"
						>
							<SelectValue placeholder={message("common:loading")} />
						</SelectTrigger>
						<SelectPopup>
							{channelOptions.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectPopup>
					</Select>
				}
			>
				{busy && (
					<p role="status" className="text-xs text-muted-foreground">
						{message("settings:update_channel_changing")}
					</p>
				)}
				{error && (
					<p role="alert" className="text-xs text-destructive">
						{message(
							error === "load"
								? "settings:update_channel_load_error"
								: "settings:update_channel_save_error",
						)}
					</p>
				)}
			</SettingsRow>
		</SettingsGroup>
	);
}
