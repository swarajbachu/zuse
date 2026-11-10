import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "@muse-code/sdk";
import {
	type AgentEvent,
	AgentItemId,
	AgentSessionId,
	FolderId,
	type PermissionDecision,
	type RuntimeMode,
	type StartSessionInput,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { startMuseSession } from "../../../src/drivers/muse.ts";
import * as museClient from "../../../src/drivers/muse-client.ts";
import {
	loadMuseInventory,
	museEnvironment,
	museLaunch,
	openMuseHost,
} from "../../../src/drivers/muse-client.ts";
import { AttachmentService } from "../../../src/kernel/attachment-service.ts";

const binary = fileURLToPath(
	new URL("../../fixtures/fake-muse.mjs", import.meta.url),
);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const close of cleanups.splice(0).reverse()) await close();
});
const directory = async () => {
	const cwd = await mkdtemp(join(tmpdir(), "zuse-muse-"));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
};
const waitFor = async (condition: () => boolean) => {
	for (let i = 0; i < 300; i++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Muse event timeout");
};
const start = async (
	cwd: string,
	resume: string | null = null,
	extra: Partial<StartSessionInput> = {},
	runtime: RuntimeMode = "approval-required",
) => {
	const permission = vi.fn(
		async (): Promise<PermissionDecision> => ({ _tag: "AllowOnce" }),
	);
	const handle = await Effect.runPromise(
		startMuseSession(
			{
				folderId: FolderId.make("folder"),
				providerId: "muse",
				mode: "sdk",
				model: "muse-test",
				modelOptions: { reasoning: "max" },
				...extra,
			},
			cwd,
			binary,
			AgentSessionId.make("session"),
			permission,
			() => runtime,
			resume,
			{
				name: "zuse",
				url: "http://127.0.0.1:1/mcp",
				headers: { Authorization: "Bearer test" },
			},
		).pipe(
			Effect.provideService(AttachmentService, {
				upload: () => Effect.die("unused"),
				saveText: () => Effect.die("unused"),
				read: (id) =>
					Effect.succeed(
						id === "image"
							? { bytes: new Uint8Array([1, 2]), mimeType: "image/png" }
							: null,
					),
				readPath: () => Effect.succeed(null),
				readForSession: () => Effect.succeed(null),
			}),
		),
	);
	const events: AgentEvent[] = [];
	const fiber = Effect.runFork(
		Stream.runForEach(handle.events, (event) =>
			Effect.sync(() => {
				if (event._tag !== "QuestionCallbackReleased") events.push(event);
			}),
		),
	);
	cleanups.push(async () => {
		await Effect.runPromise(handle.close());
		await Effect.runPromise(Fiber.join(fiber));
	});
	return { handle, events, permission };
};
const commands = async (cwd: string) =>
	(await readFile(join(cwd, "commands.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));

it("discovers only unique Meta models without creating a session", async () => {
	const cwd = await directory();
	const models = await Effect.runPromise(loadMuseInventory(binary, cwd));
	expect(models).toEqual([
		{
			id: "muse-test",
			label: "Muse Test",
			isDefault: true,
			liveMeta: { reasoningEfforts: ["high", "max"] },
		},
	]);
	expect((await commands(cwd)).map((c) => c.method)).not.toContain(
		"session/start",
	);
});
it("streams cumulative Unicode checkpoints and completes exactly once", async () => {
	const cwd = await directory();
	const { handle, events } = await start(cwd);
	const sending = Effect.runPromise(handle.send("hello"));
	await waitFor(() =>
		events.some(
			(e) =>
				e._tag === "AssistantMessage" &&
				e.text === "Hello 🌍" &&
				!e.checkpoint?.final,
		),
	);
	await sending;
	await waitFor(() => events.some((e) => e._tag === "Completed"));
	expect(events.filter((e) => e._tag === "Completed")).toHaveLength(1);
	expect(events).toContainEqual(
		expect.objectContaining({
			_tag: "AssistantMessage",
			text: "Hello 🌍",
			checkpoint: expect.objectContaining({ final: true }),
		}),
	);
	const sent = (await commands(cwd)).find((c) => c.method === "turn/start");
	expect(sent.params.reasoningEffort).toBe("max");
	const opened = (await commands(cwd)).find(
		(c) => c.method === "session/start",
	);
	expect(opened.params.config.mcpServers.zuse.transport).toBe("streamableHttp");
	expect(opened.params.permissionProfile).toBe(":ask-me");
});
it("resumes the exact native session and refuses a missing session", async () => {
	const cwd = await directory();
	const { handle, events } = await start(cwd, "saved-session");
	await Effect.runPromise(handle.send("hello"));
	await waitFor(() => events.some((e) => e._tag === "SessionCursor"));
	expect(events).toContainEqual({
		_tag: "SessionCursor",
		cursor: "saved-session",
		strategy: "muse-session-id",
	});
	const calls = await commands(cwd);
	expect(
		calls.find((c) => c.method === "session/resume").params.sessionId,
	).toBe("saved-session");
	await expect(start(await directory(), "missing")).rejects.toMatchObject({
		providerId: "muse",
		reason: expect.stringContaining("Session not found"),
	});
});
it("routes native approvals through the permission broker and echoes the offered choice", async () => {
	const cwd = await directory();
	const { handle, permission } = await start(cwd);
	await Effect.runPromise(handle.send("approve"));
	expect(permission).toHaveBeenCalledWith(
		"session",
		{ _tag: "FileWrite", path: "safe.txt" },
		{ forcePrompt: true },
	);
	const decision = (await commands(cwd)).find(
		(c) => c.method === "approval/decide",
	);
	expect(decision.params.choiceId).toBe("yes");
	expect(decision.params.requirementId).toEqual({
		approvalId: "approval",
		sourceIndex: 0,
	});
});
it("answers a native question with its native question identity", async () => {
	const cwd = await directory();
	const { handle, events } = await start(cwd);
	const sending = Effect.runPromise(handle.send("question"));
	await waitFor(() => events.some((e) => e._tag === "UserQuestion"));
	await Effect.runPromise(
		handle.answerQuestion(AgentItemId.make("question"), [
			{ questionIndex: 0, selected: [1] },
		]),
	);
	await sending;
	expect(
		(await commands(cwd)).find((c) => c.method === "userInput/answer").params
			.answers,
	).toEqual([{ questionId: "q", selectedLabel: "Two" }]);
});
it("interrupts a turn and reports a crashed host without claiming success", async () => {
	const { handle, events } = await start(await directory());
	const sending = Effect.runPromise(handle.send("wait"));
	await new Promise((resolve) => setTimeout(resolve, 40));
	await Effect.runPromise(handle.interrupt());
	await sending;
	await waitFor(() => events.some((e) => e._tag === "Interrupted"));
	await Effect.runPromise(handle.send("crash"));
	await waitFor(() => events.some((e) => e._tag === "Error"));
	expect(events.some((e) => e._tag === "Completed")).toBe(false);
});
it("refuses a host that ignored the requested permission profile", async () => {
	vi.stubEnv("FAKE_MUSE_PROFILE", ":unrestricted");
	await expect(start(await directory())).rejects.toMatchObject({
		reason: expect.stringContaining("permission profile"),
	});
});
it("does not inherit an unrelated Meta API key", () => {
	vi.stubEnv("META_API_KEY", "inherited");
	expect(museEnvironment().META_API_KEY).toBeUndefined();
	expect(museEnvironment({ META_API_KEY: "explicit" }).META_API_KEY).toBe(
		"explicit",
	);
});

it("preserves image bytes in the protocol's image envelope", async () => {
	const cwd = await directory();
	const { handle } = await start(cwd);
	await Effect.runPromise(
		handle.send("image", [
			{ id: "image", originalName: "test.png", mimeType: "image/png" },
		]),
	);
	expect(
		(await commands(cwd)).find((c) => c.method === "turn/start").params.input,
	).toContainEqual({
		type: "image",
		base64Data: "AQI=",
		mediaType: "image/png",
	});
});
it("keeps protected writes interactive under full access and denies read-only writes", async () => {
	vi.stubEnv("FAKE_MUSE_SENSITIVE", "1");
	const first = await start(await directory(), null, {}, "full-access");
	await Effect.runPromise(first.handle.send("approve"));
	expect(first.permission).toHaveBeenCalledOnce();
	const cwd = await directory();
	const second = await start(
		cwd,
		null,
		{ toolPolicy: "read-only" },
		"full-access",
	);
	await Effect.runPromise(second.handle.send("approve"));
	expect(second.permission).not.toHaveBeenCalled();
	expect(
		(await commands(cwd)).find((c) => c.method === "approval/decide").params
			.choiceId,
	).toBe("no");
});
it("submits compaction through the native command and awaits its terminal", async () => {
	const cwd = await directory();
	const { handle, events } = await start(cwd);
	await Effect.runPromise(handle.send("/compact"));
	await waitFor(() => events.some((e) => e._tag === "Completed"));
	expect((await commands(cwd)).map((c) => c.method)).toContain(
		"session/compact",
	);
	expect((await commands(cwd)).map((c) => c.method)).not.toContain(
		"turn/start",
	);
});
it("refuses to silently omit app tools when the host lacks session MCP", async () => {
	vi.stubEnv("FAKE_MUSE_NO_MCP", "1");
	await expect(start(await directory())).rejects.toMatchObject({
		reason: expect.stringContaining("session MCP"),
	});
});
it("cancels a stalled handshake and releases its owned process", async () => {
	const cwd = await directory();
	const controller = new AbortController();
	const opening = openMuseHost(binary, cwd, {
		env: { FAKE_MUSE_HANG: "1" },
		signal: controller.signal,
	});
	await new Promise((resolve) => setTimeout(resolve, 100));
	controller.abort();
	await expect(opening).rejects.toThrow("cancelled");
	const pid = (await commands(cwd))[0].pid;
	expect(() => process.kill(pid, 0)).toThrow();
});
it("launches native Windows executables directly and wraps command shims", () => {
	expect(museLaunch("C:\\bin\\muse.exe", "win32")).toEqual({
		command: "C:\\bin\\muse.exe",
		args: [],
	});
	expect(
		museLaunch("C:\\Program Files\\muse.cmd", "win32", { ComSpec: "cmd.exe" }),
	).toEqual({
		command: "cmd.exe",
		args: ["/d", "/c", "@", "C:\\Program Files\\muse.cmd"],
	});
});

it("renders recovered final text before completing a turn after a delivery gap", async () => {
	const { handle, events } = await start(await directory());
	await Effect.runPromise(handle.send("gap"));
	await waitFor(() => events.some((e) => e._tag === "Completed"));
	const reply = events.findIndex(
		(e) =>
			e._tag === "AssistantMessage" &&
			e.text === "Recovered reply" &&
			e.checkpoint?.final,
	);
	expect(reply).toBeGreaterThanOrEqual(0);
	expect(reply).toBeLessThan(events.findIndex((e) => e._tag === "Completed"));
});

it("does not submit a turn when Stop arrives during workspace resolution", async () => {
	const cwd = await directory();
	const { handle, events } = await start(cwd);
	let release = () => {};
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const resolveRoot = vi
		.spyOn(museClient, "museWorkspaceRoot")
		.mockImplementationOnce(async () => {
			await barrier;
			return cwd;
		});
	const sending = Effect.runPromise(handle.send("hello"));
	try {
		await waitFor(() => resolveRoot.mock.calls.length === 1);
		await Effect.runPromise(handle.interrupt());
	} finally {
		release();
	}
	await sending;
	await waitFor(() =>
		events.some((e) => e._tag === "Interrupted" || e._tag === "Completed"),
	);
	expect(
		(await commands(cwd)).filter((c) => c.method === "turn/start"),
	).toEqual([]);
	expect(events.filter((e) => e._tag === "Interrupted")).toHaveLength(1);
	expect(events.some((e) => e._tag === "Completed" || e._tag === "Error")).toBe(
		false,
	);
});
it("carries Stop through turn creation and interrupts the returned turn ID", async () => {
	const cwd = await directory();
	const { handle, events } = await start(cwd);
	let release = () => {};
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const submit = Session.prototype.sendUserTurn;
	const creating = vi
		.spyOn(Session.prototype, "sendUserTurn")
		.mockImplementationOnce(async function (this: Session, options) {
			await barrier;
			return submit.call(this, options);
		});
	const sending = Effect.runPromise(handle.send("hello"));
	try {
		await waitFor(() => creating.mock.calls.length === 1);
		await Effect.runPromise(handle.interrupt());
	} finally {
		release();
	}
	await sending;
	await waitFor(() =>
		events.some((e) => e._tag === "Interrupted" || e._tag === "Completed"),
	);
	const calls = await commands(cwd);
	const started = calls.find((c) => c.method === "turn/start");
	expect(calls).toContainEqual(
		expect.objectContaining({
			method: "turn/interrupt",
			params: expect.objectContaining({ turnId: started.params.commandId }),
		}),
	);
	expect(events.filter((e) => e._tag === "Interrupted")).toHaveLength(1);
	expect(events.some((e) => e._tag === "Completed" || e._tag === "Error")).toBe(
		false,
	);
});
