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
	});

	test("re-dispatches only commands without receipts after reconnect", async () => {
		const dispatcher = new CommandDispatcher();
		const firstAttempt = deferred<string>();
		let calls = 0;
		const operation = () => {
			calls += 1;
			return calls === 1 ? firstAttempt.promise : Promise.resolve("receipt");
		};

		void dispatcher.dispatch("cmd-2", operation).catch(() => undefined);
		firstAttempt.reject(new Error("connection lost"));
		await Promise.resolve();
		await expect(Promise.all(dispatcher.redispatchPending())).resolves.toEqual([
			"receipt",
		]);
		expect(calls).toBe(2);
		expect(dispatcher.pendingCommandIds).toEqual([]);
	});
});
