import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGenericAcpSession } from "@zuse/agents/drivers/generic-acp";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import type { ProviderDriverEvent } from "@zuse/agents/kernel/driver";
import { AgentSessionId, FolderId } from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

const fixture = fileURLToPath(
	new URL(
		"../../../../../tests/testkit/fixtures/fake-acp-provider.mjs",
		import.meta.url,
	),
);
const attachments = Layer.succeed(AttachmentService, {
	upload: () => Effect.die("unused"),
	saveText: () => Effect.die("unused"),
	read: () => Effect.succeed(null),
	readPath: () => Effect.succeed(null),
	readForSession: () => Effect.succeed(null),
});
const start = (
	cwd: string,
	scenario: string,
	cursor: string | null = null,
	mcpEnabled = true,
) =>
	startGenericAcpSession(
		{ providerId: "acp-test", folderId: FolderId.make("test"), mode: "sdk" },
		cwd,
		{
			command: process.execPath,
			args: [fixture],
			mcpEnabled,
			env: {
				ZUSE_FAKE_ACP_SCENARIO: scenario,
				ZUSE_FAKE_ACP_HTTP: "1",
				ZUSE_FAKE_ACP_STATE_DIR: join(cwd, "state"),
			},
		},
		AgentSessionId.make("test-session"),
		async () => ({ _tag: "AllowOnce" }),
		() => "approval-required",
		async () => ({ id: "unused", ok: false, error: "unused" }),
		"bun",
		null,
		cursor,
	);
const waitFor = async (condition: () => boolean, timeoutMs = 2_000) => {
	for (let i = 0; i < timeoutMs / 10; i++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for ACP events");
};
describe("generic ACP session", () => {
	it("starts and resumes bridges that reject per-session MCP without launching a fallback", async () => {
		const root = await mkdtemp(join(tmpdir(), "generic-acp-"));
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* start(root, "no-mcp", null, false);
						yield* Effect.addFinalizer(() => handle.close());
						const cursor = yield* Stream.runHead(
							handle.events.pipe(
								Stream.filter((event) => event._tag === "SessionCursor"),
							),
						);
						if (cursor._tag !== "Some") throw new Error("No cursor");
						yield* handle.close();
						const resumed = yield* start(
							root,
							"no-mcp",
							cursor.value.cursor,
							false,
						);
						yield* resumed.close();
					}),
				).pipe(Effect.provide(attachments)),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("streams tools and persists a cursor that resumes the same session", async () => {
		const root = await mkdtemp(join(tmpdir(), "generic-acp-"));
		const events: ProviderDriverEvent[] = [];
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* start(root, "tool-calls");
						yield* Effect.addFinalizer(() => handle.close());
						yield* Stream.runForEach(handle.events, (event) =>
							Effect.sync(() => {
								events.push(event);
							}),
						).pipe(Effect.forkScoped);
						yield* handle.send("Edit a file");
						yield* Effect.promise(() =>
							waitFor(() =>
								events.some((event) => event._tag === "ToolResult"),
							),
						);
						const cursor = events.find(
							(event) => event._tag === "SessionCursor",
						);
						expect(cursor?._tag).toBe("SessionCursor");
						expect(
							events.find((event) => event._tag === "ToolUse"),
						).toMatchObject({ tool: "Edit" });
						yield* handle.close();
						if (cursor?._tag !== "SessionCursor") throw new Error("No cursor");
						const resumed = yield* start(root, "tool-calls", cursor.cursor);
						yield* resumed.close();
					}),
				).pipe(Effect.provide(attachments)),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("rejects unsupported resume without replacing history", async () => {
		const root = await mkdtemp(join(tmpdir(), "generic-acp-"));
		try {
			await expect(
				Effect.runPromise(
					start(root, "no-resume", "existing").pipe(
						Effect.provide(attachments),
					),
				),
			).rejects.toMatchObject({
				reason: expect.stringContaining("cannot resume"),
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

it("reports a process crash and ends the event stream", async () => {
	const root = await mkdtemp(join(tmpdir(), "generic-acp-"));
	try {
		const events = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* start(root, "crash");
					yield* Effect.addFinalizer(() => handle.close());
					yield* handle.send("crash");
					return yield* Stream.runCollect(handle.events);
				}),
			).pipe(Effect.provide(attachments)),
		);
		expect(events).toContainEqual({ _tag: "Status", status: "error" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it("cancels an active prompt and returns to idle", async () => {
	const root = await mkdtemp(join(tmpdir(), "generic-acp-"));
	const events: ProviderDriverEvent[] = [];
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* start(root, "hold");
					yield* Effect.addFinalizer(() => handle.close());
					yield* Stream.runForEach(handle.events, (event) =>
						Effect.sync(() => {
							events.push(event);
						}),
					).pipe(Effect.forkScoped);
					yield* handle.send("hold");
					yield* Effect.promise(() =>
						waitFor(() => events.some((e) => e._tag === "AssistantMessage")),
					);
					yield* handle.interrupt();
					yield* Effect.promise(() =>
						waitFor(
							() =>
								events.filter((e) => e._tag === "Status" && e.status === "idle")
									.length === 1,
						),
					);
				}),
			).pipe(Effect.provide(attachments)),
		);
		expect(events).toContainEqual({ _tag: "Interrupted" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it("reports an error when the agent ignores an interrupt", async () => {
	const root = await mkdtemp(join(tmpdir(), "generic-acp-"));
	const events: ProviderDriverEvent[] = [];
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* start(root, "ignore-cancel");
					yield* Effect.addFinalizer(() => handle.close());
					yield* Stream.runForEach(handle.events, (event) =>
						Effect.sync(() => {
							events.push(event);
						}),
					).pipe(Effect.forkScoped);
					yield* handle.send("hold");
					yield* Effect.promise(() =>
						waitFor(() => events.some((e) => e._tag === "AssistantMessage")),
					);
					yield* handle.interrupt();
					yield* Effect.promise(() =>
						waitFor(
							() =>
								events.some((e) => e._tag === "Status" && e.status === "error"),
							10_000,
						),
					);
				}),
			).pipe(Effect.provide(attachments)),
		);
		expect(events).toContainEqual({ _tag: "Interrupted" });
		expect(events.some((e) => e._tag === "Status" && e.status === "idle")).toBe(
			false,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);
it("surfaces failed resume without creating a replacement session", async () => {
	const root = await mkdtemp(join(tmpdir(), "generic-acp-"));
	try {
		await expect(
			Effect.runPromise(
				start(root, "tool-calls", "missing-session").pipe(
					Effect.provide(attachments),
				),
			),
		).rejects.toMatchObject({
			reason: expect.stringContaining("Unknown persisted session"),
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
