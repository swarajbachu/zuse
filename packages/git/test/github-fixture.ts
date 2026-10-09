import type { GitHubPr } from "../src/github-pull-requests.ts";
export const check = {
	__typename: "CheckRun",
	name: "build",
	status: "COMPLETED",
	conclusion: "SUCCESS",
	detailsUrl: "https://github.com/acme/app/actions/runs/1",
};
export const pr = (overrides: Partial<GitHubPr> = {}): GitHubPr => ({
	id: "PR_1",
	number: 1,
	state: "OPEN",
	url: "https://github.com/acme/app/pull/1",
	additions: 1,
	deletions: 0,
	headRefName: "feature",
	headRefOid: "sha1",
	baseRefName: "main",
	baseRefOid: "base",
	isDraft: false,
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
	isMergeQueueEnabled: false,
	autoMergeRequest: null,
	viewerCanDeleteHeadRef: true,
	headRepository: {
		nameWithOwner: "acme/app",
		url: "https://github.com/acme/app",
		defaultBranchRef: { name: "main" },
	},
	headRepositoryOwner: { login: "acme" },
	isCrossRepository: false,
	title: "Example",
	body: "Description",
	updatedAt: "2026-01-01T00:00:00Z",
	author: {
		login: "user",
		avatarUrl: "https://avatars.githubusercontent.com/u/1",
	},
	comments: {
		nodes: [],
		totalCount: 0,
		pageInfo: { hasNextPage: false, endCursor: null },
	},
	reviews: {
		nodes: [],
		totalCount: 0,
		pageInfo: { hasNextPage: false, endCursor: null },
	},
	reviewThreads: { totalCount: 0 },
	commits: {
		nodes: [
			{
				commit: {
					oid: "sha1",
					statusCheckRollup: {
						contexts: {
							nodes: [check],
							checkRunCountsByState: [{ state: "COMPLETED", count: 1 }],
							statusContextCountsByState: [],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			},
		],
	},
	statusCheckRollup: [check],
	statusRevision: "",
	remarksRevision: "",
	observedAt: 0,
	checksComplete: true,
	...overrides,
});
