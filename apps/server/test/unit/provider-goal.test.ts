import { AgentSessionId } from "@zuse/contracts";
import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Deferred, Effect, Fiber } from "effect";
import { expect, it } from "vitest";
import { runProviderGoal } from "../../src/provider/provider-goal.ts";
import { makeProviderSessionRegistry } from "../../src/provider/provider-session-registry.ts";

it.each([
	"replacement",
	"shutdown",
] as const)("drops a late Codex goal reply after %s", async (kind) => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const sessionId = AgentSessionId.make("session");
				const entry = {
					providerSessionId: "old",
					providerId: "codex" as const,
					handle: {},
				};
				const registry = makeProviderSessionRegistry<
					AgentSessionId,
					typeof entry
				>();
				registry.publish(sessionId, registry.begin(sessionId, "old"), entry);
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				let published = false;
				const request = yield* runProviderGoal({
					registry,
					lifecycle: new KeyedEffectSerialWorker(),
					sessionId,
					entry,
					operation: () =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.as("old goal"),
						),
					publish: () =>
						Effect.sync(() => {
							published = true;
						}),
				}).pipe(Effect.forkScoped);
				yield* Deferred.await(entered);
				if (kind === "replacement") registry.begin(sessionId, "replacement");
				else registry.invalidate(sessionId);
				yield* Deferred.succeed(release, undefined);
				expect((yield* Fiber.await(request))._tag).toBe("Failure");
				expect(published).toBe(false);
			}),
		),
	);
});

it("rejects canonical provider revocation while process retirement is still queued", async () => {
	const { layer } = await import("@zuse/sqlite");
	const { SqlClient } = await import("effect/unstable/sql");
	const { makeCurrentGoalPublisher, isCurrentGoalResidency } = await import(
		"../../src/conversation/core/current-goal-publisher.ts"
	);
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TABLE sessions(id TEXT,provider_reservation_id TEXT,provider_id TEXT,archived_at TEXT)`;
				yield* sql`INSERT INTO sessions VALUES('session','old','codex',NULL)`;
				const sessionId = AgentSessionId.make("session");
				const entry = {
					providerSessionId: "old",
					providerId: "codex" as const,
					handle: {},
				};
				const registry = makeProviderSessionRegistry<
					AgentSessionId,
					typeof entry
				>();
				registry.publish(sessionId, registry.begin(sessionId, "old"), entry);
				const lifecycle = new KeyedEffectSerialWorker<AgentSessionId>();
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				let published = 0;
				const publish = makeCurrentGoalPublisher(sql, () =>
					Effect.sync(() => {
						published++;
					}),
				);
				const request = yield* runProviderGoal({
					registry,
					lifecycle,
					sessionId,
					entry,
					verify: (owner) => isCurrentGoalResidency(sql, sessionId, owner),
					operation: () =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.as(null),
						),
					publish: (goal, owner) => publish(sessionId, owner, goal),
				}).pipe(Effect.forkScoped);
				yield* Deferred.await(entered);
				yield* sql`UPDATE sessions SET provider_reservation_id=NULL,provider_id='claude'`;
				expect(registry.lookup(sessionId)).toBe(entry);
				yield* Deferred.succeed(release, undefined);
				expect((yield* Fiber.await(request))._tag).toBe("Failure");
				expect(published).toBe(0);
				let invoked = false;
				const rejected = yield* runProviderGoal({
					registry,
					lifecycle,
					sessionId,
					entry,
					verify: (owner) => isCurrentGoalResidency(sql, sessionId, owner),
					operation: () =>
						Effect.sync(() => {
							invoked = true;
							return null;
						}),
				}).pipe(Effect.result);
				expect(rejected._tag).toBe("Failure");
				expect(invoked).toBe(false);
				expect(yield* publish(sessionId, entry, null)).toBe(false);
				expect(published).toBe(0);
			}),
		).pipe(Effect.provide(layer({ filename: ":memory:" }))),
	);
});

it.each([
	"pause",
	"clear",
])("does not hold %s behind a slow goal read", async (kind) => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const sessionId = AgentSessionId.make("slow-read-session");
				const entry = {
					providerSessionId: "owner",
					providerId: "codex" as const,
					handle: {},
				};
				const registry = makeProviderSessionRegistry<
					AgentSessionId,
					typeof entry
				>();
				registry.publish(sessionId, registry.begin(sessionId, "owner"), entry);
				const lifecycle = new KeyedEffectSerialWorker<AgentSessionId>();
				const readEntered = yield* Deferred.make<void>();
				const releaseRead = yield* Deferred.make<void>();
				const controlEntered = yield* Deferred.make<void>();
				const published: string[] = [];
				const read = yield* runProviderGoal({
					registry,
					lifecycle,
					sessionId,
					entry,
					readOnly: true,
					operation: () =>
						Deferred.succeed(readEntered, undefined).pipe(
							Effect.andThen(Deferred.await(releaseRead)),
							Effect.as("active"),
						),
					publish: (value) =>
						Effect.sync(() => {
							published.push(value);
						}),
				}).pipe(Effect.forkScoped);
				yield* Deferred.await(readEntered);
				const control = yield* runProviderGoal({
					registry,
					lifecycle,
					sessionId,
					entry,
					notificationDriven: true,
					operation: () =>
						Deferred.succeed(controlEntered, undefined).pipe(Effect.as(kind)),
					publish: (value) =>
						Effect.sync(() => {
							published.push(value);
						}),
				}).pipe(Effect.forkScoped);
				const responsive = yield* Effect.raceFirst(
					Deferred.await(controlEntered).pipe(Effect.as(true)),
					Effect.sleep("20 millis").pipe(Effect.as(false)),
				);
				yield* Deferred.succeed(releaseRead, undefined);
				yield* Fiber.join(control);
				yield* Fiber.join(read);
				expect(responsive).toBe(true);
				expect(published).toEqual([kind]);
			}),
		),
	);
});
