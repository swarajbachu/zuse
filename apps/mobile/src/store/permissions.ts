import type {
	PermissionDecision,
	PermissionRequest,
	SessionId,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { create } from "zustand";
import { connectionSessionKey } from "~/lib/session-key";
import { decidePermission } from "~/rpc/actions";
import { getConnectionClient, reportConnectionFailure } from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

/**
 * Pending tool-permission prompts, surfaced as inline approval cards. These
 * arrive on the global `permission.requests` stream (not the message log), so
 * this store cold-loads via `permission.listPending` and shares one live stream
 * across every thread on a connection. Transcript streams remain session-local;
 * permission observation is intentionally connection-scoped.
 */
type PermissionsState = {
	pendingBySession: Record<string, readonly PermissionRequest[]>;
	hydrateConnection: (
		connKey: string,
		options: WsProtocolOptions,
		sessionIds: readonly SessionId[],
	) => Promise<void>;
	hydrate: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: SessionId,
	) => Promise<void>;
	reconcile: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: SessionId,
	) => Promise<void>;
	decide: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: SessionId,
		requestId: string,
		decision: PermissionDecision,
	) => Promise<void>;
};

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
	usePermissionsStore.setState({ pendingBySession: {} });
};

export const usePermissionsStore = create<PermissionsState>((set, get) => ({
	pendingBySession: {},
	hydrateConnection: async (connKey, options, sessionIds) => {
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
			set((state) => {
				const next = { ...state.pendingBySession };
				for (const snapshot of snapshots) {
					next[connectionSessionKey(connKey, snapshot.sessionId)] =
						normalizeRequests(snapshot.requests);
				}
				return { pendingBySession: next };
			});

			if (shouldStartStream && !liveFibers.has(connKey)) {
				let fiber: Fiber.Fiber<unknown, unknown>;
				const program = Stream.runForEach(
					client["permission.requests"]({}),
					(request) =>
						Effect.sync(() => {
							const key = connectionSessionKey(connKey, request.sessionId);
							set((state) => {
								const current = state.pendingBySession[key] ?? [];
								if (current.some((entry) => entry.id === request.id))
									return state;
								return {
									pendingBySession: {
										...state.pendingBySession,
										[key]: normalizeRequests([...current, request]),
									},
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
	},
	hydrate: async (connKey, options, sessionId) => {
		await get().hydrateConnection(connKey, options, [sessionId]);
	},
	reconcile: async (connKey, options, sessionId) => {
		const key = connectionSessionKey(connKey, sessionId);
		try {
			const client = await Effect.runPromise(getConnectionClient(options));
			const listed = await Effect.runPromise(
				client["permission.listPending"]({ sessionId }),
			);
			set((state) => ({
				pendingBySession: {
					...state.pendingBySession,
					[key]: normalizeRequests(listed),
				},
			}));
		} catch (cause) {
			reportConnectionFailure(options, cause);
		}
	},
	decide: async (connKey, options, sessionId, requestId, decision) => {
		const key = connectionSessionKey(connKey, sessionId);
		const previous = get().pendingBySession[key] ?? [];
		set((state) => ({
			pendingBySession: {
				...state.pendingBySession,
				[key]: (state.pendingBySession[key] ?? []).filter(
					(entry) => entry.id !== requestId,
				),
			},
		}));
		try {
			await Effect.runPromise(
				decidePermission({ connection: options, requestId, decision }),
			);
		} catch (cause) {
			reportConnectionFailure(options, cause);
			const failedRequest = previous.find((entry) => entry.id === requestId);
			set((state) => ({
				pendingBySession: {
					...state.pendingBySession,
					[key]:
						failedRequest === undefined ||
						(state.pendingBySession[key] ?? []).some(
							(entry) => entry.id === requestId,
						)
							? (state.pendingBySession[key] ?? [])
							: normalizeRequests([
									failedRequest,
									...(state.pendingBySession[key] ?? []),
								]),
				},
			}));
			throw cause;
		}
	},
}));

const normalizeRequests = (
	requests: readonly PermissionRequest[],
): PermissionRequest[] =>
	Array.from(
		new Map(requests.map((request) => [request.id, request])).values(),
	).sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
