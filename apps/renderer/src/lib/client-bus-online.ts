import { isPlatformOnline, subscribePlatformOnline } from "./network-status.ts";
import { getRendererClientBus } from "./session-timeline-client-bus.ts";

let installed = false;

/**
 * Wake the one ClientBus connection supervisor on a platform online edge.
 * Cached resources remain visible while offline; this only bypasses a pending
 * retry delay and cannot create per-feature reconnect loops.
 */
export const installClientBusOnlineBridge = (): (() => void) => {
	if (installed || typeof window === "undefined") return () => undefined;
	installed = true;
	const unsubscribe = subscribePlatformOnline(() => {
		if (isPlatformOnline()) getRendererClientBus().retryRetainedConnections();
	});
	return () => {
		unsubscribe();
		installed = false;
	};
};
