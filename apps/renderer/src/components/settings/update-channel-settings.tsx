import type { UpdateChannel } from "@zuse/contracts";
import { useEffect, useState } from "react";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "../ui/select.tsx";
import { SettingsGroup, SettingsRow } from "../ui/settings-panel.tsx";

const CHANNEL_OPTIONS = [
	{ value: "stable", label: "Stable" },
	{ value: "preview", label: "Preview" },
];

export function UpdateChannelSettings() {
	const updates = window.zuse?.updates;
	const [channel, setChannel] = useState<UpdateChannel | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let active = true;
		updates
			?.getChannel()
			.then((value) => {
				if (active) setChannel(value);
			})
			.catch(() => {
				if (active)
					setError(
						"Could not load the update channel. Reopen Settings to retry.",
					);
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
			setError("Could not change the update channel. Try again.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<SettingsGroup title="Updates">
			<SettingsRow
				title="Update channel"
				description={
					channel === "preview"
						? "Get early builds. Switching to Stable installs the current stable release on restart and keeps your sessions."
						: "Get tested releases. Choose Preview to try upcoming changes early."
				}
				action={
					<Select
						items={CHANNEL_OPTIONS}
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
							aria-label="Update channel"
							className="h-7 w-28 text-xs"
						>
							<SelectValue placeholder="Loading…" />
						</SelectTrigger>
						<SelectPopup>
							{CHANNEL_OPTIONS.map((option) => (
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
						Changing update channel…
					</p>
				)}
				{error && (
					<p role="alert" className="text-xs text-destructive">
						{error}
					</p>
				)}
			</SettingsRow>
		</SettingsGroup>
	);
}
