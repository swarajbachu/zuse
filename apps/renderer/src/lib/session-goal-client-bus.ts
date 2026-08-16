import type {
	ResourceDriver,
	ResourceLease,
} from "@zuse/client-runtime/client-bus";
import type {
	CommandReceipt,
	PersistedResource,
	ResourcePersistence,
} from "@zuse/client-runtime/client-persistence";
import type { ResourceActivation } from "@zuse/client-runtime/environment-runtime";
import {
	makeResourceKey,
	type ResourceKey,
	resourceKeyId,
	type SessionRef,
} from "@zuse/client-runtime/resource-ref";
import {
	emptyResourceView,
	type ResourceView,
} from "@zuse/client-runtime/resource-state";
import {
	CommandId,
	type ThreadGoal,
	type ThreadGoalSetInput,
} from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useMemo } from "react";
import type { MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
	registerRendererResourcePersistence,
} from "./session-timeline-client-bus.ts";
import { useClientBusResource } from "./use-client-bus-resource.ts";

export type SessionGoalData = Readonly<{
	goal: ThreadGoal | null;
}>;

export type SessionGoalResourceKey = ResourceKey<SessionGoalData>;

export const sessionGoalResourceKey = (
	ref: SessionRef,
): SessionGoalResourceKey => makeResourceKey("session-goal", ref);

const sessionRefFromKey = (key: ResourceKey<unknown>): SessionRef | null =>
	key.kind === "session-goal" && "sessionId" in key.ref ? key.ref : null;

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const isGoalResourceFailure = (cause: unknown): boolean => {
	const tag =
		typeof cause === "object" && cause !== null && "_tag" in cause
			? cause._tag
			: null;
	return tag === "GoalUnsupportedError" || tag === "SessionNotFoundError";
};

let driverStarts = 0;

const makeSessionGoalDriver = (): ResourceDriver<
	MemoizeClient,
	SessionGoalData
> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;

	return {
		start: (context) => {
			const ref = sessionRefFromKey(context.key);
			if (ref === null) return;
			active = true;
			driverStarts += 1;
			// The goal feed is snapshot-first but does not expose a durable sequence.
			// Give each attachment a fresh epoch so its authoritative initial frame can
			// replace a cached cursor even after a same-generation release/re-retain.
			const epoch = `session-goal:${context.generation}:${crypto.randomUUID()}`;
			let version = 0;
			const program = Stream.runForEach(
				context.client["session.goal.stream"]({ sessionId: ref.sessionId }),
				(event) =>
					Effect.sync(() => {
						if (
							!active ||
							!context.isCurrent() ||
							event.sessionId !== ref.sessionId
						) {
							return;
						}
						version += 1;
						context.emit({
							data: { goal: event.goal },
							cursor: { epoch, version },
							resetEpoch: context.cursor?.epoch !== epoch,
							sync: "live",
							persist: true,
						});
					}),
			).pipe(
				Effect.andThen(
					Effect.fail(new Error("Session goal stream ended unexpectedly")),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (!active || Cause.hasInterruptsOnly(cause)) return;
						const failure = Cause.squash(cause);
						context.emit({ sync: "failed" });
						// A domain gap belongs to this keyed resource; only transport-level
						// termination is allowed to restart the shared environment connection.
						if (isGoalResourceFailure(failure)) return;
						getRendererClientBus().reportConnectionFault(
							ref.environmentId,
							{ phase: "failed", message: messageOf(failure) },
							context.generation,
						);
					}),
				),
			);
			fiber = Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(program)));
		},
		stop: () => {
			active = false;
			const running = fiber;
			fiber = null;
			if (running !== null) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};

registerRendererResourceDriver("session-goal", (key) =>
	sessionRefFromKey(key) === null
		? null
		: (makeSessionGoalDriver() as ResourceDriver<MemoizeClient, unknown>),
);

const DATABASE_NAME = "zuse-session-goal-resources";
const DATABASE_VERSION = 1;
const STORE_NAME = "resources";

const requestResult = <Value>(request: IDBRequest<Value>): Promise<Value> =>
	new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
	new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
	});

class IndexedDbSessionGoalPersistence implements ResourcePersistence {
	private database: Promise<IDBDatabase> | null = null;

	private db(): Promise<IDBDatabase> {
		this.database ??= new Promise((resolve, reject) => {
			const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(STORE_NAME)) {
					request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () =>
				reject(request.error ?? new Error("Unable to open session goal cache"));
		});
		return this.database;
	}

	async loadResource<Data>(
		key: ResourceKey<Data>,
	): Promise<PersistedResource<Data> | null> {
		const database = await this.db();
		const transaction = database.transaction(STORE_NAME, "readonly");
		const row = (await requestResult(
			transaction.objectStore(STORE_NAME).get(resourceKeyId(key)),
		)) as
			| (PersistedResource<SessionGoalData> & { readonly key: string })
			| undefined;
		await transactionComplete(transaction);
		if (
			row === undefined ||
			typeof row.data !== "object" ||
			row.data === null ||
			!("goal" in row.data)
		) {
			return null;
		}
		return {
			data: row.data as Data,
			cursor: row.cursor,
			storedAt: row.storedAt,
		};
	}

	async saveResource<Data>(
		key: ResourceKey<Data>,
		value: PersistedResource<Data>,
	): Promise<void> {
		const database = await this.db();
		const transaction = database.transaction(STORE_NAME, "readwrite");
		transaction.objectStore(STORE_NAME).put({
			key: resourceKeyId(key),
			...value,
		});
		await transactionComplete(transaction);
	}

	async removeResource(key: ResourceKey<unknown>): Promise<void> {
		const database = await this.db();
		const transaction = database.transaction(STORE_NAME, "readwrite");
		transaction.objectStore(STORE_NAME).delete(resourceKeyId(key));
		await transactionComplete(transaction);
	}
}

if (typeof indexedDB !== "undefined") {
	registerRendererResourcePersistence(
		"session-goal",
		new IndexedDbSessionGoalPersistence(),
	);
}

const EMPTY_GOAL_VIEW = emptyResourceView<SessionGoalData>();

export const useSessionGoalResource = (
	ref: SessionRef | null,
	activation: ResourceActivation = "connect",
): ResourceView<SessionGoalData> => {
	const key = useMemo(
		() => (ref === null ? null : sessionGoalResourceKey(ref)),
		[ref?.environmentId, ref?.sessionId],
	);
	return useClientBusResource(key, EMPTY_GOAL_VIEW, activation);
};

export const retainSessionGoal = (
	ref: SessionRef,
	activation: ResourceActivation = "connect",
): Readonly<{ key: SessionGoalResourceKey; lease: ResourceLease }> => {
	const key = sessionGoalResourceKey(ref);
	return {
		key,
		lease: getRendererClientBus().retain(key, { activation }),
	};
};

export const setSessionGoal = (input: {
	readonly ref: SessionRef;
	readonly goal: ThreadGoalSetInput;
	readonly commandId?: CommandId;
}): Promise<CommandReceipt<ThreadGoal>> =>
	getRendererClientBus().dispatch({
		kind: "session.goal.set",
		commandId:
			input.commandId ??
			CommandId.make(`session-goal-set:${crypto.randomUUID()}`),
		environmentId: input.ref.environmentId,
		resource: sessionGoalResourceKey(input.ref),
		payload: { sessionId: input.ref.sessionId, goal: input.goal },
		retry: "safe",
		createdAt: Date.now(),
	});

export const clearSessionGoal = (input: {
	readonly ref: SessionRef;
	readonly commandId?: CommandId;
}): Promise<CommandReceipt<void>> =>
	getRendererClientBus().dispatch({
		kind: "session.goal.clear",
		commandId:
			input.commandId ??
			CommandId.make(`session-goal-clear:${crypto.randomUUID()}`),
		environmentId: input.ref.environmentId,
		resource: sessionGoalResourceKey(input.ref),
		payload: { sessionId: input.ref.sessionId },
		retry: "safe",
		createdAt: Date.now(),
	});

export const sessionGoalDriverStartsForTest = (): number => driverStarts;

export const resetSessionGoalClientBusForTest = (): void => {
	driverStarts = 0;
};
