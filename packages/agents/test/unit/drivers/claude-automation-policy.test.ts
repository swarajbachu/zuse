import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { AgentSessionId, FolderId } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { startClaudeSession } from "../../../src/drivers/claude.ts";
import { AttachmentService } from "../../../src/kernel/attachment-service.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
	...(await original<typeof import("@anthropic-ai/claude-agent-sdk")>()),
	query: vi.fn(() => ({
		async *[Symbol.asyncIterator]() {},
		interrupt: async () => {},
	})),
}));
vi.mock("../../../src/kernel/provider-mcp-session.ts", () => ({
	issueProviderMcpSession: () =>
		Effect.succeed({
			endpoint: "http://localhost/mcp",
			token: "test-token",
			close: async () => {},
		}),
}));
const attachments = Layer.succeed(AttachmentService, {
	upload: () => Effect.die("unused"),
	saveText: () => Effect.die("unused"),
	read: () => Effect.succeed(null),
	readForSession: () => Effect.succeed(null),
	readPath: () => Effect.succeed(null),
});
const start = (names?: readonly string[]) =>
	startClaudeSession(
		{
			folderId: FolderId.make("p"),
			providerId: "claude",
			mode: "sdk",
			model: "claude-test",
			executionPolicy: {
				maxBudgetUsd: 2,
				...(names === undefined ? {} : { mcpServerNames: names }),
			},
		},
		"/tmp",
		null,
		null,
		AgentSessionId.make("s"),
		async () => ({ _tag: "Deny" as const }),
		() => "approval-required",
		null,
		async () => {
			throw new Error("Unused browser transport");
		},
		null,
	).pipe(Effect.provide(attachments));
describe("Claude automation execution policy", () => {
	it("passes the spending cap while preserving main's gateway-only MCP isolation", async () => {
		const handle = await Effect.runPromise(start());
		try {
			const call = vi.mocked(query).mock.calls.at(-1)?.[0];
			const options: Options | undefined = call?.options;
			expect(options?.maxBudgetUsd).toBe(2);
			expect(options?.strictMcpConfig).toBe(true);
			expect(Object.keys(options?.mcpServers ?? {})).toEqual(["zuse"]);
			expect(options?.mcpServers).not.toHaveProperty("other");
		} finally {
			await Effect.runPromise(handle.close());
		}
	});
	it("fails before spawning a provider if obsolete native MCP selection is configured", async () => {
		vi.mocked(query).mockClear();
		await expect(Effect.runPromise(start(["missing"]))).rejects.toMatchObject({
			_tag: "AgentSessionStartError",
			reason: expect.stringContaining("unavailable"),
		});
		expect(query).not.toHaveBeenCalled();
	});
});
