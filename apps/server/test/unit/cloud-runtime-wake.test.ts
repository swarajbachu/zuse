import { Effect, Fiber } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudRuntimeWake } from "../../src/api/cloud-runtime-wake.ts";

const monitors: CloudRuntimeWake[] = [];
afterEach(async () => {
	await Promise.all(monitors.splice(0).map((wake) => wake.close()));
	vi.unstubAllGlobals();
});
const monitor = () => {
	const wake = new CloudRuntimeWake();
	monitors.push(wake);
	return wake;
};

describe("preserved-runtime wake", () => {
	it("resets real control-plane HTTP sockets on wake without interrupting an unrelated stream", async () => {
		const wake = monitor();
		let localResponse: ServerResponse | undefined;
		let observed = 0;
		let bothStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			bothStarted = resolve;
		});
		const server = createServer((request, response) => {
			if (request.url === "/fresh") {
				response.end("fresh");
				return;
			}
			if (request.url === "/local") localResponse = response;
			if (++observed === 2) bothStarted();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (address === null || typeof address === "string")
			throw new Error("missing test listener");
		const url = `http://127.0.0.1:${address.port}`;
		try {
			const owned = wake.request(`${url}/owned`, {}).then(
				() => "unexpected response",
				() => "aborted",
			);
			const independent = fetch(`${url}/local`).then((response) =>
				response.text(),
			);
			await started;
			wake.observe(Date.now() + 60_000);
			expect(await owned).toBe("aborted");
			localResponse?.end("local turn remains connected");
			expect(await independent).toBe("local turn remains connected");
			expect(await (await wake.request(`${url}/fresh`, {})).text()).toBe(
				"fresh",
			);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
	it("ignores normal one-second timer jitter and short pauses", () => {
		const wake = monitor();
		const now = Date.now();
		const mono = performance.now();
		expect(wake.observe(now + 1100, mono + 1100)).toBe(false);
		expect(wake.observe(now + 2200, mono + 2200)).toBe(false);
		expect(wake.observe(now + 4300, mono + 4300)).toBe(false);
	});

	it("detects wall clock advance while monotonic time was frozen and large event-loop delay", () => {
		const wake = monitor();
		const now = Date.now();
		const mono = performance.now();
		expect(wake.observe(now + 600_000, mono + 1000)).toBe(true);
		expect(wake.observe(now + 601_000, mono + 2000)).toBe(false);
		expect(wake.observe(now + 607_000, mono + 8000)).toBe(true);
	});

	it("aborts only its own HTTP pool, with a fresh pool for the next request", async () => {
		const wake = monitor();
		const fetcher = vi.fn().mockResolvedValue(Response.json({}));
		vi.stubGlobal("fetch", fetcher);
		await wake.request("https://api.test", {});
		const old = fetcher.mock.calls[0]?.[1];
		wake.observe(Date.now() + 60_000);
		expect(old.signal.aborted).toBe(true);
		await wake.request("https://api.test", {});
		expect(fetcher.mock.calls[1]?.[1].signal.aborted).toBe(false);
		expect(fetcher.mock.calls[1]?.[1].dispatcher).not.toBe(old.dispatcher);
	});

	it("interrupts a stale network attempt/backoff immediately without stopping independent local work", async () => {
		const wake = monitor();
		let attempts = 0;
		let cancelled = 0;
		let localAlive = true;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const local = yield* Effect.never.pipe(
						Effect.ensuring(
							Effect.sync(() => {
								localAlive = false;
							}),
						),
						Effect.forkScoped({ startImmediately: true }),
					);
					const network = yield* wake
						.restart(
							Effect.suspend(() => {
								attempts++;
								return attempts === 1
									? Effect.never.pipe(
											Effect.ensuring(
												Effect.sync(() => {
													cancelled++;
												}),
											),
										)
									: Effect.succeed("reconnected");
							}),
						)
						.pipe(Effect.forkScoped({ startImmediately: true }));
					yield* Effect.yieldNow;
					wake.observe(Date.now() + 60_000);
					expect(yield* Fiber.join(network)).toBe("reconnected");
					expect(attempts).toBe(2);
					expect(cancelled).toBe(1);
					expect(localAlive).toBe(true);
					yield* Fiber.interrupt(local);
				}),
			),
		);
	});
});

import { createServer, type ServerResponse } from "node:http";
