import type {
	Chat,
	ChatId,
	FolderId,
	Message,
	ProviderId,
	Session,
	SessionId,
} from "@zuse/contracts";
import { Context, Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	type ConversationOrchestrationDependencies,
	makeConversationOrchestration,
} from "../../src/conversation/core/conversation-orchestration.ts";

const context = {
	sessionId: "s_caller" as SessionId,
	chatId: "c_caller" as ChatId,
	projectId: "project-a" as FolderId,
	worktreeId: null,
	providerId: "claude" as ProviderId,
	model: "model",
} as const;

const sessionFor = (projectId: string) =>
	({
		sessionId: "s_target",
		chatId: "c_target",
		projectId,
		status: "idle",
	}) as unknown as Session;

const makeDeps = (
	overrides: Partial<ConversationOrchestrationDependencies> = {},
): ConversationOrchestrationDependencies => ({
	runtime: Context.empty(),
	getSettings: () => Effect.fail(new Error("no settings")),
	getModelCatalog: () => Effect.fail(new Error("no catalog")),
	createWorktree: () => Effect.fail(new Error("not used")),
	createChat: () => Effect.fail(new Error("not used")),
	createSession: () => Effect.fail(new Error("not used")),
	getChat: () => Effect.fail(new Error("not used")),
	getSession: () => Effect.succeed(sessionFor("project-a")),
	sendToSession: () => Effect.void,
	listMessages: () => Effect.succeed([] as ReadonlyArray<Message>),
	listChats: () => Effect.succeed([] as ReadonlyArray<Chat>),
	listSessions: () => Effect.succeed([] as ReadonlyArray<Session>),
	...overrides,
});

describe("conversation orchestration project scoping", () => {
	it("rejects send_to_thread for a session in another project", async () => {
		const sent: string[] = [];
		const deps = makeDeps({
			getSession: () => Effect.succeed(sessionFor("project-b")),
			sendToSession: (sessionId) =>
				Effect.sync(() => {
					sent.push(sessionId as string);
				}),
		});
		const tools = await Effect.runPromise(
			makeConversationOrchestration(deps, context),
		);
		const result = await tools.deps.sendToThread({
			sessionId: "s_target",
			text: "hello",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("does not belong to this project");
		}
		expect(sent).toEqual([]);
	});

	it("allows send_to_thread for a session in the same project", async () => {
		const sent: string[] = [];
		const deps = makeDeps({
			sendToSession: (sessionId) =>
				Effect.sync(() => {
					sent.push(sessionId as string);
				}),
		});
		const tools = await Effect.runPromise(
			makeConversationOrchestration(deps, context),
		);
		const result = await tools.deps.sendToThread({
			sessionId: "s_target",
			text: "hello",
		});
		expect(result.ok).toBe(true);
		expect(sent).toEqual(["s_target"]);
	});

	it("rejects read_thread for a session in another project", async () => {
		const deps = makeDeps({
			getSession: () => Effect.succeed(sessionFor("project-b")),
			listMessages: () => Effect.fail(new Error("listMessages must not run")),
		});
		const tools = await Effect.runPromise(
			makeConversationOrchestration(deps, context),
		);
		const result = await tools.deps.readThread({ sessionId: "s_target" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("does not belong to this project");
		}
	});

	it("allows read_thread for a session in the same project", async () => {
		const tools = await Effect.runPromise(
			makeConversationOrchestration(makeDeps(), context),
		);
		const result = await tools.deps.readThread({ sessionId: "s_target" });
		expect(result.ok).toBe(true);
	});
});
