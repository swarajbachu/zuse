import type {
	PermissionDecision,
	PermissionRequest,
	SessionId,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { Atom } from "effect/unstable/reactivity";

import { connectionSessionKey } from "~/lib/session-key";
import { decidePermission as decidePermissionRpc } from "~/rpc/actions";
import { getConnectionClient, reportConnectionFailure } from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

import { appAtomRegistry } from "./registry";

/**
 * Pending tool-permission prompts, surfaced as inline approval cards. These
 * arrive on the global `permission.requests` stream (not the message log), so
 * this module cold-loads via `permission.listPending` and shares one live
 * stream across every thread on a connection. Transcript streams remain
 * session-local; permission observation is intentionally connection-scoped.
 */
export const pendingBySessionAtom = Atom.make<
	Record<string, readonly PermissionRequest[]>
>({}).pipe(Atom.keepAlive);

const EMPTY_PENDING: readonly PermissionRequest[] = [];

/** Per-session pending prompts; notifies only when this session's change. */
export const pendingPermissionsAtom = Atom.family((key: string) =>
	Atom.make((get) => get(pendingBySessionAtom)[key] ?? EMPTY_PENDING),
);

const liveFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
const startingConnections = new Set<string>();

const stop = async (connKey: string) => {
	const fiber = liveFibers.get(connKey);
	if (fiber !== undefined) {
		liveFibers.delete(connKey);
		await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
	}
};

export const resetPermissionsRuntime = async (): Promise<void> => {
	startingConnections.clear();
	await Promise.all(Array.from(liveFibers.keys(), stop));
	appAtomRegistry.set(pendingBySessionAtom, {});
};

export const hydratePermissionConnection = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionIds: readonly SessionId[],
): Promise<void> => {
	const shouldStartStream =
		!liveFibers.has(connKey) && !startingConnections.has(connKey);
	if (shouldStartStream) startingConnections.add(connKey);
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		const snapshots = await Promise.all(
			sessionIds.map(async (sessionId) => ({
				sessionId,
				requests: await Effect.runPromise(
					client["permission.listPending"]({ sessionId }),
				),
			})),
		);
		appAtomRegistry.update(pendingBySessionAtom, (state) => {
			const next = { ...state };
			for (const snapshot of snapshots) {
				next[connectionSessionKey(connKey, snapshot.sessionId)] =
					normalizeRequests(snapshot.requests);
			}
			return next;
		});

		if (shouldStartStream && !liveFibers.has(connKey)) {
			let fiber: Fiber.Fiber<unknown, unknown>;
			const program = Stream.runForEach(
				client["permission.requests"]({}),
				(request) =>
					Effect.sync(() => {
						const key = connectionSessionKey(connKey, request.sessionId);
						appAtomRegistry.update(pendingBySessionAtom, (state) => {
							const current = state[key] ?? [];
							if (current.some((entry) => entry.id === request.id))
								return state;
							return {
								...state,
								[key]: normalizeRequests([...current, request]),
							};
						});
					}),
			).pipe(
				Effect.catch(() => Effect.void),
				Effect.ensuring(
					Effect.sync(() => {
						if (liveFibers.get(connKey) === fiber) liveFibers.delete(connKey);
					}),
				),
			);
			fiber = Effect.runFork(program);
			liveFibers.set(connKey, fiber);
		}
	} catch (cause) {
		reportConnectionFailure(options, cause);
	} finally {
		if (shouldStartStream) startingConnections.delete(connKey);
	}
};

export const hydratePermissions = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
): Promise<void> => {
	await hydratePermissionConnection(connKey, options, [sessionId]);
};

export const reconcilePermissions = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
): Promise<void> => {
	const key = connectionSessionKey(connKey, sessionId);
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		const listed = await Effect.runPromise(
			client["permission.listPending"]({ sessionId }),
		);
		appAtomRegistry.update(pendingBySessionAtom, (state) => ({
			...state,
			[key]: normalizeRequests(listed),
		}));
	} catch (cause) {
		reportConnectionFailure(options, cause);
	}
};

export const decidePermission = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
	requestId: string,
	decision: PermissionDecision,
): Promise<void> => {
	const key = connectionSessionKey(connKey, sessionId);
	try {
		await Effect.runPromise(
			decidePermissionRpc({ connection: options, requestId, decision }),
		);
		appAtomRegistry.update(pendingBySessionAtom, (state) => ({
			...state,
			[key]: (state[key] ?? []).filter((entry) => entry.id !== requestId),
		}));
	} catch (cause) {
		reportConnectionFailure(options, cause);
		throw cause;
	}
};

const normalizeRequests = (
	requests: readonly PermissionRequest[],
): PermissionRequest[] =>
	Array.from(
		new Map(requests.map((request) => [request.id, request])).values(),
	).sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
