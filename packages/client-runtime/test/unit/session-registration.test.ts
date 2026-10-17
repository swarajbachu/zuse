import { SessionId, SessionNotFoundError } from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { waitForSessionRegistration } from "../../src/session-registration.ts";

const missing = new SessionNotFoundError({
	sessionId: SessionId.make("new-session"),
});
afterEach(() => vi.useRealTimers());

it("bounds retries for a session that never registers", async () => {
	vi.useFakeTimers();
	let attempts = 0;
	const result = Effect.runPromise(
		waitForSessionRegistration(() => {
			attempts++;
			return Stream.fail(missing);
		}).pipe(Stream.runCollect, Effect.result),
	);
	await vi.advanceTimersByTimeAsync(5000);
	expect((await result)._tag).toBe("Failure");
	expect(attempts).toBe(50);
});

it("does not replay a stream after receiving data", async () => {
	let attempts = 0;
	const result = await Effect.runPromise(
		waitForSessionRegistration(() => {
			attempts++;
			return Stream.make(1).pipe(Stream.concat(Stream.fail(missing)));
		}).pipe(Stream.runCollect, Effect.result),
	);
	expect(result._tag).toBe("Failure");
	expect(attempts).toBe(1);
});

it("leaves unrelated failures authoritative", async () => {
	let attempts = 0;
	const result = await Effect.runPromise(
		waitForSessionRegistration(() => {
			attempts++;
			return Stream.fail({ _tag: "RpcAccessDeniedError" });
		}).pipe(Stream.runCollect, Effect.result),
	);
	expect(result._tag).toBe("Failure");
	expect(attempts).toBe(1);
});

it("cancels pending registration retries when the consumer stops", async () => {
	vi.useFakeTimers();
	let attempts = 0;
	const fiber = Effect.runFork(
		waitForSessionRegistration(() => {
			attempts++;
			return Stream.fail(missing);
		}).pipe(Stream.runDrain),
	);
	await vi.advanceTimersByTimeAsync(0);
	expect(attempts).toBe(1);
	await Effect.runPromise(Fiber.interrupt(fiber));
	await vi.advanceTimersByTimeAsync(5000);
	expect(attempts).toBe(1);
});
