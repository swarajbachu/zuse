import "@zuse/i18n/english/connections";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { WifiDisconnected01Icon } from "@zuse/icons/stroke-rounded";

import { usePlatformOnline } from "../../lib/network-status.ts";
import { TrayPill } from "./tray-pill.tsx";

/**
 * The one offline notice, attached to the composer like the queue and plan
 * trays. It reflects platform connectivity only: the local desktop keeps
 * working over IPC, and network-backed environments carry their own notices.
 */
export function NoConnectionTray() {
	const { message: uiMessage } = useUiMessages(["connections"]);

	const online = usePlatformOnline();
	if (online) return null;
	return (
		<TrayPill
			flush
			role="status"
			aria-live="polite"
			icon={
				<HugeiconsIcon icon={WifiDisconnected01Icon} className="size-3.5" />
			}
			title={uiMessage("connections:no_connection_tray_no_connection")}
			subtitle="Cloud and remote computers reconnect when you're back online."
		/>
	);
}
