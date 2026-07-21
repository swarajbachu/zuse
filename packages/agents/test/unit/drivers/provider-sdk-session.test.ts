import {
	AgentNotFoundError,
	type Run,
	type SDKAgent,
	type SDKMessage,
} from "@cursor/sdk";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import type {
	AgentEvent,
	AgentSessionId,
	AttachmentRef,
	FolderId,
	StartSessionInput,
} from "@zuse/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	create: vi.fn(),
	resume: vi.fn(),
}));

vi.mock("@cursor/sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cursor/sdk")>();
	return {
		...actual,
		Agent: { create: sdk.create, resume: sdk.resume },
	};
});

import { startCursorSession } from "../../../src/drivers/cursor.ts";

const AttachmentsTest = Layer.succeed(AttachmentService, {
	upload: () => Effect.die("not used"),
	saveText: () => Effect.die("not used"),
	read: () => Effect.succeed(null),
	readPath: () => Effect.succeed(null),
});

const ImageAttachmentsTest = Layer.succeed(AttachmentService, {
	upload: () => Effect.die("not used"),
	saveText: () => Effect.die("not used"),
	read: (id) =>
		Effect.succeed(
			id === "image-1"
				? { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }
				: null,
		),
	readPath: () => Effect.succeed(null),
});

const input: StartSessionInput = {
	folderId: "folder-1" as FolderId,
	providerId: "cursor",
	mode: "sdk",
	model: "composer-2",
	permissionMode: "default",
};

const sessionId = "session-1" as AgentSessionId;

const deferred = <T>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
};

const makeRun = (messages: SDKMessage[]): Run =>
	({
		id: "run-1",
		agentId: "agent-1",
		status: "finished",
		supports: () => true,
		unsupportedReason: () => undefined,
		async *stream() {
			for (const message of messages) yield message;
		},
		conversation: async () => [],
		wait: async () => ({ id: "run-1", status: "finished" }),
		cancel: vi.fn().mockResolvedValue(undefined),
		onDidChangeStatus: () => () => undefined,
	}) satisfies Run;

const makeAgent = () => {
	const send = vi.fn(async () =>
		makeRun([
			{
				type: "assistant",
				agent_id: "agent-1",
				run_id: "run-1",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
				},
			},
		]),
	);
	return {
		agent: {
			agentId: "agent-1",
			model: { id: "composer-2" },
			send,
			close: vi.fn(),
			reload: vi.fn(),
			listArtifacts: vi.fn(),
			downloadArtifact: vi.fn(),
			[Symbol.asyncDispose]: vi.fn(),
		} as unknown as SDKAgent,
		send,
	};
};

describe("bundled provider SDK sessions", () => {
	beforeEach(() => {
		sdk.create.mockReset();
		sdk.resume.mockReset();
	});

	it("creates with the managed key and supports follow-up sends", async () => {
		const fake = makeAgent();
		sdk.create.mockResolvedValue(fake.agent);
		const events: AgentEvent[] = [];

		await Effect.runPromise(
			Effect.gen(function* () {
				const handle = yield* startCursorSession(
					input,
					"/tmp/workspace",
					"managed-key",
					sessionId,
					null,
					[
						{
							name: "workspace-tools",
							transport: "stdio",
							command: "node",
							args: ["server.mjs"],
						},
					],
				);
				const fiber = yield* Stream.runForEach(handle.events, (event) =>
					Effect.sync(() => events.push(event)),
				).pipe(Effect.forkChild);
				yield* handle.send("first");
				yield* Effect.sleep("20 millis");
				yield* handle.send("follow-up");
				yield* Effect.sleep("20 millis");
				yield* handle.close();
				yield* Fiber.join(fiber);
			}).pipe(Effect.provide(AttachmentsTest)),
		);

		expect(sdk.create).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "managed-key",
				local: expect.objectContaining({
					cwd: "/tmp/workspace",
					autoReview: true,
					sandboxOptions: { enabled: true },
				}),
			}),
		);
		expect(fake.send).toHaveBeenCalledTimes(2);
		expect(fake.send).toHaveBeenNthCalledWith(
			1,
			"first",
			expect.objectContaining({
				mode: "agent",
				mcpServers: {
					"workspace-tools": {
						type: "stdio",
						command: "node",
						args: ["server.mjs"],
					},
				},
			}),
		);
		expect(events.some((event) => event._tag === "SessionCursor")).toBe(true);
		expect(
			events.filter((event) => event._tag === "AssistantMessage"),
		).toHaveLength(2);
	});

	it("publishes assistant progress before the SDK run finishes", async () => {
		const fake = makeAgent();
		const firstChunkYielded = deferred<void>();
		const releaseCompletion = deferred<void>();
		const run = {
			...makeRun([]),
			async *stream() {
				yield {
					type: "assistant",
					agent_id: "agent-1",
					run_id: "run-1",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Working on it" }],
					},
				} satisfies SDKMessage;
				firstChunkYielded.resolve();
				await releaseCompletion.promise;
			},
		} satisfies Run;
		fake.send.mockResolvedValue(run);
		sdk.create.mockResolvedValue(fake.agent);
		const events: AgentEvent[] = [];

		await Effect.runPromise(
			Effect.gen(function* () {
				const handle = yield* startCursorSession(
					input,
					"/tmp/workspace",
					"managed-key",
					sessionId,
				);
				const fiber = yield* Stream.runForEach(handle.events, (event) =>
					Effect.sync(() => events.push(event)),
				).pipe(Effect.forkChild);
				yield* handle.send("make progress visible");
				yield* Effect.promise(() => firstChunkYielded.promise);
				yield* Effect.sleep("10 millis");

				expect(
					events.some(
						(event) =>
							event._tag === "AssistantMessage" &&
							event.text === "Working on it",
					),
				).toBe(true);

				releaseCompletion.resolve();
				yield* Effect.sleep("10 millis");
				yield* handle.close();
				yield* Fiber.join(fiber);
			}).pipe(Effect.provide(AttachmentsTest)),
		);
	});

	it("replaces a stale resumed agent and publishes the new cursor", async () => {
		const fake = makeAgent();
		sdk.resume.mockRejectedValue(new AgentNotFoundError("Agent not found"));
		sdk.create.mockResolvedValue(fake.agent);
		const events: AgentEvent[] = [];

		await Effect.runPromise(
			Effect.gen(function* () {
				const handle = yield* startCursorSession(
					input,
					"/tmp/workspace",
					"managed-key",
					sessionId,
					"stale-agent",
				);
				const fiber = yield* Stream.runForEach(handle.events, (event) =>
					Effect.sync(() => events.push(event)),
				).pipe(Effect.forkChild);
				yield* Effect.sleep("10 millis");
				yield* handle.close();
				yield* Fiber.join(fiber);
			}).pipe(Effect.provide(AttachmentsTest)),
		);

		expect(sdk.resume).toHaveBeenCalledWith("stale-agent", expect.any(Object));
		expect(sdk.create).toHaveBeenCalledOnce();
		expect(
			events.find((event) => event._tag === "SessionCursor"),
		).toMatchObject({ cursor: "agent-1" });
	});

	it("cancels a run that resolves after interruption", async () => {
		const fake = makeAgent();
		const run = makeRun([]);
		const cancel = vi.spyOn(run, "cancel");
		let resolveSend: ((value: Run) => void) | undefined;
		fake.send.mockImplementation(
			() => new Promise<Run>((resolve) => (resolveSend = resolve)),
		);
		sdk.create.mockResolvedValue(fake.agent);

		await Effect.runPromise(
			Effect.gen(function* () {
				const handle = yield* startCursorSession(
					input,
					"/tmp/workspace",
					"managed-key",
					sessionId,
				);
				yield* handle.send("start slowly");
				yield* Effect.sleep("5 millis");
				yield* handle.interrupt();
				resolveSend?.(run);
				yield* Effect.sleep("20 millis");
				yield* handle.close();
			}).pipe(Effect.provide(AttachmentsTest)),
		);

		expect(cancel).toHaveBeenCalledOnce();
	});

	it("passes image inputs, plan mode, and live MCP updates to new runs", async () => {
		const fake = makeAgent();
		sdk.create.mockResolvedValue(fake.agent);
		const image: AttachmentRef = {
			id: "image-1",
			mimeType: "image/png",
			originalName: "screen.png",
		};

		await Effect.runPromise(
			Effect.gen(function* () {
				const handle = yield* startCursorSession(
					input,
					"/tmp/workspace",
					"managed-key",
					sessionId,
				);
				yield* handle.setPermissionMode("plan");
				yield* handle.updateMcpServers([
					{
						name: "remote-tools",
						transport: "http",
						url: "https://mcp.example.test",
						headers: { Authorization: "Bearer stored-token" },
					},
				]);
				yield* handle.send("inspect this", [image]);
				yield* Effect.sleep("20 millis");
				yield* handle.close();
			}).pipe(Effect.provide(ImageAttachmentsTest)),
		);

		expect(fake.send).toHaveBeenCalledWith(
			{
				text: "inspect this",
				images: [{ data: "AQID", mimeType: "image/png" }],
			},
			expect.objectContaining({
				mode: "plan",
				mcpServers: {
					"remote-tools": {
						type: "http",
						url: "https://mcp.example.test",
						headers: { Authorization: "Bearer stored-token" },
					},
				},
			}),
		);
	});
});
