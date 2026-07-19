import type {
	SessionId,
	ThreadGoal,
	ThreadGoalSetInput,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { create } from "zustand";

import { connectionSessionKey } from "~/lib/session-key";
import { getConnectionClient, reportConnectionFailure } from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

type GoalsState = {
	goalBySession: Record<string, ThreadGoal | null>;
	loadingBySession: Record<string, boolean>;
	errorBySession: Record<string, string | null>;
	hydrate: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: SessionId,
	) => Promise<void>;
	setGoal: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: SessionId,
		goal: ThreadGoalSetInput,
	) => Promise<void>;
	clearGoal: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: SessionId,
	) => Promise<void>;
};

const fibers = new Map<string, Fiber.Fiber<unknown, unknown>>();

const stop = async (key: string) => {
	const fiber = fibers.get(key);
	if (fiber === undefined) return;
	fibers.delete(key);
	await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
};

export const resetGoalsRuntime = async (): Promise<void> => {
	await Promise.all(Array.from(fibers.keys(), stop));
	useGoalsStore.setState({
		goalBySession: {},
		loadingBySession: {},
		errorBySession: {},
	});
};

export const useGoalsStore = create<GoalsState>((set) => ({
	goalBySession: {},
	loadingBySession: {},
	errorBySession: {},
	hydrate: async (connKey, options, sessionId) => {
		const key = connectionSessionKey(connKey, sessionId);
		await stop(key);
		set((state) => ({
			loadingBySession: { ...state.loadingBySession, [key]: true },
			errorBySession: { ...state.errorBySession, [key]: null },
		}));
		try {
			const client = await Effect.runPromise(getConnectionClient(options));
			const goal = await Effect.runPromise(
				client["session.goal.get"]({ sessionId }),
			);
			set((state) => ({
				goalBySession: { ...state.goalBySession, [key]: goal },
				loadingBySession: { ...state.loadingBySession, [key]: false },
			}));
			const program = Stream.runForEach(
				client["session.goal.stream"]({ sessionId }),
				(event) =>
					Effect.sync(() =>
						set((state) => ({
							goalBySession: { ...state.goalBySession, [key]: event.goal },
						})),
					),
			).pipe(Effect.catch(() => Effect.void));
			fibers.set(key, Effect.runFork(program));
		} catch (cause) {
			const unsupported =
				typeof cause === "object" &&
				cause !== null &&
				"_tag" in cause &&
				Reflect.get(cause, "_tag") === "GoalUnsupportedError";
			if (!unsupported) reportConnectionFailure(options, cause);
			set((state) => ({
				goalBySession: { ...state.goalBySession, [key]: null },
				loadingBySession: { ...state.loadingBySession, [key]: false },
				errorBySession: {
					...state.errorBySession,
					[key]: unsupported ? null : messageOf(cause),
				},
			}));
		}
	},
	setGoal: async (connKey, options, sessionId, goal) => {
		const key = connectionSessionKey(connKey, sessionId);
		try {
			const client = await Effect.runPromise(getConnectionClient(options));
			const next = await Effect.runPromise(
				client["session.goal.set"]({ sessionId, goal }),
			);
			set((state) => ({
				goalBySession: { ...state.goalBySession, [key]: next },
				errorBySession: { ...state.errorBySession, [key]: null },
			}));
		} catch (cause) {
			reportConnectionFailure(options, cause);
			set((state) => ({
				errorBySession: { ...state.errorBySession, [key]: messageOf(cause) },
			}));
			throw cause;
		}
	},
	clearGoal: async (connKey, options, sessionId) => {
		const key = connectionSessionKey(connKey, sessionId);
		try {
			const client = await Effect.runPromise(getConnectionClient(options));
			await Effect.runPromise(client["session.goal.clear"]({ sessionId }));
			set((state) => ({
				goalBySession: { ...state.goalBySession, [key]: null },
			}));
		} catch (cause) {
			reportConnectionFailure(options, cause);
			set((state) => ({
				errorBySession: { ...state.errorBySession, [key]: messageOf(cause) },
			}));
			throw cause;
		}
	},
}));

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);
