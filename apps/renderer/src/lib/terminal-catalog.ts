import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import type { EnvironmentId, PtyOwnerId } from "@zuse/contracts";
import { structuralTupleKey } from "@zuse/utils/structural-tuple-key";
import {
	type TerminalPlacement,
	terminalOwnerId,
	useTerminalsStore,
} from "../store/terminals.ts";
import { listOwnedTerminals } from "./terminal-client-bus.ts";

type CatalogLoad = Readonly<{
	promise: Promise<void>;
	token: symbol;
}>;

const loads = new Map<string, CatalogLoad>();

class TerminalCatalogSupersededError extends Error {
	constructor() {
		super("Terminal catalog request was superseded");
		this.name = "TerminalCatalogSupersededError";
	}
}

/** Collision-safe identity for the server environment + PTY owner tuple. */
export const terminalCatalogKey = (
	environmentId: EnvironmentId,
	ownerId: PtyOwnerId,
): string => structuralTupleKey(environmentId, ownerId);

/**
 * Reconcile server-owned PTYs once before allocating a new renderer slot.
 * Concurrent terminal panels share an in-flight request. Settled responses are
 * never cached: the server catalog is cheap and another renderer may have
 * opened or closed a PTY since the previous reconciliation.
 */
export const loadTerminalCatalog = (
	ref: ChatRef,
	placement: TerminalPlacement,
	environmentId: EnvironmentId,
	options: Readonly<{ force?: boolean }> = {},
): Promise<void> => {
	const ownerId = terminalOwnerId(ref, placement);
	const key = terminalCatalogKey(environmentId, ownerId);
	const existing = loads.get(key);
	if (existing !== undefined && options.force !== true) {
		return existing.promise;
	}
	const token = Symbol(key);
	const promise = listOwnedTerminals(environmentId, ownerId).then((catalog) => {
		// A forced refresh or invalidation supersedes this response even when the
		// older request happens to settle last. Never let stale server state rewind
		// the renderer catalog.
		if (loads.get(key)?.token !== token) {
			throw new TerminalCatalogSupersededError();
		}
		useTerminalsStore
			.getState()
			.reconcileOwned(ref, environmentId, placement, catalog);
	});
	loads.set(key, { promise, token });
	void promise.then(
		() => {
			if (loads.get(key)?.promise === promise) loads.delete(key);
		},
		() => {
			if (loads.get(key)?.promise === promise) loads.delete(key);
		},
	);
	return promise;
};

export const invalidateTerminalCatalog = (
	ref: ChatRef,
	placement: TerminalPlacement,
	environmentId: EnvironmentId,
): void => {
	loads.delete(
		terminalCatalogKey(environmentId, terminalOwnerId(ref, placement)),
	);
};

/**
 * Hydrate the right-pane owner from every environment where that chat can have
 * a terminal. Cloud chats may also own a local synced-checkout terminal. When
 * the cloud environment is unavailable callers can exclude it, preserving the
 * local terminal without waking or reconnecting the cloud workspace.
 */
export const hydrateRightTerminalCatalog = async (
	ref: ChatRef,
	localEnvironmentId: EnvironmentId,
	options: Readonly<{
		includeOwnerEnvironment?: boolean;
		includeLocalEnvironment?: boolean;
	}> = {},
): Promise<void> => {
	const environments = new Set<EnvironmentId>();
	if (options.includeLocalEnvironment !== false)
		environments.add(localEnvironmentId);
	if (options.includeOwnerEnvironment !== false) {
		environments.add(ref.environmentId);
	}
	await Promise.all(
		[...environments].map((environmentId) =>
			loadTerminalCatalog(ref, "right", environmentId),
		),
	);
};
