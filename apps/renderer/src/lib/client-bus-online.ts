import { getRendererClientBus } from "./session-timeline-client-bus.ts";

let installed = false;

/**
 * Wake the one ClientBus connection supervisor on a browser online edge.
 * Cached resources remain visible while offline; this only bypasses a pending
 * retry delay and cannot create per-feature reconnect loops.
 */
export const installClientBusOnlineBridge = (): (() => void) => {
	if (installed || typeof window === "undefined") return () => undefined;
	installed = true;
	const retry = () => getRendererClientBus().retryRetainedConnections();
	window.addEventListener("online", retry);
	return () => {
		window.removeEventListener("online", retry);
		installed = false;
	};
};
