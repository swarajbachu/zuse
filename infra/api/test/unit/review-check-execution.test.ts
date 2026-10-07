import type { ReviewResult } from "@zuse/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	makeReviewCheckExecution,
	type ReviewCheckDependencies,
} from "../../src/review-check-execution.ts";
import type {
	ReviewManagedAttempt,
	ReviewNativeActivity,
} from "../../src/review-lifecycle-store.ts";

const fixture = () => {
	let now = 100000,
		phase = "prepared",
		alive = false;
	let activity: ReviewNativeActivity | null = null;
	let persisted: ReviewResult | undefined;
	let budget = 20000;
	let marked = false;
	let delayCompletion = false;
	let missingChecks = false;
	let failStop = false;
	let readCount = 0;
	const events: string[] = [];
	const result: ReviewResult = {
		snapshot: {
			repositoryId: 1,
			baseRef: "main",
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
			mergeBaseSha: "c".repeat(40),
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
	};
	const a = {
		id: "a",
		runId: "r",
		ownerId: "payer",
		provider: "e2b",
		leaseToken: "lease",
		createdAtMs: 80000,
		stoppedAtMs: 100000,
		lifecycle: { maximumCostMicros: 20 },
		run: {
			id: "r",
			repositoryFullName: "org/repo",
			worker: { size: "small", maxRuntimeMs: 600000, maxCostMicros: 100 },
			modelConnectionId: "private-auth",
		},
	} as ReviewManagedAttempt;
	const dependencies = {
		now: () => now,
		sleep: async (ms: number) => {
			now += ms;
		},
		templateId: "clean-check-image",
		core: { renewRun: async () => true, canReadRunArtifacts: async () => true },
		store: {
			getActivity: async () => activity,
			saveActivity: async (next: ReviewNativeActivity) => {
				activity = next;
				events.push(`activity:${next.state}`);
			},
			getRunExecutionBudget: async () => ({
				allocatedMs: budget,
				maximumCostMicros: 20,
			}),
			updateAttempt: async (
				_id: string,
				_lease: string,
				data: { pendingResult: ReviewResult },
			) => {
				persisted = data.pendingResult;
				events.push("persist");
				return true;
			},
		},
		authorize: async () => ({
			cloneUrl: "https://github.com/org/repo.git",
			token: "fetch-only-token",
		}),
		reserve: async (
			_a: ReviewManagedAttempt,
			_id: string,
			duration: number,
			_now: number,
			cost: number,
		) => {
			expect(duration).toBeLessThanOrEqual(180000);
			expect(cost).toBe(80);
			events.push("reserve");
			return 10;
		},
		observe: async (
			_a: ReviewManagedAttempt,
			_activity: ReviewNativeActivity,
			running: boolean,
		) => {
			events.push(`observe:${running}`);
		},
		provider: async () => ({
			fork: (input: { snapshotId: string; env: object }) =>
				Effect.sync(() => {
					expect(input.snapshotId).toBe("clean-check-image");
					expect(input.env).toEqual({});
					alive = true;
					events.push("fork");
					return { providerSandboxId: "child" };
				}),
			startProcess: (_id: string, input: { args: string[]; env: object }) =>
				Effect.sync(() => {
					if (input.args[1] === "prepare") {
						expect(input.env).toEqual({
							ZUSE_REVIEW_GIT_TOKEN: "fetch-only-token",
						});
						expect(JSON.parse(input.args[2] ?? "{}").baseSha).toBe(
							"c".repeat(40),
						);
						events.push("prepare");
					} else {
						expect(input.env).toEqual({});
						events.push("run");
						if (!delayCompletion) phase = "complete";
					}
				}),
			setNetwork: (_id: string, policy: object) =>
				Effect.sync(() => {
					expect(policy).toEqual({ kind: "quarantined" });
					events.push("network-denied");
				}),
			writeTextFile: () =>
				Effect.sync(() => {
					marked = true;
					events.push("run-marked");
				}),
			pathExists: (_id: string, path: string) =>
				Effect.succeed(path.endsWith("run-requested") ? marked : true),
			readTextFile: () =>
				Effect.sync(() => {
					if (delayCompletion && marked && ++readCount > 3) phase = "complete";
					return JSON.stringify({
						phase,
						checks: missingChecks
							? undefined
							: [
									{
										script: "test",
										command: "node test.js",
										base: {
											status: "passed",
											exitCode: 0,
											output: "1 test passed",
										},
										head: {
											status: "failed",
											exitCode: 1,
											output: "assertion failed",
										},
									},
								],
					});
				}),
			recoverByLabel: () => Effect.succeed(null),
			kill: () =>
				Effect.sync(() => {
					if (failStop) throw Error("provider unavailable");
					alive = false;
					events.push("kill");
				}),
			inspect: () => Effect.sync(() => (alive ? { state: "running" } : null)),
		}),
	} as unknown as ReviewCheckDependencies;
	return {
		a,
		result,
		dependencies,
		events,
		get persisted() {
			return persisted;
		},
		delay: () => {
			delayCompletion = true;
		},
		missing: () => {
			missingChecks = true;
			phase = "complete";
		},
		failStop: () => {
			failStop = true;
		},
		setBudget: (n: number) => {
			budget = n;
		},
		setPhase: (p: string) => {
			phase = p;
		},
		setActivity: (next: ReviewNativeActivity) => {
			activity = next;
		},
	};
};
describe("isolated review test lifecycle", () => {
	it("reserves before allocation, removes network before tests, persists before confirmed shutdown", async () => {
		const f = fixture();
		const next = await makeReviewCheckExecution(f.dependencies).run(
			f.a,
			f.result,
		);
		expect(next.checks?.[0]?.head.status).toBe("failed");
		for (const [before, after] of [
			["reserve", "fork"],
			["network-denied", "run"],
			["persist", "kill"],
			["kill", "observe:false"],
		] satisfies [string, string][])
			expect(f.events.indexOf(before)).toBeLessThan(f.events.indexOf(after));
		expect(f.persisted).toEqual(next);
	});
	it("does not allocate after aggregate runtime is exhausted", async () => {
		const f = fixture();
		f.setBudget(600000);
		const next = await makeReviewCheckExecution(f.dependencies).run(
			f.a,
			f.result,
		);
		expect(next.status).toBe("partial");
		expect(next.checksReason).toBe("review_check_budget_exhausted");
		expect(f.events).not.toContain("fork");
	});
	it("rejects test allocation until native compute is confirmed stopped", async () => {
		const f = fixture();
		f.a.stoppedAtMs = null;
		await expect(
			makeReviewCheckExecution(f.dependencies).run(f.a, f.result),
		).rejects.toThrow("review_inference_stop_unconfirmed");
		expect(f.events).not.toContain("fork");
	});
	it("records setup failure as incomplete and shuts down chargeable compute", async () => {
		const f = fixture();
		f.setPhase("failed");
		const next = await makeReviewCheckExecution(f.dependencies).run(
			f.a,
			f.result,
		);
		expect(next.status).toBe("partial");
		expect(next.checks).toEqual([]);
		expect(f.events).toContain("kill");
		expect(f.events).toContain("observe:false");
	});
	it("never allocates a replacement after an ambiguous create response", async () => {
		const f = fixture();
		f.setActivity({
			id: "review-check-a",
			kind: "check",
			connectionId: "private-auth",
			ownerId: "payer",
			provider: "e2b",
			providerSandboxId: null,
			startedAtMs: 99999,
			stoppedAtMs: null,
			deadlineMs: 200000,
			maximumCostMicros: 10,
			state: "admitted",
		});
		await expect(
			makeReviewCheckExecution(f.dependencies).run(f.a, f.result),
		).rejects.toThrow("review_check_allocation_unconfirmed");
		expect(f.events).not.toContain("fork");
	});

	it("does not restart a slow check while prepared status remains visible", async () => {
		const f = fixture();
		f.delay();
		const next = await makeReviewCheckExecution(f.dependencies).run(
			f.a,
			f.result,
		);
		expect(next.checks?.[0]?.head.status).toBe("failed");
		expect(f.events.filter((event) => event === "run")).toHaveLength(1);
		expect(f.events.indexOf("run-marked")).toBeLessThan(
			f.events.indexOf("run"),
		);
	});
	it("does not turn a missing checks artifact into a completed check", async () => {
		const f = fixture();
		f.missing();
		const next = await makeReviewCheckExecution(f.dependencies).run(
			f.a,
			f.result,
		);
		expect(next.status).toBe("partial");
		expect(next.checksReason).toBe("review_checks_incomplete");
	});
	it("preserves verified evidence before an uncertain teardown", async () => {
		const f = fixture();
		f.failStop();
		await expect(
			makeReviewCheckExecution(f.dependencies).run(f.a, f.result),
		).rejects.toThrow();
		expect(f.persisted?.checks?.[0]?.head.status).toBe("failed");
		expect(f.events.filter((event) => event === "persist")).toHaveLength(1);
	});
});
