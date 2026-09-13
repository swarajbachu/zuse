import { HugeiconsIcon } from "@hugeicons/react";
import { WifiDisconnected01Icon } from "@zuse/icons/stroke-rounded";

import { usePlatformOnline } from "../../lib/network-status.ts";
import { TrayPill } from "./tray-pill.tsx";

/**
 * The one offline notice, attached to the composer like the queue and plan
 * trays. It reflects platform connectivity only: the local desktop keeps
 * working over IPC, and network-backed environments carry their own notices.
 */
export function NoConnectionTray() {
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
			title="No connection"
			subtitle="Cloud and remote computers reconnect when you're back online."
		/>
	);
}
