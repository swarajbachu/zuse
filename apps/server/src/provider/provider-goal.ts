import type { GoalCapableSessionHandle } from "@zuse/agents/kernel/driver";
import {
	type AgentSessionId,
	AgentSessionNotFoundError,
	type ProviderId,
} from "@zuse/contracts";
import type { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Effect } from "effect";
import type { ProviderSessionRegistry } from "./provider-session-registry.ts";

export interface GoalResidency {
	readonly providerSessionId: string;
	readonly providerId: ProviderId;
}
export type GoalCurrentCheck = (
	residency: GoalResidency,
) => Effect.Effect<boolean>;
export type GoalPublication<A> = (
	value: A,
	residency: GoalResidency,
) => Effect.Effect<boolean | void>;

const mutationRevisions = new WeakMap<object, number>();

/** A delayed native goal reply can publish only while its exact process still owns the session. */
export const runProviderGoal = <
	A,
	Entry extends {
		readonly providerSessionId: string;
		readonly providerId: ProviderId;
		readonly handle: unknown;
	},
>(options: {
	readonly registry: ProviderSessionRegistry<AgentSessionId, Entry>;
	readonly lifecycle: KeyedEffectSerialWorker<AgentSessionId>;
	readonly sessionId: AgentSessionId;
	readonly entry: Entry;
	readonly operation: (handle: GoalCapableSessionHandle) => Effect.Effect<A>;
	readonly notificationDriven?: boolean;
	readonly readOnly?: boolean;
	readonly publish?: GoalPublication<A>;
	readonly verify?: GoalCurrentCheck;
}) => {
	const assertCurrent = Effect.gen(function* () {
		if (
			options.registry.lookup(options.sessionId) !== options.entry ||
			options.registry.currentProviderSessionId(options.sessionId) !==
				options.entry.providerSessionId ||
			(options.verify !== undefined &&
				!(yield* options.verify(options.entry))) ||
			(options.entry.providerId !== "codex" &&
				options.entry.providerId !== "grok")
		)
			return yield* new AgentSessionNotFoundError({
				sessionId: options.sessionId,
			});
	});
	const publish = (value: A, readRevision?: number) =>
		Effect.gen(function* () {
			yield* assertCurrent;
			// A read begun before a mutation cannot restore a paused or deleted goal.
			if (
				readRevision !== undefined &&
				(mutationRevisions.get(options.entry) ?? 0) !== readRevision
			)
				return value;
			if (
				options.publish !== undefined &&
				!(
					options.notificationDriven === true &&
					options.entry.providerId === "grok"
				)
			) {
				const accepted = yield* options.publish(value, {
					providerSessionId: options.entry.providerSessionId,
					providerId: options.entry.providerId,
				});
				if (accepted === false)
					return yield* new AgentSessionNotFoundError({
						sessionId: options.sessionId,
					});
			}
			return value;
		});
	if (options.readOnly === true)
		return Effect.gen(function* () {
			const revision = yield* options.lifecycle.run(
				options.sessionId,
				assertCurrent.pipe(
					Effect.map(() => mutationRevisions.get(options.entry) ?? 0),
				),
			);
			// Never hold the process lifecycle lock while awaiting a read-only RPC.
			const value = yield* options.operation(
				options.entry.handle as GoalCapableSessionHandle,
			);
			return yield* options.lifecycle.run(
				options.sessionId,
				publish(value, revision),
			);
		});
	return options.lifecycle.run(
		options.sessionId,
		Effect.gen(function* () {
			yield* assertCurrent;
			mutationRevisions.set(
				options.entry,
				(mutationRevisions.get(options.entry) ?? 0) + 1,
			);
			const value = yield* options.operation(
				options.entry.handle as GoalCapableSessionHandle,
			);
			return yield* publish(value);
		}),
	);
};
