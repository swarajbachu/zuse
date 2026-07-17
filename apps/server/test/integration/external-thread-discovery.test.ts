import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExternalThread } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	claudeTranscriptMessages,
	dedupeExternalThreads,
	discoverClaudeThreads,
} from "../../src/external-thread/layers/external-thread-service.ts";

describe("external thread discovery", () => {
	it("keeps only the newest row for each external thread id", () => {
		const makeThread = (id: string, updatedAt: string) =>
			ExternalThread.make({
				id,
				providerId: "codex",
				title: id,
				preview: id,
				projectPath: "/tmp/project",
				projectName: "project",
				updatedAt: new Date(updatedAt),
				sourcePath: null,
				cursor: id,
				resumeStrategy: "codex-thread-id",
				available: true,
			});
		const duplicateId = "codex:thread-1";

		const threads = dedupeExternalThreads([
			makeThread(duplicateId, "2026-07-02T00:00:00.000Z"),
			makeThread(duplicateId, "2026-07-01T00:00:00.000Z"),
			makeThread("codex:thread-2", "2026-06-30T00:00:00.000Z"),
		]);

		expect(threads.map((thread) => thread.id)).toEqual([
			duplicateId,
			"codex:thread-2",
		]);
		expect(threads[0]?.updatedAt).toEqual(new Date("2026-07-02T00:00:00.000Z"));
	});

	it("discovers Claude JSONL threads with title, project path, cursor, and recency", () => {
		const root = mkdtempSync(path.join(tmpdir(), "zuse-claude-threads-"));
		try {
			const firstDir = path.join(root, "-Users-whizzy-projects-alpha");
			const secondDir = path.join(root, "-Users-whizzy-projects-beta");
			mkdirSync(firstDir, { recursive: true });
			mkdirSync(secondDir, { recursive: true });

			writeFileSync(
				path.join(firstDir, "session-a.jsonl"),
				[
					JSON.stringify({
						type: "queue-operation",
						timestamp: "2026-07-01T10:00:00.000Z",
						sessionId: "session-a",
						content:
							"<system_instruction>You are working inside Zuse. Your work should take place in the /tmp/alpha directory.</system_instruction>",
					}),
					JSON.stringify({
						type: "ai-title",
						aiTitle: "Fix alpha flow",
						sessionId: "session-a",
					}),
					JSON.stringify({
						type: "user",
						timestamp: "2026-07-01T10:10:00.000Z",
						sessionId: "session-a",
						content: "Please fix the alpha flow",
					}),
				].join("\n"),
			);
			writeFileSync(
				path.join(secondDir, "session-b.jsonl"),
				[
					JSON.stringify({
						type: "queue-operation",
						timestamp: "2026-07-02T10:00:00.000Z",
						sessionId: "session-b",
						content:
							"<system_instruction>You are working inside Zuse. Your work should take place in the /tmp/beta directory.</system_instruction>",
					}),
					JSON.stringify({
						type: "user",
						timestamp: "2026-07-02T10:10:00.000Z",
						sessionId: "session-b",
						content: "Please inspect beta",
					}),
				].join("\n"),
			);

			const threads = discoverClaudeThreads(root);

			expect(threads.map((thread) => thread.cursor)).toEqual([
				"session-a",
				"session-b",
			]);
			expect(threads[0]).toMatchObject({
				providerId: "claude",
				title: "Fix alpha flow",
				preview: "Please fix the alpha flow",
				projectPath: "/tmp/alpha",
				resumeStrategy: "claude-session-id",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("extracts Claude title and preview from nested message rows instead of metadata rows", () => {
		const root = mkdtempSync(path.join(tmpdir(), "zuse-claude-threads-"));
		try {
			const projectDir = path.join(root, "-Users-whizzy-projects-nested");
			mkdirSync(projectDir, { recursive: true });

			writeFileSync(
				path.join(projectDir, "session-nested.jsonl"),
				[
					JSON.stringify({
						type: "queue-operation",
						timestamp: "2026-07-02T10:00:00.000Z",
						sessionId: "session-nested",
						content:
							"<system_instruction>You are working inside Zuse. Your work should take place in the /tmp/wrong directory.</system_instruction>",
					}),
					JSON.stringify({
						type: "user",
						timestamp: "2026-07-02T10:10:00.000Z",
						cwd: "/tmp/nested-worktree",
						sessionId: "session-nested",
						message: {
							role: "user",
							content: "Continue the nested Claude thread",
						},
					}),
					JSON.stringify({
						type: "user",
						timestamp: "2026-07-02T10:10:30.000Z",
						cwd: "/tmp/nested-worktree",
						sessionId: "session-nested",
						message: {
							role: "user",
							content:
								"<task-notification><task-id>abc</task-id><status>completed</status><summary>Agent finished</summary><result>done</result></task-notification>",
						},
					}),
					JSON.stringify({
						type: "assistant",
						timestamp: "2026-07-02T10:11:00.000Z",
						sessionId: "session-nested",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "I can continue it." }],
						},
					}),
				].join("\n"),
			);

			const threads = discoverClaudeThreads(root);

			expect(threads).toHaveLength(1);
			expect(threads[0]).toMatchObject({
				cursor: "session-nested",
				title: "Continue the nested Claude thread",
				preview: "Continue the nested Claude thread",
				projectPath: "/tmp/nested-worktree",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("imports Claude JSONL tool calls as structured transcript rows", () => {
		const root = mkdtempSync(path.join(tmpdir(), "zuse-claude-threads-"));
		try {
			const sourcePath = path.join(root, "structured.jsonl");
			writeFileSync(
				sourcePath,
				[
					JSON.stringify({
						type: "user",
						timestamp: "2026-07-02T10:10:00.000Z",
						sessionId: "session-structured",
						message: {
							role: "user",
							content: "Patch the button label",
						},
					}),
					JSON.stringify({
						type: "assistant",
						timestamp: "2026-07-02T10:11:00.000Z",
						sessionId: "session-structured",
						message: {
							role: "assistant",
							content: [
								{ type: "text", text: "I will update the component." },
								{
									type: "tool_use",
									id: "toolu_edit_1",
									name: "Edit",
									input: {
										file_path: "apps/renderer/src/button.tsx",
										old_string: "Save",
										new_string: "Create",
									},
								},
							],
						},
					}),
					JSON.stringify({
						type: "user",
						timestamp: "2026-07-02T10:11:30.000Z",
						sessionId: "session-structured",
						message: {
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: "toolu_edit_1",
									content: "Updated apps/renderer/src/button.tsx",
									is_error: false,
								},
							],
						},
					}),
				].join("\n"),
			);

			const messages = claudeTranscriptMessages(sourcePath);

			expect(messages.map((message) => message._tag)).toEqual([
				"user",
				"assistant",
				"tool_use",
				"tool_result",
			]);
			expect(messages[2]).toMatchObject({
				_tag: "tool_use",
				itemId: "toolu_edit_1",
				tool: "Edit",
				input: {
					file_path: "apps/renderer/src/button.tsx",
					old_string: "Save",
					new_string: "Create",
				},
			});
			expect(messages[3]).toMatchObject({
				_tag: "tool_result",
				itemId: "toolu_edit_1",
				output: "Updated apps/renderer/src/button.tsx",
				isError: false,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
