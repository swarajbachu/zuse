import { useEffect } from "react";

import { openAddComputerDialog } from "./add-computer-dialog.tsx";

/**
 * Receives `zuse:///connect/pair` deep links forwarded by the main process
 * and opens the Add-computer dialog with the link prefilled. Never connects
 * automatically — the user reviews the link and presses Connect. Registering
 * the handler before subscribing matters: main buffers links that arrived
 * before the renderer was ready and flushes them on subscribe.
 */
export function PairingLinkAccept() {
	useEffect(() => {
		const pairing = window.zuse?.pairing;
		if (pairing?.onPairingLink === undefined) return;
		const unsubscribe = pairing.onPairingLink((link) => {
			openAddComputerDialog({ link });
		});
		pairing.subscribePairingLinks?.();
		return unsubscribe;
	}, []);
	return null;
}
