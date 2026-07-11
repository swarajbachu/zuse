import { describe, expect, it } from "vitest";
import {
	installFakeAppServerProvider,
	makeFakeSdkPeer,
	startFakeHttpProviderPeer,
} from "../../src/fake-provider-peers.ts";
import {
	makeHermeticEnvironment,
	makeTemporaryDirectory,
	spawnManaged,
} from "../../src/process.ts";

describe("focused provider peers", () => {
	it("controls SDK event delivery deterministically", async () => {
		const peer = makeFakeSdkPeer<string | undefined>();
		const iterator = peer.events[Symbol.asyncIterator]();
		peer.push("first");
		expect(await iterator.next()).toEqual({ done: false, value: "first" });
		peer.push(undefined);
		expect(await iterator.next()).toEqual({ done: false, value: undefined });
		peer.complete();
		expect((await iterator.next()).done).toBe(true);
		expect(() => peer.push("late")).toThrow(/completed/);
	});

	it("records real HTTP requests", async () => {
		const peer = await startFakeHttpProviderPeer({ reply: "ok" });
		try {
			expect(
				await fetch(`${peer.url}/turn`, {
					method: "POST",
					body: JSON.stringify({ prompt: "hello" }),
				}).then((response) => response.json()),
			).toEqual({ reply: "ok" });
			expect(peer.requests).toEqual([
				{
					method: "POST",
					path: "/turn",
					body: JSON.stringify({ prompt: "hello" }),
				},
			]);
		} finally {
			await peer.close();
		}
	});

	it("speaks the app-server JSON-line protocol in a child process", async () => {
		const temporary = makeTemporaryDirectory("zuse-app-server-peer-");
		try {
			const executable = installFakeAppServerProvider(temporary.path);
			const process = spawnManaged(executable, [], {
				cwd: temporary.path,
				env: makeHermeticEnvironment({
					PATH: `${temporary.path}/bin`,
				}),
			});
			process.child.stdin.write(
				`${JSON.stringify({ id: 1, method: "model/list" })}\n`,
			);
			const response = await process.waitForStdout(
				(line) => line.includes("deterministic-model"),
				"app-server model response",
			);
			expect(JSON.parse(response)).toMatchObject({ id: 1 });
			await process.stop();
		} finally {
			temporary.dispose();
		}
	});
});
