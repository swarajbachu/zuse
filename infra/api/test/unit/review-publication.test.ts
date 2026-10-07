import type { ReviewFinding, ReviewResult } from "@zuse/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ReviewRunRecord } from "../../src/review-domain.ts";
import { reviewMarker } from "../../src/review-domain.ts";
import { screenReviewOutput } from "../../src/review-output-screen.ts";
import {
	publishReviewPublication,
	type ReviewGithubRequest,
	type ReviewPublicationDependencies,
	reviewPlainText,
} from "../../src/review-publication.ts";
import type { ReviewPublication } from "../../src/review-store.ts";

const finding: ReviewFinding = {
	id: "finding-1",
	severity: "high",
	title: "Null input throws",
	explanation: "The request fails.",
	trigger: "Null input",
	consequence: "Lost request",
	location: { path: "src/a.ts", side: "RIGHT", startLine: 2, endLine: 3 },
	evidence: [
		{
			path: "src/a.ts",
			side: "RIGHT",
			startLine: 2,
			endLine: 3,
			quote: "value.name",
		},
	],
};
const result: ReviewResult = {
	snapshot: {
		repositoryId: 1,
		baseRef: "main",
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
		mergeBaseSha: "a".repeat(40),
	},
	status: "completed",
	findings: [finding],
	coverage: {
		eligibleFiles: 1,
		reviewedFiles: 1,
		excludedFiles: 0,
		unreviewedPaths: [],
		contextLimited: false,
	},
};
const run: ReviewRunRecord = {
	id: "run-1",
	repositoryId: 1,
	repositoryFullName: "org/repo",
	pullNumber: 2,
	baseRef: "main",
	baseSha: result.snapshot.baseSha,
	headSha: result.snapshot.headSha,
	mergeBaseSha: result.snapshot.mergeBaseSha,
	enrollmentId: "enrollment-1",
	enrollmentVersion: 1,
	ownerId: "owner-1",
	modelConnectionId: "connection-1",
	agentProvider: "codex",
	model: "model-1",
	worker: { provider: "e2b", size: "small", maxRuntimeMs: 600000 },
	state: "publishing",
	createdAtMs: 0,
	updatedAtMs: 0,
	installationId: 3,
	authorGithubUserId: 4,
	fork: false,
	configVersion: "v1",
	generation: "automatic",
	blockedReason: null,
	result,
};
const summary: ReviewPublication = {
	id: "publication-1",
	runId: run.id,
	marker: reviewMarker(run.id, "publication-1"),
	payload: { kind: "summary", result },
	state: "reconcile",
	githubId: null,
	leaseToken: "lease-1",
	mayCreate: true,
};
const inline: ReviewPublication = {
	...summary,
	id: "publication-2",
	marker: reviewMarker(run.id, "publication-2"),
	payload: { kind: "finding", finding, snapshot: result.snapshot },
};
const pull = {
	state: "open",
	base: { ref: run.baseRef, sha: run.baseSha, repo: { id: 1 } },
	head: { sha: run.headSha, repo: { id: 1 } },
};
function dependencies(
	override: Partial<ReviewPublicationDependencies> = {},
): ReviewPublicationDependencies {
	return {
		appId: 5,
		botUserId: 6,
		assertCurrent: async () => true,
		screenOutput: async () => true,
		fixUrl: (runId, findingId) =>
			`https://zuse.sh/review/fix?runId=${runId}${findingId ? `&findingId=${findingId}` : ""}`,
		request: async ({ method, path }) =>
			method === "POST"
				? { id: 100 }
				: path.includes("check-runs?")
					? { check_runs: [] }
					: path.includes("comments?")
						? []
						: pull,
		...override,
	};
}

describe("trusted review publication", () => {
	it("creates one nonblocking commit-bound check and revalidates freshness", async () => {
		const base = dependencies();
		const request = vi.fn(base.request);
		const assertCurrent = vi.fn(base.assertCurrent);
		expect(
			await publishReviewPublication(summary, run, {
				...base,
				request,
				assertCurrent,
			}),
		).toEqual({ kind: "delivered", githubId: "100" });
		expect(
			request.mock.calls.filter(([request]) => request.method === "POST"),
		).toEqual([
			[
				expect.objectContaining({
					path: "/repos/org/repo/check-runs",
					body: expect.objectContaining({
						head_sha: run.headSha,
						external_id: summary.id,
						conclusion: "neutral",
					}),
				}),
			],
		]);
		expect(assertCurrent).toHaveBeenCalledTimes(3);
	});

	it("anchors a multiline inline comment to the reviewed commit", async () => {
		const base = dependencies();
		const request = vi.fn(base.request);
		await publishReviewPublication(inline, run, { ...base, request });
		const posted = request.mock.calls.find(
			([request]) => request.method === "POST",
		)?.[0];
		expect(posted?.body).toMatchObject({
			commit_id: run.headSha,
			path: "src/a.ts",
			start_line: 2,
			line: 3,
			side: "RIGHT",
			start_side: "RIGHT",
		});
		expect(posted?.body?.body).toContain("https://zuse.sh/review/fix?");
	});

	it("recovers a lost create response by external ID without another POST", async () => {
		let posted = false;
		const base = dependencies();
		const request = vi.fn(async (input: ReviewGithubRequest) => {
			if (input.method === "POST") {
				posted = true;
				throw new Error("response lost");
			}
			if (input.path.includes("check-runs?"))
				return {
					check_runs: posted
						? [
								{
									id: 200,
									name: "Zuse Review",
									app: { id: 5 },
									external_id: summary.id,
									head_sha: run.headSha,
								},
							]
						: [],
				};
			return base.request(input);
		});
		expect(
			await publishReviewPublication(summary, run, { ...base, request }),
		).toEqual({ kind: "delivered", githubId: "200" });
		expect(
			request.mock.calls.filter(([request]) => request.method === "POST"),
		).toHaveLength(1);
	});

	it("never blindly recreates an ambiguous absent publication", async () => {
		const base = dependencies();
		const request = vi.fn(base.request);
		expect(
			await publishReviewPublication({ ...summary, mayCreate: false }, run, {
				...base,
				request,
			}),
		).toEqual({ kind: "ambiguous" });
		expect(
			request.mock.calls.every(([request]) => request.method === "GET"),
		).toBe(true);
	});

	it("reconciles inline markers only from the configured bot", async () => {
		const base = dependencies();
		const request = vi.fn(async (input: ReviewGithubRequest) =>
			input.path.includes("comments?")
				? [
						{
							id: 90,
							user: { id: 999 },
							commit_id: run.headSha,
							body: inline.marker,
						},
						{
							id: 91,
							user: { id: 6 },
							commit_id: run.headSha,
							body: `text\n${inline.marker}`,
						},
					]
				: base.request(input),
		);
		expect(
			await publishReviewPublication({ ...inline, mayCreate: false }, run, {
				...base,
				request,
			}),
		).toEqual({ kind: "delivered", githubId: "91" });
		expect(
			request.mock.calls.every(([request]) => request.method === "GET"),
		).toBe(true);
	});

	it("does not publish when the head changed", async () => {
		const base = dependencies();
		const request = vi.fn(async () => ({
			...pull,
			head: { ...pull.head, sha: "c".repeat(40) },
		}));
		expect(
			await publishReviewPublication(summary, run, { ...base, request }),
		).toEqual({ kind: "stale" });
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("updates an existing finding thread across commits without creating a duplicate", async () => {
		const base = dependencies();
		const request = vi.fn(async (input: ReviewGithubRequest) => {
			if (input.method === "PATCH") return { id: 91 };
			if (input.path.includes("comments?"))
				return [
					{
						id: 91,
						user: { id: 6 },
						commit_id: "a".repeat(40),
						body: "previous review\n<!-- zuse-review-finding:finding-1 -->\n<!-- zuse-review:old:old -->",
					},
				];
			return base.request(input);
		});
		expect(
			await publishReviewPublication(inline, run, { ...base, request }),
		).toEqual({ kind: "delivered", githubId: "91" });
		expect(
			request.mock.calls.some(([request]) => request.method === "POST"),
		).toBe(false);
		const update = request.mock.calls.find(
			([request]) => request.method === "PATCH",
		)?.[0];
		expect(update?.path).toBe("/repos/org/repo/pulls/comments/91");
		expect(update?.body?.body).toContain(`Reviewed commit: ${run.headSha}`);
	});

	it("refuses a create when remote pagination cannot establish absence", async () => {
		const base = dependencies();
		const request = vi.fn(async (input: ReviewGithubRequest) =>
			input.path.includes("check-runs?")
				? {
						check_runs: Array.from({ length: 100 }, () => ({
							id: 1,
							external_id: "other",
						})),
					}
				: base.request(input),
		);
		expect(
			await publishReviewPublication(summary, run, { ...base, request }),
		).toEqual({ kind: "ambiguous" });
		expect(
			request.mock.calls.filter(([request]) =>
				request.path.includes("check-runs?"),
			),
		).toHaveLength(20);
		expect(
			request.mock.calls.some(([request]) => request.method === "POST"),
		).toBe(false);
	});

	it("returns the remote ID when superseded immediately after a write", async () => {
		const base = dependencies();
		let checks = 0;
		expect(
			await publishReviewPublication(summary, run, {
				...base,
				assertCurrent: async () => ++checks < 3,
			}),
		).toEqual({ kind: "stale", githubId: "100" });
	});

	it("rejects modified evidence, unsupported batch members and secret-screen failures", async () => {
		const base = dependencies();
		const request = vi.fn(base.request);
		expect(
			await publishReviewPublication(
				{
					...inline,
					payload: {
						kind: "finding",
						snapshot: result.snapshot,
						finding: { ...finding, explanation: "forged" },
					},
				},
				run,
				{ ...base, request },
			),
		).toEqual({ kind: "rejected" });
		expect(
			await publishReviewPublication(inline, run, {
				...base,
				request,
				screenOutput: async () => false,
			}),
		).toEqual({ kind: "rejected" });
		expect(request).not.toHaveBeenCalled();
	});

	it("retries a pre-write read outage without losing creation permission", async () => {
		const base = dependencies();
		const request = vi.fn(async () => {
			throw Error("GitHub GET unavailable");
		});
		expect(
			await publishReviewPublication(summary, run, { ...base, request }),
		).toEqual({ kind: "unwritten" });
		expect(
			await publishReviewPublication({ ...summary, mayCreate: false }, run, {
				...base,
				request,
			}),
		).toEqual({ kind: "ambiguous" });
	});
	it("supports an approved exact-head fork while requiring the trusted authorization guard", async () => {
		const base = dependencies();
		const forkRun = { ...run, fork: true };
		const request = vi.fn(async (input: ReviewGithubRequest) =>
			input.path.endsWith("/pulls/2")
				? { ...pull, head: { ...pull.head, repo: { id: 99 } } }
				: base.request(input),
		);
		expect(
			await publishReviewPublication(summary, forkRun, { ...base, request }),
		).toEqual({ kind: "delivered", githubId: "100" });
		expect(
			await publishReviewPublication(summary, forkRun, {
				...base,
				request,
				assertCurrent: async () => false,
			}),
		).toEqual({ kind: "stale" });
	});
	it("includes findings beyond the five-inline-comment limit in the bounded check summary", async () => {
		const base = dependencies();
		const findings = Array.from({ length: 8 }, (_, index) => ({
			...finding,
			id: `finding-${index}`,
			title: `Bug ${index}`,
		}));
		const nextResult = { ...result, findings };
		const request = vi.fn(base.request);
		expect(
			await publishReviewPublication(
				{ ...summary, payload: { kind: "summary", result: nextResult } },
				{ ...run, result: nextResult },
				{ ...base, request },
			),
		).toEqual({ kind: "delivered", githubId: "100" });
		expect(
			JSON.stringify(
				request.mock.calls.find(([input]) => input.method === "POST")?.[0].body,
			),
		).toContain("Bug 7");
	});

	it("screens raw finding content before Markdown escaping disguises a secret", async () => {
		const secret = `ghp_${"a".repeat(30)}`;
		const unsafeFinding = {
			...finding,
			explanation: `Accidentally exposed ${secret}`,
		};
		const unsafeResult = { ...result, findings: [unsafeFinding] };
		const request = vi.fn(dependencies().request);
		expect(
			await publishReviewPublication(
				{
					...inline,
					payload: {
						kind: "finding",
						finding: unsafeFinding,
						snapshot: result.snapshot,
					},
				},
				{ ...run, result: unsafeResult },
				dependencies({
					request,
					screenOutput: async (text) => screenReviewOutput(text),
				}),
			),
		).toEqual({ kind: "rejected" });
		expect(request).not.toHaveBeenCalled();
	});

	it("renders model strings as bounded text without mentions or executable markup", () => {
		const rendered = reviewPlainText(
			"@everyone <script>x</script> [go](javascript:alert(1))\n<!-- zuse-review:fake -->",
			200,
		);
		expect(rendered).not.toContain("@everyone");
		expect(rendered).not.toContain("<script>");
		expect(rendered).not.toContain("[go](");
		expect(rendered).not.toContain("<!--");
		expect(reviewPlainText("x".repeat(1000), 10)).toHaveLength(10);
	});
});
