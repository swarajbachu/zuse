import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExternalThread } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	claudeTranscriptMessages,
	codexRolloutTranscriptMessages,
	dedupeExternalThreads,
	discoverClaudeThreads,
	discoverCodexFromIndex,
} from "../../src/external-thread/layers/external-thread-service.ts";

describe("external thread discovery", () => {
	it("recovers Codex project paths from rollout metadata when index fallback is used", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "zuse-codex-threads-"));
		try {
			const indexFile = path.join(root, "session_index.jsonl");
			const sessionsRoot = path.join(root, "sessions");
			const threadId = "019fc0e8-8cc6-7c82-b809-cd841076e930";
			const rolloutDir = path.join(sessionsRoot, "2026", "08", "02");
			const rolloutFile = path.join(
				rolloutDir,
				`rollout-2026-08-02T05-18-20-${threadId}.jsonl`,
			);
			mkdirSync(rolloutDir, { recursive: true });
			writeFileSync(
				indexFile,
				JSON.stringify({
					id: threadId,
					thread_name: "Fix analytics tracking",
					updated_at: "2026-08-02T05:18:20.245857Z",
				}),
			);
			writeFileSync(
				rolloutFile,
				`${JSON.stringify({
					type: "session_meta",
					payload: {
						id: threadId,
						cwd: "/Users/dev/Developer/forkzero",
					},
				})}\n`,
			);

			const threads = await discoverCodexFromIndex(indexFile, [sessionsRoot]);

			expect(threads).toHaveLength(1);
			expect(threads[0]).toMatchObject({
				cursor: threadId,
				projectPath: "/Users/dev/Developer/forkzero",
				sourcePath: rolloutFile,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("recovers archived Codex project paths from rollout metadata", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "zuse-codex-threads-"));
		try {
			const indexFile = path.join(root, "session_index.jsonl");
			const activeRoot = path.join(root, "sessions");
			const archivedRoot = path.join(root, "archived_sessions");
			const threadId = "019fbe50-fc6e-7531-bc9b-0320ced73ac4";
			const rolloutFile = path.join(
				archivedRoot,
				`rollout-2026-08-01T22-43-26-${threadId}.jsonl`,
			);
			mkdirSync(archivedRoot, { recursive: true });
			writeFileSync(
				indexFile,
				JSON.stringify({
					id: threadId,
					thread_name: "Fix remote sync",
					updated_at: "2026-08-01T17:13:34.727629Z",
				}),
			);
			writeFileSync(
				rolloutFile,
				`${JSON.stringify({
					type: "session_meta",
					payload: { id: threadId, cwd: "/Users/dev/Developer/forkzero" },
				})}\n`,
			);

			const threads = await discoverCodexFromIndex(indexFile, [
				activeRoot,
				archivedRoot,
			]);

			expect(threads[0]).toMatchObject({
				projectPath: "/Users/dev/Developer/forkzero",
				sourcePath: rolloutFile,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads a large session metadata row without matching unrelated cwd text", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "zuse-codex-threads-"));
		try {
			const indexFile = path.join(root, "session_index.jsonl");
			const sessionsRoot = path.join(root, "sessions");
			const threadId = "019fc0e8-8cc6-7c82-b809-cd841076e931";
			const rolloutFile = path.join(sessionsRoot, `${threadId}.jsonl`);
			mkdirSync(sessionsRoot, { recursive: true });
			writeFileSync(
				indexFile,
				JSON.stringify({ id: threadId, thread_name: "Large metadata" }),
			);
			writeFileSync(
				rolloutFile,
				`${JSON.stringify({
					type: "session_meta",
					payload: {
						id: threadId,
						metadata: `embedded \\"cwd\\":"/wrong" ${"x".repeat(20_000)}`,
						cwd: "/Users/dev/Developer/correct",
					},
				})}\n`,
			);

			const threads = await discoverCodexFromIndex(indexFile, [sessionsRoot]);

			expect(threads[0]?.projectPath).toBe("/Users/dev/Developer/correct");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("deduplicates index rows before applying the discovery limit", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "zuse-codex-threads-"));
		try {
			const indexFile = path.join(root, "session_index.jsonl");
			writeFileSync(
				indexFile,
				[
					{ id: "thread-a", thread_name: "Old A", updated_at: "2026-08-01" },
					{ id: "thread-b", thread_name: "Thread B", updated_at: "2026-08-02" },
					{ id: "thread-a", thread_name: "New A", updated_at: "2026-08-03" },
				]
					.map((row) => JSON.stringify(row))
					.join("\n"),
			);

			const threads = await discoverCodexFromIndex(indexFile, [], 2);

			expect(threads.map((thread) => thread.title)).toEqual([
				"New A",
				"Thread B",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns immediately when the discovery limit is zero", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "zuse-codex-threads-"));
		try {
			const indexFile = path.join(root, "session_index.jsonl");
			writeFileSync(
				indexFile,
				JSON.stringify({
					id: "thread-a",
					thread_name: "Thread A",
					updated_at: "2026-08-03",
				}),
			);

			expect(await discoverCodexFromIndex(indexFile, [root], 0)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("imports user and assistant messages from a Codex rollout fallback", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "zuse-codex-rollout-"));
		try {
			const rolloutFile = path.join(root, "rollout.jsonl");
			writeFileSync(
				rolloutFile,
				[
					JSON.stringify({
						type: "response_item",
						payload: {
							type: "message",
							role: "developer",
							content: [{ type: "input_text", text: "Internal setup" }],
						},
					}),
					JSON.stringify({
						type: "response_item",
						payload: {
							type: "message",
							role: "user",
							content: [
								{ type: "input_text", text: "<recommended_plugins>hidden" },
								{
									type: "input_text",
									text: "# AGENTS.md instructions\nhidden",
								},
								{ type: "input_text", text: "<environment_context>hidden" },
								{ type: "input_text", text: "<app-context>hidden" },
								{ type: "input_text", text: "<system_instruction>hidden" },
								{ type: "input_text", text: "<task-notification>hidden" },
								{ type: "input_text", text: "Fix the project list" },
							],
						},
					}),
					JSON.stringify({
						type: "response_item",
						payload: {
							type: "message",
							role: "assistant",
							content: [
								{ type: "output_text", text: "I found the split profile." },
							],
						},
					}),
				].join("\n"),
			);

			expect(await codexRolloutTranscriptMessages(rolloutFile)).toEqual([
				{ _tag: "user", text: "Fix the project list", goal: false },
				{ _tag: "assistant", text: "I found the split profile." },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

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
