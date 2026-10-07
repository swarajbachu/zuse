import { expect, it } from "vitest";
import type { ReviewRunRecord } from "../../src/review-domain.ts";
import { publicReviewRun } from "../../src/review-routes.ts";

const run: ReviewRunRecord = {
	id: "run",
	repositoryId: 1,
	repositoryFullName: "org/repo",
	installationId: 2,
	pullNumber: 3,
	authorGithubUserId: 4,
	baseRef: "main",
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
	mergeBaseSha: "a".repeat(40),
	fork: false,
	enrollmentId: "enrollment",
	enrollmentVersion: 1,
	ownerId: "payer",
	modelConnectionId: "connection",
	agentProvider: "codex",
	model: "model",
	worker: { provider: "e2b", size: "small", maxRuntimeMs: 600000 },
	configVersion: "v1",
	generation: "automatic",
	state: "completed",
	blockedReason: null,
	createdAtMs: 1,
	updatedAtMs: 2,
	result: {
		snapshot: {
			repositoryId: 1,
			baseRef: "main",
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
			mergeBaseSha: "a".repeat(40),
		},
		status: "completed",
		findings: [],
		coverage: {
			eligibleFiles: 1,
			reviewedFiles: 1,
			excludedFiles: 0,
			unreviewedPaths: [],
			contextLimited: false,
		},
	},
};
it("history and mutation responses do not expose repository artifacts by default", () => {
	expect(publicReviewRun(run).result).toBeUndefined();
	expect(publicReviewRun(run)).not.toHaveProperty("authorGithubUserId");
	expect(publicReviewRun(run)).not.toHaveProperty("installationId");
	expect(publicReviewRun(run, true).result).toEqual(run.result);
});
