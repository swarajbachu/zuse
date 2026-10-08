import { isPlatformOnline, subscribePlatformOnline } from "./network-status.ts";
import { getRendererClientBus } from "./session-timeline-client-bus.ts";

let installed = false;

/**
 * Forward browser connectivity edges to the one ClientBus runtime owner.
 * Cached resources remain visible while offline; online starts one retained
 * reconnect episode and cannot create per-feature retry loops.
 */
export const installClientBusOnlineBridge = (): (() => void) => {
	if (installed || typeof window === "undefined") return () => undefined;
	installed = true;
	const unsubscribe = subscribePlatformOnline(() => {
		getRendererClientBus().setOnline(isPlatformOnline());
	});
	return () => {
		unsubscribe();
		installed = false;
	};
};
