import type { ReviewFinding, ReviewSnapshot } from "@zuse/contracts";
import type { ReviewSource } from "@zuse/review";
import { describe, expect, it, vi } from "vitest";
import {
	type ReviewAgentFactory,
	type ReviewAgentSession,
	type ReviewWorkerInput,
	runNativeReviewWorker,
	runReviewWithAdapter,
} from "../../src/review/worker.ts";

const snapshot: ReviewSnapshot = {
	repositoryId: 42,
	baseRef: "main",
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
	mergeBaseSha: "a".repeat(40),
};
const source: ReviewSource = {
	snapshot,
	changes: [
		{
			path: "a.ts",
			status: "modified",
			excluded: false,
			addedLines: [{ start: 1, end: 1 }],
			deletedLines: [],
		},
	],
	files: { LEFT: ["a.ts"], RIGHT: ["a.ts"] },
	contextLimited: false,
	readFile: async () => "unsafe()",
};
const input: ReviewWorkerInput = {
	binding: {
		runId: "run-1",
		connectionId: "connection-1",
		providerId: "codex",
		model: "test-model",
		snapshot,
	},
	source,
};
const finding: ReviewFinding = {
	id: "finding-1",
	severity: "high",
	title: "Unsafe call",
	explanation: "A null input throws.",
	trigger: "Null input",
	consequence: "Request fails",
	location: { path: "a.ts", side: "RIGHT", startLine: 1, endLine: 1 },
	evidence: [
		{
			path: "a.ts",
			side: "RIGHT",
			startLine: 1,
			endLine: 1,
			quote: "unsafe()",
		},
	],
};
function session(
	overrides: Partial<ReviewAgentSession> = {},
): ReviewAgentSession {
	return {
		investigate: async () => ({ findings: [], reviewedPaths: ["a.ts"] }),
		verify: async () => "confirmed",
		close: vi.fn(async () => {}),
		...overrides,
	};
}

describe("review worker lifecycle", () => {
	it("refuses native subscription execution", async () => {
		await expect(runNativeReviewWorker(input)).rejects.toMatchObject({
			name: "ReviewProviderUnavailableError",
			reasons: expect.arrayContaining(["native-tool-confinement-unverified"]),
		});
	});

	it("binds results to the run and gives verification a fresh session", async () => {
		const investigator = session({
			investigate: async () => ({
				findings: [finding],
				reviewedPaths: ["a.ts"],
			}),
		});
		const verify = vi.fn<ReviewAgentSession["verify"]>(async () => "confirmed");
		const verifier = session({ verify });
		const open: ReviewAgentFactory["open"] = vi.fn(async ({ role }) =>
			role === "investigator" ? investigator : verifier,
		);
		const artifact = await runReviewWithAdapter(input, { open });
		expect(artifact).toMatchObject({
			version: 1,
			runId: "run-1",
			result: {
				status: "completed",
				snapshot,
				findings: [{ ...finding, id: expect.any(String) }],
			},
		});
		expect(open).toHaveBeenCalledTimes(2);
		expect(verify.mock.calls[0]?.[0]).not.toHaveProperty("transcript");
		expect(investigator.close).toHaveBeenCalledTimes(1);
		expect(verifier.close).toHaveBeenCalledTimes(1);
	});

	it("rejects a mismatched snapshot before opening an agent", async () => {
		const open = vi.fn(async () => session());
		await expect(
			runReviewWithAdapter(
				{
					...input,
					source: {
						...source,
						snapshot: { ...snapshot, headSha: "c".repeat(40) },
					},
				},
				{ open },
			),
		).rejects.toThrow("snapshot mismatch");
		expect(open).not.toHaveBeenCalled();
	});

	it("rejects reused investigator context during verification", async () => {
		const agent = session({
			investigate: async () => ({
				findings: [finding],
				reviewedPaths: ["a.ts"],
			}),
		});
		const artifact = await runReviewWithAdapter(input, {
			open: async () => agent,
		});
		expect(artifact.result.status).toBe("partial");
		expect(artifact.result.findings).toEqual([]);
		expect(agent.close).toHaveBeenCalledTimes(1);
	});

	it("closes uncooperative inference when the deadline expires", async () => {
		const agent = session({ investigate: () => new Promise(() => {}) });
		const artifact = await runReviewWithAdapter(
			{ ...input, limits: { timeoutMs: 10 } },
			{ open: async () => agent },
		);
		expect(artifact.result).toMatchObject({
			status: "partial",
			reason: "deadline_exceeded",
		});
		expect(agent.close).toHaveBeenCalledTimes(1);
	});

	it("closes a session that opens after cancellation", async () => {
		const controller = new AbortController();
		const agent = session();
		const artifact = await runReviewWithAdapter(
			{ ...input, signal: controller.signal },
			{
				open: async () => {
					controller.abort();
					await new Promise((resolve) => setTimeout(resolve, 5));
					return agent;
				},
			},
		);
		expect(artifact.result.status).toBe("partial");
		expect(agent.close).toHaveBeenCalledTimes(1);
	});

	it("never returns a publishable artifact if shutdown cannot be confirmed", async () => {
		const agent = session({ close: () => new Promise(() => {}) });
		await expect(
			runReviewWithAdapter(
				{ ...input, limits: { timeoutMs: 10 } },
				{ open: async () => agent },
				10,
			),
		).rejects.toThrow("shutdown unconfirmed");
	});

	it("does not start work when already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		const open = vi.fn(async () => session());
		await expect(
			runReviewWithAdapter({ ...input, signal: controller.signal }, { open }),
		).rejects.toThrow();
		expect(open).not.toHaveBeenCalled();
	});
});
