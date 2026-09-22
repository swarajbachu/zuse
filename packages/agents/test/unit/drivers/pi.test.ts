import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentItemId, AgentSessionId, FolderId } from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startPiSession } from "../../../src/drivers/pi.ts";
import { loadPiInventory } from "../../../src/drivers/pi-inventory.ts";
import { PiRpcClient } from "../../../src/drivers/pi-rpc.ts";
import { AttachmentService } from "../../../src/kernel/attachment-service.ts";
import type { ProviderDriverEvent } from "../../../src/kernel/driver.ts";

const binary = fileURLToPath(
	new URL("../../fixtures/fake-pi.mjs", import.meta.url),
);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const directory = async () => {
	const cwd = await mkdtemp(join(tmpdir(), "zuse-pi-test-"));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
};
const waitFor = async (condition: () => boolean) => {
	for (let i = 0; i < 200; i++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for Pi events");
};
const start = async (
	cwd: string,
	resume: string | null = null,
	model = "auto",
) => {
	vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
	const sessionId = AgentSessionId.make("pi-test");
	const handle = await Effect.runPromise(
		startPiSession(
			{
				folderId: FolderId.make("project"),
				providerId: "pi",
				mode: "sdk",
				model,
			},
			cwd,
			binary,
			sessionId,
			resume,
		).pipe(
			Effect.provideService(AttachmentService, {
				upload: () => Effect.die("unused"),
				saveText: () => Effect.die("unused"),
				read: (id) =>
					Effect.succeed(
						id === "image"
							? { bytes: new Uint8Array([1, 2]), mimeType: "image/png" }
							: id === "pdf"
								? { bytes: new Uint8Array([3]), mimeType: "application/pdf" }
								: null,
					),
				readPath: () => Effect.succeed(null),
				readForSession: () => Effect.succeed(null),
			}),
		),
	);
	const events: ProviderDriverEvent[] = [];
	const fiber = Effect.runFork(
		Stream.runForEach(handle.events, (event) =>
			Effect.sync(() => {
				events.push(event);
			}),
		),
	);
	cleanups.push(async () => {
		await Effect.runPromise(handle.close());
		await Effect.runPromise(Fiber.join(fiber));
	});
	return { handle, events };
};

describe("Pi sessions", () => {
	it("streams fragmented Unicode, normalized tools and usage, settling only on agent_end", async () => {
		const { handle, events } = await start(await directory());
		await Effect.runPromise(handle.send("hello"));
		await waitFor(() => events.some((e) => e._tag === "Completed"));
		expect(events.filter((e) => e._tag === "Completed")).toHaveLength(1);
		expect(events).toContainEqual(
			expect.objectContaining({
				_tag: "AssistantMessage",
				text: "hello\u2028world\u2029:test/model",
				checkpoint: expect.objectContaining({ final: true }),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				_tag: "ToolUse",
				tool: "Edit",
				input: expect.objectContaining({
					file_path: "a.txt",
					old_string: "a",
					new_string: "b",
				}),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({ _tag: "ToolResult", isError: true }),
		);
		expect(events).toContainEqual(
			expect.objectContaining({ _tag: "UsageDelta", inputTokens: 5 }),
		);
	});
	it("stops an accepted turn, clears queues and can send again", async () => {
		const cwd = await directory();
		const { handle, events } = await start(cwd);
		await Effect.runPromise(handle.send("wait"));
		expect(events.some((e) => e._tag === "Completed")).toBe(false);
		await Effect.runPromise(handle.interrupt());
		await waitFor(() => events.some((e) => e._tag === "Interrupted"));
		await Effect.runPromise(handle.send("hello"));
		await waitFor(() => events.some((e) => e._tag === "Completed"));
		const commands = (await readFile(join(cwd, "commands.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).type);
		expect(commands.indexOf("clear_queue")).toBeLessThan(
			commands.indexOf("abort"),
		);
		expect(events.filter((e) => e._tag === "Interrupted")).toHaveLength(1);
	});
	it("resumes the exact native file and applies a selected model", async () => {
		const cwd = await directory();
		const first = await start(cwd);
		await waitFor(() => first.events.some((e) => e._tag === "SessionCursor"));
		const cursor = first.events.find((e) => e._tag === "SessionCursor");
		if (cursor?._tag !== "SessionCursor") throw new Error("No cursor");
		await Effect.runPromise(first.handle.close());
		const second = await start(cwd, cursor.cursor, "other/new-model");
		await Effect.runPromise(second.handle.send("hello"));
		await waitFor(() => second.events.some((e) => e._tag === "Completed"));
		expect(second.events).toContainEqual(
			expect.objectContaining({
				_tag: "AssistantMessage",
				text: "hello\u2028world\u2029:other/new-model",
			}),
		);
	});
	it("rejects missing or corrupt resume files", async () => {
		const cwd = await directory();
		const path = join(cwd, "bad.jsonl");
		await expect(start(cwd, path)).rejects.toMatchObject({
			reason: expect.stringContaining("Cannot resume Pi"),
		});
		await writeFile(path, "bad");
		await expect(start(cwd, path)).rejects.toMatchObject({
			reason: expect.stringContaining("Cannot resume Pi"),
		});
	});
	it.each([
		"confirm",
		"select",
		"input",
		"editor",
	])("bridges %s dialogs without automatic approval", async (method) => {
		const { handle, events } = await start(await directory());
		await Effect.runPromise(handle.send(`dialog:${method}`));
		await waitFor(() => events.some((e) => e._tag === "UserQuestion"));
		expect(events.some((e) => e._tag === "Completed")).toBe(false);
		await Effect.runPromise(
			handle.answerQuestion(AgentItemId.make("question"), [
				{
					questionIndex: 0,
					selected: method === "confirm" || method === "select" ? [1] : [],
					other: "edited text",
				},
			]),
		);
		await waitFor(() => events.some((e) => e._tag === "Completed"));
		const answer = events.find((e) => e._tag === "AssistantMessage");
		expect(answer?._tag === "AssistantMessage" && answer.text).toContain(
			method === "confirm"
				? '"confirmed":false'
				: method === "select"
					? '"value":"second"'
					: '"value":"edited text"',
		);
	});
	it("sends images and reports unavailable or unsupported uploads", async () => {
		const { handle, events } = await start(await directory());
		await Effect.runPromise(
			handle.send("image", [
				{ id: "image", mimeType: "image/png", originalName: "image.png" },
			]),
		);
		await waitFor(() => events.some((e) => e._tag === "Completed"));
		expect(events).toContainEqual(
			expect.objectContaining({ _tag: "AssistantMessage", text: "images:1" }),
		);
		for (const id of ["missing", "pdf"])
			await Effect.runPromise(
				handle.send("image", [
					{ id, mimeType: "application/pdf", originalName: "a.pdf" },
				]),
			);
		await waitFor(() => events.filter((e) => e._tag === "Error").length === 2);
	});
	it.each([
		"reject",
		"crash",
		"malformed",
	])("reports %s without a successful completion", async (text) => {
		const { handle, events } = await start(await directory());
		await Effect.runPromise(handle.send(text));
		await waitFor(() => events.some((e) => e._tag === "Error"));
		expect(events.some((e) => e._tag === "Completed")).toBe(false);
	});
	it("isolates concurrent conversations", async () => {
		const [a, b] = await Promise.all([
			start(await directory()),
			start(await directory(), null, "other/model"),
		]);
		await Promise.all([
			Effect.runPromise(a.handle.send("hello")),
			Effect.runPromise(b.handle.send("hello")),
		]);
		await waitFor(() =>
			[a, b].every((s) => s.events.some((e) => e._tag === "Completed")),
		);
		expect(a.events.find((e) => e._tag === "SessionCursor")).not.toEqual(
			b.events.find((e) => e._tag === "SessionCursor"),
		);
	});
});

describe("Pi RPC lifecycle", () => {
	it("rejects timed-out requests and allows a subsequent request", async () => {
		const rpc = new PiRpcClient(binary, [], await directory(), () => {});
		cleanups.push(() => rpc.close());
		await expect(rpc.request("hang", {}, 100)).rejects.toThrow("timed out");
		expect(await rpc.request("get_state")).toHaveProperty("sessionFile");
	});
	it("rejects pending requests on process exit", async () => {
		const rpc = new PiRpcClient(binary, [], await directory(), () => {});
		cleanups.push(() => rpc.close());
		await expect(rpc.request("exit")).rejects.toThrow("exited");
	});
});

it("discovers qualified models through a separate non-persistent process", async () => {
	const models = await Effect.runPromise(loadPiInventory(binary));
	expect(models).toEqual([
		{
			id: "test/model",
			label: "Test model",
			liveMeta: { contextWindowTokens: 1000 },
		},
	]);
});
it("can start a clean client after a failed spawn", async () => {
	const cwd = await directory();
	const failed = new PiRpcClient("/missing-zuse-test/pi", [], cwd, () => {});
	await expect(failed.request("get_state")).rejects.toThrow();
	await failed.close();
	const fresh = new PiRpcClient(binary, [], cwd, () => {});
	cleanups.push(() => fresh.close());
	expect(await fresh.request("get_state")).toHaveProperty("sessionFile");
});

it("closes timed-out questions before completing the turn", async () => {
	const { handle, events } = await start(await directory());
	await Effect.runPromise(handle.send("dialog:timeout"));
	await waitFor(() => events.some((e) => e._tag === "Completed"));
	expect(events).toContainEqual({
		_tag: "UserQuestionResolved",
		itemId: "question",
		resolution: "timed-out",
	});
	expect(
		events.findIndex((e) => e._tag === "UserQuestionResolved"),
	).toBeLessThan(events.findIndex((e) => e._tag === "Completed"));
});
it("cancels outstanding dialogs when stopped", async () => {
	const { handle, events } = await start(await directory());
	await Effect.runPromise(handle.send("dialog:confirm"));
	await waitFor(() => events.some((e) => e._tag === "UserQuestion"));
	await Effect.runPromise(handle.interrupt());
	await waitFor(() => events.some((e) => e._tag === "UserQuestionResolved"));
	expect(events).toContainEqual({
		_tag: "UserQuestionResolved",
		itemId: "question",
		resolution: "cancelled",
	});
});
