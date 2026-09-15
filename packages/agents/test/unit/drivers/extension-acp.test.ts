import { fileURLToPath } from "node:url";
import { AgentEvent } from "@zuse/contracts";
import type { ExtensionProviderSessionInput } from "@zuse/extension-sdk";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionAcpProvider } from "../../../src/drivers/extension-acp.ts";

const fixture = fileURLToPath(
	new URL("../../fixtures/extension-acp.mjs", import.meta.url),
);
const sessions: ReturnType<typeof createExtensionAcpProvider>[] = [];
const input: ExtensionProviderSessionInput = {
	sessionId: "s1",
	projectId: "p1",
	cwd: process.cwd(),
	model: null,
	resumeCursor: null,
	forkFromResume: false,
	permissionMode: "default",
	modelOptions: {},
};
const make = (scenario = "normal") => {
	const events: AgentEvent[] = [];
	const registration = createExtensionAcpProvider(
		{
			id: "test.agent",
			displayName: "Fixture",
			command: [process.execPath, fixture, scenario],
			startupTimeoutMs: 1000,
			modes: { default: "default", plan: "plan" },
		},
		(_id, event) => events.push(Schema.decodeUnknownSync(AgentEvent)(event)),
	);
	sessions.push(registration);
	return { ...registration, events };
};
const idle = (events: AgentEvent[]) => {
	const last = events.at(-1);
	return last?._tag === "Status" && last.status === "idle";
};
afterEach(async () => {
	await Promise.all(sessions.splice(0).map((s) => s.dispose()));
});
describe("generic ACP extension provider", () => {
	it("starts, translates streamed output, cancels and resumes using a native cursor", async () => {
		const { adapter, events } = make();
		expect((await adapter.probe()).available).toBe(true);
		await adapter.start(input);
		expect(events).toContainEqual({
			_tag: "SessionCursor",
			cursor: "native-session",
			strategy: "acp-session-id",
		});
		await adapter.send("s1", "world");
		await vi.waitFor(() => expect(idle(events)).toBe(true));
		expect(JSON.stringify(events)).toContain("Hello world");
		await adapter.send("s1", "wait");
		await expect(adapter.send("s1", "overlap")).rejects.toThrow("already");
		await adapter.interrupt("s1");
		expect(idle(events)).toBe(true);
		await adapter.close("s1");
		await adapter.start({ ...input, resumeCursor: "native-session" });
		await adapter.send("s1", "again");
		await vi.waitFor(() =>
			expect(JSON.stringify(events)).toContain("Hello again"),
		);
	});
	it("asks for an explicit one-time permission and rejects invalid answers", async () => {
		const { adapter, events } = make();
		await adapter.start(input);
		await adapter.send("s1", "permission");
		await vi.waitFor(() =>
			expect(events.some((e) => e._tag === "UserQuestion")).toBe(true),
		);
		const question = events.find((e) => e._tag === "UserQuestion");
		if (question?._tag !== "UserQuestion") throw Error("Missing question");
		expect(question.questions[0]?.options).toEqual(["Allow once", "Deny"]);
		expect(question.questions[0]?.question).toContain("echo fixture");
		await expect(
			adapter.answerQuestion?.("s1", question.itemId, [
				{ questionIndex: 0, selected: [99] },
			]),
		).rejects.toThrow("Choose");
		await adapter.answerQuestion?.("s1", question.itemId, [
			{ questionIndex: 0, selected: [0] },
		]);
		await vi.waitFor(() =>
			expect(JSON.stringify(events)).toContain("Approved"),
		);
	});
	it("denies permission requests in plan mode and does not pretend unsupported modes worked", async () => {
		const { adapter, events } = make();
		await adapter.start({ ...input, permissionMode: "plan" });
		await adapter.send("s1", "permission");
		await vi.waitFor(() => expect(JSON.stringify(events)).toContain("Denied"));
		expect(events.some((e) => e._tag === "UserQuestion")).toBe(false);
		await expect(
			adapter.setPermissionMode?.("s1", "acceptEdits"),
		).rejects.toThrow("does not declare");
	});
	it.each([
		"hang-init",
		"bad-init",
	])("cleans failed %s startup and permits an explicit retry", async (scenario) => {
		const { adapter } = make(scenario);
		await expect(adapter.start(input)).rejects.toThrow();
		await expect(adapter.start(input)).rejects.not.toThrow("already exists");
	});
	it("refuses unsupported resume and fork without starting a replacement conversation", async () => {
		const { adapter } = make("no-resume");
		await expect(
			adapter.start({ ...input, resumeCursor: "saved" }),
		).rejects.toThrow("cannot resume");
		await expect(
			adapter.start({ ...input, forkFromResume: true }),
		).rejects.toThrow("forking");
	});
	it.each([
		"exit",
		"overflow",
	])("fails %s visibly and allows a new generation of the same session", async (prompt) => {
		const { adapter, events } = make();
		await adapter.start(input);
		await adapter.send("s1", prompt);
		await vi.waitFor(() =>
			expect(
				events.some((e) => e._tag === "Status" && e.status === "error"),
			).toBe(true),
		);
		await adapter.start(input);
		await adapter.send("s1", "recovered");
		await vi.waitFor(() =>
			expect(JSON.stringify(events)).toContain("Hello recovered"),
		);
	});
	it("bounds cancellation of a non-cooperative process", async () => {
		const { adapter, events } = make("ignore-cancel");
		await adapter.start(input);
		await adapter.send("s1", "wait");
		await adapter.interrupt("s1");
		expect(
			events.some((e) => e._tag === "Status" && e.status === "error"),
		).toBe(true);
		await expect(adapter.send("s1", "later")).rejects.toThrow("unavailable");
	});
	it("revokes a disposed provider and reports missing commands without running them", async () => {
		const { adapter, dispose } = make();
		await dispose();
		await expect(adapter.start(input)).rejects.toThrow("disposed");
		const missing = createExtensionAcpProvider(
			{
				id: "missing.agent",
				displayName: "Missing",
				command: ["/zuse-no-such-agent"],
			},
			() => {},
		);
		expect((await missing.adapter.probe()).available).toBe(false);
		await missing.dispose();
	});
});
