import type { ReviewFinding, ReviewSnapshot } from "@zuse/contracts";
import { describe, expect, it, vi } from "vitest";
import {
	createReviewTools,
	DEFAULT_REVIEW_LIMITS,
	type ReviewSource,
	reconcileFindings,
	runReview,
	type VerifierInput,
} from "../../src/index.ts";

const snapshot: ReviewSnapshot = {
	repositoryId: 1,
	baseRef: "main",
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
	mergeBaseSha: "a".repeat(40),
};
const finding: ReviewFinding = {
	id: "candidate",
	severity: "high",
	title: "Missing guard",
	explanation: "An empty value reaches the caller",
	trigger: "Empty input",
	consequence: "Caller throws",
	location: { path: "src/a.ts", side: "RIGHT", startLine: 1, endLine: 1 },
	evidence: [
		{
			path: "src/a.ts",
			side: "RIGHT",
			startLine: 1,
			endLine: 1,
			quote: "return input.value",
		},
	],
};
const source: ReviewSource = {
	snapshot,
	contextLimited: false,
	files: { LEFT: ["src/a.ts"], RIGHT: ["src/a.ts"] },
	changes: [
		{
			path: "src/a.ts",
			status: "modified",
			excluded: false,
			addedLines: [{ start: 1, end: 1 }],
			deletedLines: [{ start: 1, end: 1 }],
		},
	],
	readFile: async () => "return input.value\n",
};
const investigate = async () => ({
	findings: [finding],
	reviewedPaths: ["src/a.ts"],
});

describe("review engine", () => {
	it("verifies validated evidence with an independent input and stable identity", async () => {
		const verify = vi.fn(async (_input: VerifierInput) => "confirmed" as const);
		const result = await runReview({ snapshot, source, investigate, verify });
		expect(result.status).toBe("completed");
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.id).not.toBe("candidate");
		expect(Object.keys(verify.mock.calls[0]?.[0] ?? {})).not.toContain(
			"transcript",
		);
		expect(result.coverage.reviewedFiles).toBe(1);
	});
	it("rejects fabricated evidence and out-of-diff locations before verifier", async () => {
		const verify = vi.fn(async () => "confirmed" as const);
		const result = await runReview({
			snapshot,
			source,
			investigate: async () => ({
				findings: [
					{
						...finding,
						evidence: [{ ...finding.evidence[0], quote: "fabricated" }],
					},
					{
						...finding,
						location: { ...finding.location, startLine: 2, endLine: 2 },
					},
				],
				reviewedPaths: ["src/a.ts"],
			}),
			verify,
		});
		expect(result.findings).toHaveLength(0);
		expect(verify).not.toHaveBeenCalled();
	});
	it("reports missing eligible files as partial instead of clean", async () => {
		const result = await runReview({
			snapshot,
			source: {
				...source,
				changes: [
					...source.changes,
					{
						path: "src/b.ts",
						status: "added",
						excluded: false,
						addedLines: [{ start: 1, end: 1 }],
						deletedLines: [],
					},
				],
			},
			investigate,
			verify: async () => "confirmed",
			limits: { maxFiles: 1 },
		});
		expect(result.status).toBe("partial");
		expect(result.coverage.unreviewedPaths).toEqual(["src/b.ts"]);
	});
	it("times out an uncooperative provider and aborts the session", async () => {
		let signal: AbortSignal | undefined;
		const result = await runReview({
			snapshot,
			source,
			investigate: async (input) => {
				signal = input.signal;
				return new Promise(() => {});
			},
			verify: async () => "confirmed",
			limits: { timeoutMs: 10 },
		});
		expect(result.reason).toBe("deadline_exceeded");
		expect(signal?.aborted).toBe(true);
	});
	it("rejects snapshot substitution", async () => {
		await expect(
			runReview({
				snapshot,
				source: { ...source, snapshot: { ...snapshot, repositoryId: 2 } },
				investigate,
				verify: async () => "confirmed",
			}),
		).rejects.toThrow("snapshot mismatch");
	});
	it("fails malformed output with explicit incomplete status", async () => {
		const result = await runReview({
			snapshot,
			source,
			investigate: async () => "looks good",
			verify: async () => "confirmed",
		});
		expect(result.status).toBe("partial");
		expect(result.coverage.reviewedFiles).toBe(0);
	});
	it("never marks missing old findings resolved", () => {
		expect(reconcileFindings([finding], []).unverifiedPrevious).toEqual([
			finding,
		]);
	});
});

describe("trusted bounded tools", () => {
	it("rejects traversal, absolute paths and untracked secrets before reading", async () => {
		const readFile = vi.fn(source.readFile);
		const tools = createReviewTools(
			{ ...source, readFile },
			DEFAULT_REVIEW_LIMITS,
			new AbortController().signal,
			() => {},
		);
		for (const path of [
			"../secret",
			"/etc/passwd",
			"src/../secret",
			"src\\a.ts",
			".env",
		]) {
			await expect(tools.read({ ...finding.location, path })).rejects.toThrow();
		}
		expect(readFile).not.toHaveBeenCalled();
	});
	it("treats hostile searches as literal text and enforces calls", async () => {
		const limited = vi.fn();
		const tools = createReviewTools(
			source,
			{ ...DEFAULT_REVIEW_LIMITS, maxToolCalls: 1 },
			new AbortController().signal,
			limited,
		);
		expect(await tools.search("$(touch /tmp/oops)")).toEqual([]);
		await expect(tools.search("return")).rejects.toThrow("budget");
		expect(limited).toHaveBeenCalled();
	});
});
it("retains cancellation even when the snapshot has no eligible changes", async () => {
	const controller = new AbortController();
	controller.abort();
	const result = await runReview({
		snapshot,
		source: { ...source, changes: [] },
		investigate,
		verify: async () => "confirmed",
		signal: controller.signal,
	});
	expect(result.status).toBe("partial");
	expect(result.reason).toBe("cancelled");
});
it("verifies highest impact findings first before the candidate budget", async () => {
	const result = await runReview({
		snapshot,
		source,
		investigate: async () => ({
			reviewedPaths: ["src/a.ts"],
			findings: [
				{ ...finding, severity: "medium", trigger: "Less severe input" },
				{ ...finding, severity: "critical", trigger: "Critical input" },
			],
		}),
		verify: async () => "confirmed",
		limits: { maxCandidates: 1 },
	});
	expect(result.findings[0]?.severity).toBe("critical");
	expect(result.reason).toBe("candidate_limit");
});
