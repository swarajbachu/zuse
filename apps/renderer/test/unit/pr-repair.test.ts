import {
	EnvironmentId,
	GitPrComment,
	GitPrDetails,
	GitPrReview,
	SessionId,
} from "@zuse/contracts";
import { expect, test } from "vitest";
import {
	prRepairComposerTarget,
	prRepairDraft,
	prRepairFeedback,
} from "../../src/lib/pr-repair.ts";

const comment = (body: string) =>
	GitPrComment.make({
		author: "reviewer",
		body,
		createdAt: new Date(),
	});
const details = GitPrDetails.make({
	state: "open",
	number: 1,
	url: null,
	isDraft: false,
	checks: "success",
	mergeable: "clean",
	additions: 0,
	deletions: 0,
	title: "Fix",
	body: "Description",
	author: "author",
	baseBranch: "main",
	headBranch: "fix",
	comments: [
		comment("Current feedback"),
		{ ...comment("Resolved feedback"), isResolved: true },
		{ ...comment("Outdated feedback"), isOutdated: true },
	],
	reviews: [
		GitPrReview.make({
			author: "reviewer",
			body: "Inactive summary",
			state: "commented",
			submittedAt: null,
			hasActiveThreads: false,
		}),
		GitPrReview.make({
			author: "reviewer",
			body: "Current summary",
			state: "commented",
			submittedAt: null,
			hasActiveThreads: true,
		}),
		GitPrReview.make({
			author: "reviewer",
			body: "Dismissed review",
			state: "dismissed",
			submittedAt: null,
		}),
	],
	files: [],
	checkRuns: [],
});

test.each([
	"comments",
	"everything",
] as const)("%s repair excludes inactive feedback", (scope) => {
	const draft = prRepairDraft(details, scope);
	expect(draft).toContain("Current feedback");
	expect(draft).not.toContain("Resolved feedback");
	expect(draft).not.toContain("Outdated feedback");
	expect(draft).not.toContain("Dismissed review");
	expect(draft).not.toContain("Inactive summary");
	expect(draft).toContain("Current summary");
});

test("repair count uses the same current feedback as the draft", () => {
	expect(prRepairFeedback(details).map((item) => item.body)).toEqual([
		"Current feedback",
		"Current summary",
	]);
	expect(
		prRepairFeedback({ comments: details.comments.slice(1), reviews: [] }),
	).toHaveLength(0);
});

test("cloud repair targets the workspace execution environment", () => {
	const sessionId = SessionId.make("session-1");
	expect(
		prRepairComposerTarget(
			{ environmentId: EnvironmentId.make("cloud-workspace-1") },
			sessionId,
			sessionId,
		),
	).toEqual({
		environmentId: EnvironmentId.make("cloud-workspace-1"),
		sessionId,
	});
});

test("repair refuses to attach after the selected chat changes", () => {
	expect(
		prRepairComposerTarget(
			{ environmentId: EnvironmentId.make("cloud-workspace-1") },
			SessionId.make("stale-session"),
			SessionId.make("selected-session"),
		),
	).toBeNull();
});
