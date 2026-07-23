import type {
	SessionId,
	ThreadGoal,
	ThreadGoalSetInput,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { Atom } from "effect/unstable/reactivity";

import { connectionSessionKey } from "~/lib/session-key";
import { getConnectionClient, reportConnectionFailure } from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

import { appAtomRegistry, batchAtomUpdates } from "./registry";

export const goalBySessionAtom = Atom.make<Record<string, ThreadGoal | null>>(
	{},
).pipe(Atom.keepAlive);
export const goalLoadingBySessionAtom = Atom.make<Record<string, boolean>>(
	{},
).pipe(Atom.keepAlive);
export const goalErrorBySessionAtom = Atom.make<
	Record<string, string | null>
>({}).pipe(Atom.keepAlive);

/** Per-session goal; notifies only when this session's goal changes. */
export const sessionGoalAtom = Atom.family((key: string) =>
	Atom.make((get) => get(goalBySessionAtom)[key] ?? null),
);

const fibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
const hydrationGeneration = new Map<string, number>();

const stop = async (key: string) => {
	const fiber = fibers.get(key);
	if (fiber === undefined) return;
	fibers.delete(key);
	await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
};

export const resetGoalsRuntime = async (): Promise<void> => {
	await Promise.all(Array.from(fibers.keys(), stop));
	hydrationGeneration.clear();
	batchAtomUpdates(() => {
		appAtomRegistry.set(goalBySessionAtom, {});
		appAtomRegistry.set(goalLoadingBySessionAtom, {});
		appAtomRegistry.set(goalErrorBySessionAtom, {});
	});
};

const patchGoal = (key: string, goal: ThreadGoal | null): void => {
	appAtomRegistry.update(goalBySessionAtom, (state) => ({
		...state,
		[key]: goal,
	}));
};

export const releaseGoal = async (
	connKey: string,
	sessionId: SessionId,
): Promise<void> => {
	const key = connectionSessionKey(connKey, sessionId);
	hydrationGeneration.set(key, (hydrationGeneration.get(key) ?? 0) + 1);
	await stop(key);
};

export const hydrateGoal = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
): Promise<void> => {
	const key = connectionSessionKey(connKey, sessionId);
	const generation = (hydrationGeneration.get(key) ?? 0) + 1;
	hydrationGeneration.set(key, generation);
	await stop(key);
	batchAtomUpdates(() => {
		appAtomRegistry.update(goalLoadingBySessionAtom, (state) => ({
			...state,
			[key]: true,
		}));
		appAtomRegistry.update(goalErrorBySessionAtom, (state) => ({
			...state,
			[key]: null,
		}));
	});
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		const goal = await Effect.runPromise(
			client["session.goal.get"]({ sessionId }),
		);
		if (hydrationGeneration.get(key) !== generation) return;
		batchAtomUpdates(() => {
			patchGoal(key, goal);
			appAtomRegistry.update(goalLoadingBySessionAtom, (state) => ({
				...state,
				[key]: false,
			}));
		});
		const program = Stream.runForEach(
			client["session.goal.stream"]({ sessionId }),
			(event) =>
				Effect.sync(() => {
					if (hydrationGeneration.get(key) !== generation) return;
					patchGoal(key, event.goal);
				}),
		).pipe(Effect.catch(() => Effect.void));
		fibers.set(key, Effect.runFork(program));
	} catch (cause) {
		if (hydrationGeneration.get(key) !== generation) return;
		const unsupported =
			typeof cause === "object" &&
			cause !== null &&
			"_tag" in cause &&
			Reflect.get(cause, "_tag") === "GoalUnsupportedError";
		if (!unsupported) reportConnectionFailure(options, cause);
		batchAtomUpdates(() => {
			patchGoal(key, null);
			appAtomRegistry.update(goalLoadingBySessionAtom, (state) => ({
				...state,
				[key]: false,
			}));
			appAtomRegistry.update(goalErrorBySessionAtom, (state) => ({
				...state,
				[key]: unsupported ? null : messageOf(cause),
			}));
		});
	}
};

export const setGoal = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
	goal: ThreadGoalSetInput,
): Promise<void> => {
	const key = connectionSessionKey(connKey, sessionId);
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		const next = await Effect.runPromise(
			client["session.goal.set"]({ sessionId, goal }),
		);
		batchAtomUpdates(() => {
			patchGoal(key, next);
			appAtomRegistry.update(goalErrorBySessionAtom, (state) => ({
				...state,
				[key]: null,
			}));
		});
	} catch (cause) {
		reportConnectionFailure(options, cause);
		appAtomRegistry.update(goalErrorBySessionAtom, (state) => ({
			...state,
			[key]: messageOf(cause),
		}));
		throw cause;
	}
};

export const clearGoal = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
): Promise<void> => {
	const key = connectionSessionKey(connKey, sessionId);
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		await Effect.runPromise(client["session.goal.clear"]({ sessionId }));
		patchGoal(key, null);
	} catch (cause) {
		reportConnectionFailure(options, cause);
		appAtomRegistry.update(goalErrorBySessionAtom, (state) => ({
			...state,
			[key]: messageOf(cause),
		}));
		throw cause;
	}
};

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);
