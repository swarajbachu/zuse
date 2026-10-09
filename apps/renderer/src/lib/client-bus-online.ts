import { isPlatformOnline, subscribePlatformOnline } from "./network-status.ts";
import { retryInterruptedRendererRpcConnections } from "./rpc-client.ts";
import {
	environmentRetryPolicy,
	getRendererClientBus,
} from "./session-timeline-client-bus.ts";

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

/** Focus wakeups closer together than this reuse the previous probe. */
export const CONNECTION_FOCUS_WAKE_MIN_INTERVAL_MS = 5_000;
/** How often a visible window refreshes computer presence. */
export const CONNECTION_PRESENCE_REFRESH_MS = 60_000;

/**
 * Skip retry backoff for interrupted self-hosted connections, then let the
 * caller refresh presence. Cloud workspaces keep their bounded ladder.
 */
const retryInterruptedConnections = (): void => {
	getRendererClientBus().retryRetainedConnections(
		(environmentId) => environmentRetryPolicy(environmentId) === "unbounded",
	);
	retryInterruptedRendererRpcConnections();
};

/**
 * Reconnect without user action when this device resumes from sleep, the
 * screen unlocks, or the window comes back into view, and keep computer
 * presence fresh while the window is visible.
 */
export const installConnectionWakeups = (
	refreshPresence: () => void,
): (() => void) => {
	if (typeof window === "undefined") return () => undefined;
	let lastFocusWakeAt = 0;
	const wake = (): void => {
		retryInterruptedConnections();
		refreshPresence();
	};
	const onVisibilityChange = (): void => {
		if (document.visibilityState !== "visible") return;
		const now = Date.now();
		if (now - lastFocusWakeAt < CONNECTION_FOCUS_WAKE_MIN_INTERVAL_MS) return;
		lastFocusWakeAt = now;
		wake();
	};
	const unsubscribeResume = window.zuse?.power?.onResume?.(wake);
	document.addEventListener("visibilitychange", onVisibilityChange);
	const presenceTimer = setInterval(() => {
		if (document.visibilityState === "visible" && isPlatformOnline())
			refreshPresence();
	}, CONNECTION_PRESENCE_REFRESH_MS);
	return () => {
		unsubscribeResume?.();
		document.removeEventListener("visibilitychange", onVisibilityChange);
		clearInterval(presenceTimer);
	};
};
