import { describe, expect, it } from "vitest";
import {
	installFakeAppServerProvider,
	keytarShimRequirePath,
	makeFakeSdkPeer,
	startFakeHttpProviderPeer,
} from "../../src/fake-provider-peers.ts";
import {
	makeBoundedTextBuffer,
	makeHermeticEnvironment,
	makeTemporaryDirectory,
	spawnManaged,
	waitForFile,
	withResourceScope,
} from "../../src/process.ts";

describe("focused provider peers", () => {
	it("bounds diagnostic output to the most recent bytes", () => {
		const buffer = makeBoundedTextBuffer(8);
		buffer.append("12345");
		buffer.append("67890");
		expect(buffer.read()).toBe("34567890");
	});

	it("releases acquired resources in reverse order when a later acquisition fails", async () => {
		const released: Array<string> = [];
		await expect(
			withResourceScope(async (resources) => {
				await resources.acquire(
					() => "first",
					(value) => {
						released.push(value);
					},
				);
				await resources.acquire(
					() => "second",
					(value) => {
						released.push(value);
					},
				);
				throw new Error("setup failed");
			}),
		).rejects.toThrow("setup failed");
		expect(released).toEqual(["second", "first"]);
	});

	it("cancels filesystem readiness watchers during cleanup", async () => {
		const temporary = makeTemporaryDirectory("zuse-file-wait-");
		try {
			const controller = new AbortController();
			const waiting = waitForFile(
				`${temporary.path}/never-created.sqlite`,
				10_000,
				controller.signal,
			);
			controller.abort();
			await expect(waiting).rejects.toThrow("Stopped waiting");
		} finally {
			temporary.dispose();
		}
	});

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
		await withResourceScope(async (resources) => {
			const temporary = await resources.acquire(
				() => makeTemporaryDirectory("zuse-app-server-peer-"),
				(value) => value.dispose(),
			);
			const executable = installFakeAppServerProvider(temporary.path);
			const process = await resources.acquire(
				() =>
					spawnManaged(executable, [], {
						cwd: temporary.path,
						env: makeHermeticEnvironment({
							PATH: `${temporary.path}/bin`,
						}),
					}),
				(value) => value.stop(),
			);
			process.child.stdin.write(
				`${JSON.stringify({ id: 1, method: "model/list" })}\n`,
			);
			const response = await process.waitForStdout(
				(line) => line.includes("deterministic-model"),
				"app-server model response",
			);
			expect(JSON.parse(response)).toMatchObject({ id: 1 });
		});
	});

	it("isolates OS credentials behind a test-owned process shim", async () => {
		await withResourceScope(async (resources) => {
			const temporary = await resources.acquire(
				() => makeTemporaryDirectory("zuse-keytar-shim-"),
				(value) => value.dispose(),
			);
			const child = await resources.acquire(
				() =>
					spawnManaged(
						process.execPath,
						[
							"-e",
							"require('keytar').getPassword('service', 'account').then(console.log)",
						],
						{
							cwd: temporary.path,
							env: makeHermeticEnvironment({
								NODE_OPTIONS: `--require=${keytarShimRequirePath}`,
								PATH: process.env.PATH,
							}),
						},
					),
				(value) => value.stop(),
			);
			expect(
				await child.waitForStdout(
					(line) => line === "null",
					"ephemeral keytar response",
				),
			).toBe("null");
		});
	});
});
