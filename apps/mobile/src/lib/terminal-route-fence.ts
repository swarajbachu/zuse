import { PtyOwnerId } from "@zuse/contracts";
import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Effect } from "effect";

export type TerminalRouteFence = Readonly<{
	/** Changes authority only after React commits the matching route. */
	commit: (identity: string) => void;
	isCurrent: (identity: string) => boolean;
}>;

/**
 * Commit-phase route fence for async terminal work. Rendering a speculative
 * identity is pure; only a committed layout may revoke the previous route.
 */
export const makeTerminalRouteFence = (): TerminalRouteFence => {
	let identity: string | null = null;
	return {
		commit: (nextIdentity) => {
			identity = nextIdentity;
		},
		isCurrent: (candidate) => candidate === identity,
	};
};

export type TerminalCatalogRefreshQueue<Value> = Readonly<{
	run: (
		routeIdentity: string,
		operation: () => PromiseLike<Value> | Value,
	) => Promise<Value>;
}>;

/**
 * Same-route catalog reads are FIFO so a post-mutation refresh cannot start
 * before an older snapshot finishes. The shared worker removes idle route
 * lanes, while different routes remain independent.
 */
export const makeTerminalCatalogRefreshQueue = <
	Value,
>(): TerminalCatalogRefreshQueue<Value> => {
	const worker = new KeyedEffectSerialWorker<string>();
	return {
		run: (routeIdentity, operation) =>
			Effect.runPromise(
				worker.run(
					routeIdentity,
					Effect.tryPromise({
						try: () => Promise.resolve(operation()),
						catch: (cause) => cause,
					}),
				),
			),
	};
};

export const terminalRouteIdentity = (
	connectionKey: string,
	sessionKey: string,
	cwd: string,
	ownerId: PtyOwnerId | null,
): string => JSON.stringify([connectionKey, sessionKey, cwd, ownerId]);

/**
 * A mobile terminal catalog belongs to one device-local app session. Legacy
 * releases used the bare device id. Do not probe or close that old owner during
 * migration: it may still contain a shell opened by another live session.
 */
export const mobileTerminalOwnerId = (
	deviceId: string,
	sessionId: string,
): PtyOwnerId =>
	PtyOwnerId.make(`mobile-terminal:${JSON.stringify([deviceId, sessionId])}`);
