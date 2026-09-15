import {
	ComposerInput,
	EnvironmentId,
	FolderId,
	GitPrDetails,
	SessionId,
} from "@zuse/contracts";
import { describe, expect, test, vi } from "vitest";
import { prFailureKey } from "../../src/lib/pr-watch-policy.ts";
import { runPrWatchRepair } from "../../src/lib/pr-watch-repair.ts";
import type { PrWatch } from "../../src/store/pr-watch.ts";

const details = GitPrDetails.make({
	state: "open",
	number: 1,
	url: "https://github.com/o/r/pull/1",
	isDraft: false,
	checks: "failure",
	mergeable: "clean",
	additions: 1,
	deletions: 0,
	title: "Feature",
	body: "",
	author: "author",
	baseBranch: "main",
	headBranch: "feature",
	headSha: "head1",
	comments: [],
	reviews: [],
	files: [],
	checkRuns: [
		{
			name: "test",
			status: "completed",
			conclusion: "failure",
			url: "https://github.com/o/r/actions/runs/1/job/2",
			runId: "1",
			jobId: "2",
		},
	],
});

describe("CI watcher failure identity", () => {
	test("ignores pending checks, drafts and closed PRs", () => {
		for (const patch of [
			{ isDraft: true },
			{ state: "closed" as const },
			{ checks: "pending" as const },
			{ checkRuns: [] },
			{
				checkRuns: [
					...details.checkRuns,
					{
						name: "build",
						status: "queued" as const,
						conclusion: null,
						url: null,
					},
				],
			},
		])
			expect(
				prFailureKey(GitPrDetails.make({ ...details, ...patch })),
			).toBeNull();
	});
	test("distinguishes new heads and reruns from repeated polls", () => {
		expect(prFailureKey(details)).toBe(
			prFailureKey(GitPrDetails.make({ ...details })),
		);
		expect(prFailureKey(details)).not.toBe(
			prFailureKey(GitPrDetails.make({ ...details, headSha: "head2" })),
		);
		expect(prFailureKey(details)).not.toBe(
			prFailureKey(
				GitPrDetails.make({
					...details,
					checkRuns: details.checkRuns.map((check) => ({
						...check,
						startedAt: new Date("2026-09-15T00:00:00Z"),
					})),
				}),
			),
		);
	});
});

const initialWatch: PrWatch = {
	id: "watch",
	ref: {
		environmentId: EnvironmentId.make("local"),
		folderId: FolderId.make("folder"),
		worktreeId: null,
		rootPath: "/repo",
	},
	sessionId: SessionId.make("session"),
	url: "https://github.com/o/r/pull/1",
	branch: "feature",
	enabled: true,
	handled: [],
	pending: null,
	maxRepairs: 3,
	error: null,
};
const input = new ComposerInput({
	text: "Fix CI",
	attachments: [],
	fileRefs: [],
	skillRefs: [],
});

describe("durable repair dispatch", () => {
	test("reuses the prepared message after an ambiguous delivery", async () => {
		let watch = initialWatch;
		const send = vi
			.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const prepare = vi.fn(async () => input);
		const options = {
			key: "failure1",
			current: () => watch,
			save: (next: PrWatch) => {
				watch = next;
			},
			prepare,
			canSend: () => true,
			send,
		};
		await expect(runPrWatchRepair({ ...options, watch })).rejects.toThrow(
			"could not be confirmed",
		);
		expect(watch.pending).not.toBeNull();
		expect(watch.handled).toEqual([]);
		await runPrWatchRepair({ ...options, watch });
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
		expect(watch.handled).toEqual(["failure1"]);
		expect(watch.pending).toBeNull();
	});
	test("does not dispatch if the watcher is stopped during log capture", async () => {
		let watch = initialWatch;
		const send = vi.fn();
		await runPrWatchRepair({
			watch,
			key: "failure",
			current: () => watch,
			save: (next) => {
				watch = next;
			},
			prepare: async () => {
				watch = { ...watch, enabled: false };
				return input;
			},
			canSend: () => true,
			send,
		});
		expect(send).not.toHaveBeenCalled();
	});
	test("does not overwrite a watcher resumed during preparation", async () => {
		let watch: PrWatch = { ...initialWatch, generation: "old" };
		const send = vi.fn();
		await runPrWatchRepair({
			watch,
			key: "failure",
			current: () => watch,
			save: (next) => {
				watch = next;
			},
			prepare: async () => {
				watch = { ...watch, generation: "new" };
				return input;
			},
			canSend: () => true,
			send,
		});
		expect(watch.generation).toBe("new");
		expect(watch.pending).toBeNull();
		expect(send).not.toHaveBeenCalled();
	});

	test("keeps prepared context when the agent becomes busy before dispatch", async () => {
		let watch = initialWatch;
		const send = vi.fn();
		await runPrWatchRepair({
			watch,
			key: "failure",
			current: () => watch,
			save: (next) => {
				watch = next;
			},
			prepare: async () => input,
			canSend: () => false,
			send,
		});
		expect(watch.pending).not.toBeNull();
		expect(send).not.toHaveBeenCalled();
	});
});
