import { describe, expect, test } from "vitest";

import { CommandDispatcher } from "./command-dispatch.js";

const deferred = <A>() => {
	let resolve!: (value: A) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<A>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
};

describe("CommandDispatcher", () => {
	test("deduplicates concurrent dispatch by command id", async () => {
		const dispatcher = new CommandDispatcher();
		const gate = deferred<string>();
		let calls = 0;
		const dispatch = () => {
			calls += 1;
			return gate.promise;
		};

		const first = dispatcher.dispatch("cmd-1", dispatch);
		const duplicate = dispatcher.dispatch("cmd-1", dispatch);
		expect(first).toBe(duplicate);
		expect(calls).toBe(1);
		gate.resolve("ok");
		await expect(duplicate).resolves.toBe("ok");
		await expect(
			dispatcher.dispatch("cmd-1", () => Promise.resolve("fresh")),
		).resolves.toBe("fresh");
		expect(calls).toBe(1);
	});

	test("keeps one receipt promise while redispatching after reconnect", async () => {
		const dispatcher = new CommandDispatcher();
		const firstAttempt = deferred<string>();
		let calls = 0;
		const operation = () => {
			calls += 1;
			return calls === 1 ? firstAttempt.promise : Promise.resolve("receipt");
		};

		const receipt = dispatcher.dispatch("cmd-2", operation, {
			shouldRetry: () => true,
		});
		firstAttempt.reject(new Error("connection lost"));
		await Promise.resolve();
		const [redispatched] = dispatcher.redispatchPending();
		expect(redispatched).toBe(receipt);
		await expect(receipt).resolves.toBe("receipt");
		expect(calls).toBe(2);
		expect(dispatcher.pendingCommandIds).toEqual([]);
	});

	test("rejects non-retryable failures", async () => {
		const dispatcher = new CommandDispatcher();
		const receipt = dispatcher.dispatch("cmd-3", () =>
			Promise.reject(new Error("validation failed")),
		);

		await expect(receipt).rejects.toThrow("validation failed");
		expect(dispatcher.pendingCommandIds).toEqual([]);
	});
});
