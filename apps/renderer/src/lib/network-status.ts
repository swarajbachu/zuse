import { useSyncExternalStore } from "react";

/**
 * The renderer's single mirror of `navigator.onLine`. Connection supervisors
 * consult it only for transports that cross the network; the composer banner
 * renders from it directly.
 */
let online = globalThis.navigator?.onLine ?? true;
const listeners = new Set<() => void>();

export const isPlatformOnline = (): boolean => online;

export const subscribePlatformOnline = (listener: () => void): (() => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

const setOnline = (next: boolean): void => {
	if (online === next) return;
	online = next;
	for (const listener of listeners) listener();
};

export const setPlatformOnlineForTest = setOnline;

/** Reads the mirror directly for the server snapshot so static-markup tests can flip it. */
export const usePlatformOnline = (): boolean =>
	useSyncExternalStore(
		subscribePlatformOnline,
		isPlatformOnline,
		isPlatformOnline,
	);

if (typeof window !== "undefined") {
	window.addEventListener("online", () => setOnline(true));
	window.addEventListener("offline", () => setOnline(false));
}
