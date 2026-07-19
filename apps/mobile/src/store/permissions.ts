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
 * this store cold-loads via `permission.listPending` on mount and then filters
 * the live stream down to the active session — mirroring the fiber lifecycle of
 * the messages store.
 */
type PermissionsState = {
	pendingBySession: Record<string, readonly PermissionRequest[]>;
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

const stop = async (key: string) => {
	const fiber = liveFibers.get(key);
	if (fiber !== undefined) {
		liveFibers.delete(key);
		await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
	}
};

export const resetPermissionsRuntime = async (): Promise<void> => {
	await Promise.all(Array.from(liveFibers.keys(), stop));
	usePermissionsStore.setState({ pendingBySession: {} });
};

export const usePermissionsStore = create<PermissionsState>((set, get) => ({
	pendingBySession: {},
	hydrate: async (connKey, options, sessionId) => {
		const liveKey = connectionSessionKey(connKey, sessionId);
		await stop(liveKey);
		try {
			const client = await Effect.runPromise(getConnectionClient(options));

			const listed = await Effect.runPromise(
				client["permission.listPending"]({ sessionId }),
			);
			set((state) => ({
				pendingBySession: {
					...state.pendingBySession,
					[liveKey]: normalizeRequests(listed),
				},
			}));

			const program = Stream.runForEach(
				client["permission.requests"]({}),
				(request) =>
					Effect.sync(() => {
						if (request.sessionId !== sessionId) return;
						set((state) => {
							const current = state.pendingBySession[liveKey] ?? [];
							if (current.some((entry) => entry.id === request.id))
								return state;
							return {
								pendingBySession: {
									...state.pendingBySession,
									[liveKey]: normalizeRequests([...current, request]),
								},
							};
						});
					}),
			).pipe(Effect.catch(() => Effect.void));
			liveFibers.set(liveKey, Effect.runFork(program));
		} catch (cause) {
			reportConnectionFailure(options, cause);
			// A dropped permission stream is non-fatal: the messages store already
			// surfaces the connection error, and hydrate re-runs on the next mount.
		}
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
