import "@zuse/i18n/english/settings";
import type { CloudAccountImage } from "@zuse/contracts";
import { useCloudProviderConnections } from "./cloud-provider-keys.tsx";
import { CloudSnapshotAgentAuthentication } from "./cloud-snapshot-access.tsx";
import { CloudSnapshotSettings } from "./cloud-snapshot-settings.tsx";
import { CloudWorkspaceAuth } from "./cloud-workspace-auth.tsx";

/** Source changes use the snapshot editor's shared save path. */
export function CloudSnapshotAuthSetup({
	onChanged,
	image,
}: {
	readonly image: CloudAccountImage;
	readonly onChanged: () => Promise<void>;
}) {
	const keys = useCloudProviderConnections();
	const connection = keys.active.find((key) => key.providerId === "boxd");
	return connection ? (
		<CloudSnapshotSettings
			connectionId={connection.connectionId}
			authenticationOnly
			onChanged={onChanged}
		/>
	) : image.snapshot?.agentAuthentication === "zuse" ? (
		<CloudWorkspaceAuth providers={["claude", "codex"]} />
	) : (
		<CloudSnapshotAgentAuthentication image={image} />
	);
}
