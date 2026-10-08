import "@zuse/i18n/english/settings";
import { useMessages } from "@zuse/i18n/react";
import { useState } from "react";
import { Button } from "../ui/button.tsx";
import { useCloudProviderConnections } from "./cloud-provider-keys.tsx";
import {
	CloudSettingsRow,
	COMPACT_CLOUD_ACTION,
} from "./cloud-settings-ui.tsx";
import { CloudSnapshotSettings } from "./cloud-snapshot-settings.tsx";

/** Reuse the snapshot editor so authentication changes follow the same save path. */
export function CloudSnapshotAuthSetup({
	onChanged,
}: {
	readonly onChanged: () => Promise<void>;
}) {
	const { message } = useMessages(["settings"]);
	const keys = useCloudProviderConnections();
	const [editing, setEditing] = useState(false);
	const connection = keys.active.find((key) => key.providerId === "boxd");
	return (
		<>
			<CloudSettingsRow
				title={message("settings:snapshot_use_zuse_accounts")}
				description={message("settings:snapshot_managed_auth_help")}
				action={
					<Button
						className={COMPACT_CLOUD_ACTION}
						size="xs"
						variant="outline"
						disabled={connection === undefined || keys.loading}
						onClick={() => setEditing((value) => !value)}
					>
						{message("settings:cloud_hosting_set_up")}
					</Button>
				}
			/>
			{editing && connection !== undefined ? (
				<CloudSnapshotSettings
					connectionId={connection.connectionId}
					initialAgentAuthentication="zuse"
					onChanged={onChanged}
				/>
			) : null}
		</>
	);
}
