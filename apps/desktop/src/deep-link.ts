/**
 * Pure deep-link helpers for the main process. Kept free of Electron imports
 * so routing decisions and delivery buffering stay unit-testable.
 */

const PAIRING_SCHEMES = new Set(["zuse:", "memoize:"]);

/**
 * True when the argument is a Zuse connect/pair deep link, in either the
 * canonical triple-slash form (`zuse:///connect/pair?...`) or the legacy
 * host form (`zuse://connect/pair?...`) that older links and mobile builds
 * emit. Never throws on garbage input.
 */
export const isPairingDeepLink = (arg: string): boolean => {
	let url: URL;
	try {
		url = new URL(arg);
	} catch {
		return false;
	}
	if (!PAIRING_SCHEMES.has(url.protocol)) return false;
	return (
		url.pathname === "/connect/pair" ||
		(url.hostname === "connect" && url.pathname === "/pair")
	);
};

export type BufferedChannel<T> = {
	/** Deliver to the subscriber, or buffer until one attaches. */
	readonly publish: (item: T) => void;
	/** Attach the subscriber; buffered items flush immediately, in order. */
	readonly subscribe: (handler: (item: T) => void) => void;
};

/**
 * Single-subscriber channel that buffers published items until a subscriber
 * attaches, then flushes them in order. Deep links can arrive before the
 * renderer exists (cold start), so main publishes into this and the renderer
 * subscribes once its handler is mounted. Re-subscribing (renderer reload)
 * replaces the handler.
 */
export const createBufferedChannel = <T>(): BufferedChannel<T> => {
	const buffered: T[] = [];
	let subscriber: ((item: T) => void) | null = null;
	return {
		publish: (item) => {
			if (subscriber === null) {
				buffered.push(item);
				return;
			}
			subscriber(item);
		},
		subscribe: (handler) => {
			subscriber = handler;
			while (buffered.length > 0) {
				const item = buffered.shift() as T;
				handler(item);
			}
		},
	};
};
