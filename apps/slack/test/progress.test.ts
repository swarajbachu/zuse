import { afterEach, describe, expect, it, vi } from "vitest";
import {
	finishProgress,
	readProgress,
	refreshStatus,
	startProgress,
	updateProgress,
} from "../src/progress.ts";
import { progressCard } from "../src/progress-card.ts";
import type { RunnerEnv } from "../src/runner.ts";
import { readSlackThread } from "../src/slack.ts";

const setup = () => {
	const state = new Map<string, string>();
	const env: RunnerEnv = {
		NAMESPACE: "test",
		SLACK_BOT_TOKEN: "bot-token",
		SLACK_USER_TOKEN: "user-token",
		ZUSE_WEBHOOK_SECRET: "webhook-secret",
		CLOUD: { request: vi.fn() },
		THREADS: {
			get: async (key) => state.get(key) ?? null,
			put: async (key, value) => {
				state.set(key, value);
			},
		},
		setStatus: vi.fn(async () => false),
		setReaction: vi.fn(async () => true),
	};
	return env;
};
const input = { key: "C1:1", channel: "C1", threadTs: "1" };
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("persistent task activity", () => {
	it("repairs a late activity edit after completion without touching the final answer", async () => {
		vi.useFakeTimers();
		const env = setup();
		const edits: Record<string, unknown>[] = [];
		let release: () => void = () => {};
		let entered: () => void = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const editing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let blockEdit = true;
		const posts: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				const body = JSON.parse(String(init.body));
				if (url.endsWith("chat.postMessage")) {
					posts.push(body);
					return Response.json({
						ok: true,
						ts: body.blocks ? "activity" : "answer",
					});
				}
				if (blockEdit) {
					blockEdit = false;
					entered();
					await pending;
				}
				edits.push(body);
				return Response.json({ ok: true });
			}),
		);
		await startProgress(env, input);
		vi.setSystemTime(Date.now() + 20 * 60_000);
		const refreshing = refreshStatus(
			env,
			input.key,
			"Waiting for the agent’s result",
			{ checkedAt: Date.now() },
		);
		await editing;
		await finishProgress(env, input.key, "Fixed the issue. Tests passed.");
		release();
		await refreshing;
		expect(posts).toHaveLength(2);
		expect(posts[1]?.text).toContain("Tests passed");
		expect(edits.every((body) => body.ts === "activity")).toBe(true);
		expect(edits.at(-1)?.text).toContain("Done");
		expect(edits.at(-1)?.text).not.toContain("Waiting for the agent");
		expect((await readProgress(env, input.key))?.completed).toBe(true);
	});

	it("retries activity independently when Slack initially rejects the card", async () => {
		vi.useFakeTimers();
		const env = setup();
		const posts: Record<string, unknown>[] = [];
		let failed = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				const body = JSON.parse(String(init.body));
				if (url.endsWith("chat.postMessage")) {
					posts.push(body);
					if (!failed) {
						failed = true;
						return Response.json(
							{ ok: false, error: "ratelimited" },
							{ status: 429, headers: { "retry-after": "1" } },
						);
					}
					return Response.json({
						ok: true,
						ts: body.blocks ? "activity" : "answer",
					});
				}
				return Response.json({ ok: true });
			}),
		);
		await expect(startProgress(env, input)).resolves.toMatchObject({
			key: input.key,
		});
		vi.setSystemTime(Date.now() + 1000);
		await refreshStatus(env, input.key, "Request queued in your workspace");
		await finishProgress(env, input.key, "Actual result");
		expect(posts.at(-1)?.text).toContain("Actual result");
		expect((await readProgress(env, input.key))?.completed).toBe(true);
	});

	it("coalesces rapid preparation edits and clears activity while waiting for setup", async () => {
		vi.useFakeTimers();
		const env = setup();
		const edits: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (url.endsWith("chat.update"))
					edits.push(JSON.parse(String(init.body)));
				return Response.json({ ok: true, ts: "activity" });
			}),
		);
		await startProgress(env, input);
		await updateProgress(env, input.key, "Reading thread context");
		await updateProgress(env, input.key, "Preparing the workspace");
		expect(edits).toHaveLength(0);
		await updateProgress(
			env,
			input.key,
			"Choose an agent in Configure request",
			{ waitingForUser: true },
		);
		expect(edits.at(-1)?.text).toContain("Needs your input");
		expect(env.setStatus).toHaveBeenLastCalledWith("C1", "1", "");
		expect(env.setReaction).toHaveBeenLastCalledWith(
			"C1",
			"1",
			"one_sec_cooking",
			false,
		);
		await updateProgress(env, input.key, "Preparing the workspace");
		expect(env.setReaction).toHaveBeenLastCalledWith(
			"C1",
			"1",
			"one_sec_cooking",
			true,
		);
	});
	it("retries terminal card cleanup without posting the answer twice", async () => {
		vi.useFakeTimers();
		const env = setup();
		const posts: Record<string, unknown>[] = [];
		let rejectCleanup = true;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				const body = JSON.parse(String(init.body));
				if (url.endsWith("chat.postMessage")) {
					posts.push(body);
					return Response.json({
						ok: true,
						ts: body.blocks ? "activity" : "answer",
					});
				}
				if (rejectCleanup) {
					rejectCleanup = false;
					return Response.json(
						{ ok: false, error: "ratelimited" },
						{ status: 429, headers: { "retry-after": "2" } },
					);
				}
				return Response.json({ ok: true });
			}),
		);
		await startProgress(env, input);
		await expect(
			finishProgress(env, input.key, "Actual result"),
		).rejects.toMatchObject({ name: "SlackRateLimitError" });
		expect((await readProgress(env, input.key))?.completed).toBe(true);
		vi.setSystemTime(Date.now() + 2000);
		await refreshStatus(env, input.key, "");
		expect(posts).toHaveLength(2);
		expect(posts[1]?.text).toContain("Actual result");
		expect(env.setStatus).toHaveBeenLastCalledWith("C1", "1", "");
	});
});

it("keeps user text literal and preserves the settled elapsed time", () => {
	vi.useFakeTimers();
	const now = Date.now();
	const progress = {
		...input,
		startedAt: now - 20 * 60_000,
		finishedAt: now,
		completed: true,
		phase: "completed",
		details: { task: "<!channel> <@U1> fix this" },
	};
	vi.setSystemTime(now + 24 * 60 * 60_000);
	const card = progressCard({}, progress);
	const task = card.blocks[1]?.text;
	expect(task).toEqual({
		type: "plain_text",
		text: "<!channel> <@U1> fix this",
		emoji: false,
	});
	expect(card.text).toContain("&lt;!channel&gt; &lt;@U1&gt;");
	expect(card.text).toContain("Elapsed: 20m");
});

it("marks bounded thread context and unavailable earlier file metadata explicitly", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				ok: true,
				messages: [
					{
						ts: "1",
						user: "U1",
						text: "x".repeat(61_000),
						files: [{ id: "unavailable" }],
					},
				],
			}),
		),
	);
	const messages = await readSlackThread({
		token: "bot-token",
		channel: "C1",
		threadTs: "1",
	});
	expect(messages[0]?.text).toHaveLength(60_000);
	expect(messages[0]?.contextLimited).toBe(true);
	expect(messages[0]?.files).toEqual([]);
});
