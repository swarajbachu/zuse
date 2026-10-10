import {
	bundledResolvedModelCatalog,
	ChatId,
	FolderId,
	Message,
	MessageContent,
	MessageId,
	SessionId,
} from "@zuse/contracts";
import { Context, Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	messageContentToText,
	roleForContent,
	transcriptToMarkdown,
} from "../../src/conversation/core/conversation-message-mapping.ts";
import {
	type ConversationOrchestrationDependencies,
	makeConversationOrchestration,
} from "../../src/conversation/core/conversation-orchestration.ts";

const sessionId = SessionId.make("ui-session");
const spec =
	'root = Card([Stat("Tests", "428"), Progress("Build", 100)], "Health")';
const unused = () => Effect.die("Unexpected dependency call");
const setup = async (fail = false) => {
	const saved: Message[] = [];
	const persistMessage = vi.fn<
		ConversationOrchestrationDependencies["persistMessage"]
	>((id, content) => {
		if (fail) return Effect.fail({ reason: "Storage unavailable" });
		const message = Message.make({
			id: MessageId.make(`ui-${saved.length}`),
			sessionId: id,
			role: roleForContent(content),
			content,
			createdAt: new Date(0),
		});
		saved.push(message);
		return Effect.succeed({ message, sequence: saved.length });
	});
	const tools = await Effect.runPromise(
		makeConversationOrchestration(
			{
				runtime: Context.empty(),
				getSettings: () => Effect.fail("unavailable"),
				getModelCatalog: () => Effect.succeed(bundledResolvedModelCatalog()),
				createWorktree: unused,
				createChat: unused,
				createSession: unused,
				getChat: unused,
				getSession: unused,
				sendToSession: unused,
				listMessages: () => Effect.succeed(saved),
				listChats: unused,
				listSessions: unused,
				persistMessage,
			},
			{
				sessionId,
				chatId: ChatId.make("ui-chat"),
				projectId: FolderId.make("ui-project"),
				worktreeId: null,
				providerId: "codex",
				model: "model",
			},
		),
	);
	return { tools, saved, persistMessage };
};

describe("emit_ui persistence", () => {
	it("persists versioned assistant content that survives JSON replay and exports", async () => {
		const { tools, saved, persistMessage } = await setup();
		expect(await tools.deps.emitUi({ spec })).toEqual({
			ok: true,
			messageId: "ui-0",
		});
		expect(persistMessage).toHaveBeenCalledExactlyOnceWith(sessionId, {
			_tag: "ui_spec",
			spec,
			version: 1,
		});
		const message = saved[0];
		expect(message?.role).toBe("assistant");
		const replayed = Schema.decodeUnknownSync(MessageContent)(
			JSON.parse(JSON.stringify(message?.content)),
		);
		expect(replayed).toEqual({ _tag: "ui_spec", spec, version: 1 });
		expect(messageContentToText(replayed)).toBe(spec);
		expect(transcriptToMarkdown("Health", saved)).toContain(spec);
	});
	it("rejects bad specs without creating a timeline row", async () => {
		const { tools, persistMessage } = await setup();
		expect(
			await tools.deps.emitUi({ spec: 'root = Progress("Build", 1000)' }),
		).toMatchObject({ ok: false });
		expect(persistMessage).not.toHaveBeenCalled();
	});
	it("reports persistence failure without claiming a rendered block exists", async () => {
		const { tools, saved } = await setup(true);
		expect(await tools.deps.emitUi({ spec })).toEqual({
			ok: false,
			error: "Storage unavailable",
		});
		expect(saved).toEqual([]);
	});
	it("keeps model-provided code fences inside the exported source block", async () => {
		const { tools, saved } = await setup();
		const source = 'root = Text("```danger```")';
		await tools.deps.emitUi({ spec: source });
		expect(transcriptToMarkdown("Fences", saved)).toContain(
			`\n\`\`\`\`openui\n${source}\n\`\`\`\`\n`,
		);
	});
});
