import { SessionId } from "@zuse/contracts";
import { Effect, Fiber, Ref } from "effect";
import { expect, it } from "vitest";
import {
	PendingWorkspaceExecutionPolicy,
	WorkspaceExecutionPolicy,
} from "../../src/conversation/services/workspace-execution-policy.ts";

const sessionId = SessionId.make("session");
const actor = { subject: "author", membershipId: "membership" };

it("leaves Personal queues compatible but denies attributed work without an authority", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const policy = yield* WorkspaceExecutionPolicy;
			expect(yield* policy.authorize(sessionId, undefined)).toBe(true);
			expect(yield* policy.authorize(sessionId, actor)).toBe(false);
		}),
	);
});

it("waits for bootstrap, then uses the bound policy for each queued execution", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const policy = yield* WorkspaceExecutionPolicy;
				const completed = yield* Ref.make(false);
				let allowed = true;
				const pending = yield* Effect.forkChild(
					policy
						.authorize(sessionId, actor)
						.pipe(Effect.tap(() => Ref.set(completed, true))),
				);
				yield* Effect.yieldNow;
				expect(yield* Ref.get(completed)).toBe(false);
				yield* policy.bind(() => Effect.sync(() => allowed));
				yield* Effect.yieldNow;
				expect(yield* Ref.get(completed)).toBe(false);
				yield* policy.markReady;
				expect(yield* Fiber.join(pending)).toBe(true);
				allowed = false;
				expect(yield* policy.authorize(sessionId, actor)).toBe(false);
			}),
		).pipe(Effect.provide(PendingWorkspaceExecutionPolicy)),
	);
});
