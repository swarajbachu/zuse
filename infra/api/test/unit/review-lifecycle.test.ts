import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	makeReviewLifecycle,
	type ReviewLifecycleDependencies,
} from "../../src/review-lifecycle.ts";
import type {
	ReviewManagedAttempt,
	ReviewNativeConnection,
} from "../../src/review-lifecycle-store.ts";

vi.mock("../../src/review-readiness.ts", () => ({
	getReviewReadiness: () => ({ available: true, reasons: [] }),
}));
const now = Date.now();
const fixture = () => {
	const events: string[] = [];
	const a: ReviewManagedAttempt = {
		id: "attempt",
		runId: "run",
		ownerId: "payer",
		provider: "e2b",
		providerSandboxId: "sandbox",
		leaseToken: "lease",
		createdAtMs: now - 10,
		allocatedAtMs: now - 5,
		stoppedAtMs: null,
		maximumLifetimeMs: 600000,
		lifecycle: {
			connectionId: "connection",
			stage: "running",
			deadlineMs: now + 600000,
			maximumCostMicros: 10,
			heartbeatAtMs: now,
			workerStarted: true,
			cleanupConfirmed: false,
			resultReceived: false,
			bootHash: "hash",
		},
		run: {
			id: "run",
			repositoryId: 1,
			repositoryFullName: "org/repo",
			installationId: 1,
			pullNumber: 1,
			authorGithubUserId: 1,
			baseRef: "main",
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
			mergeBaseSha: null,
			fork: false,
			enrollmentId: "enrollment",
			enrollmentVersion: 1,
			ownerId: "payer",
			modelConnectionId: "connection",
			agentProvider: "claude",
			model: "model",
			worker: { provider: "e2b", size: "small", maxRuntimeMs: 600000 },
			configVersion: "v1",
			generation: "automatic",
			state: "provisioning",
			blockedReason: null,
			createdAtMs: now,
			updatedAtMs: now,
		},
	};
	let c: ReviewNativeConnection = {
		id: "connection",
		ownerActorId: "actor",
		ownerId: "payer",
		label: "Claude",
		agentProvider: "claude",
		sandboxProvider: "e2b",
		size: "small",
		models: ["model"],
		providerSandboxId: "sandbox",
		state: "ready",
		createdAtMs: now,
		updatedAtMs: now,
		providerIdentity: "claude:identity",
	};
	let state: "running" | "paused" | null = "running";
	const dependencies = {
		configuration: {
			review: {
				enabled: true,
				stagingVerified: true,
				templateId: "image",
				workerModule: "/worker",
				claudeExecutable: "/claude",
				models: ["model"],
			},
			apiIssuer: "https://api.example.com",
		},
		core: {
			canReadRunArtifacts: async () => true,
			renewRun: async () => true,
			acceptResult: async () => {
				events.push("publish");
				return true;
			},
			stopAttempt: async () => {
				events.push("stop");
				a.stoppedAtMs = now;
				return true;
			},
			getRun: async () => a.run,
			claimRun: async () => ({ run: a.run, leaseToken: a.leaseToken }),
			blockRun: async () => {},
			listEnrollments: async () => [{ id: "enrollment", enabledBy: "actor" }],
			recordAttempt: async () => true,
			checkForkApproved: async () => false,
		},
		store: {
			getConnection: async () => c,
			getAttempt: async () => a,
			claimSupervisor: async () => "supervisor",
			releaseSupervisor: async () => {},
			updateAttempt: async (_id: string, _token: string, data: object) => {
				Object.assign(a.lifecycle, data);
				return true;
			},
			saveConnection: async (next: ReviewNativeConnection) => {
				c = next;
			},
			releaseConnection: async () => {
				events.push("release");
			},
			finishRun: async () => {
				events.push("fail");
			},
			releaseCostReservation: async () => {
				events.push("release-cost");
			},
			claimConnection: async () => true,
			initializeAttempt: async () => true,
		},
		provider: async () => ({
			sizes: [{ sizeId: "small" }],
			inspect: () =>
				Effect.succeed(
					state
						? { providerSandboxId: "sandbox", providerLabel: "review", state }
						: null,
				),
			pause: () =>
				Effect.sync(() => {
					events.push("pause");
					state = "paused";
				}),
			kill: () =>
				Effect.sync(() => {
					events.push("kill");
					state = null;
				}),
			replaceProcess: () =>
				Effect.sync(() => {
					events.push("launch");
				}),
			resume: () =>
				Effect.sync(() => {
					events.push("resume");
					state = "running";
					return {
						providerSandboxId: "sandbox",
						providerLabel: "review",
						state: "running",
					};
				}),
			extendTimeout: () => Effect.void,
			pathExists: () => Effect.succeed(true),
			setNetwork: () => Effect.void,
		}),
		reserve: async () => 10,
		observe: async () => {
			events.push("observe");
		},
		token: async () => "token",
		hash: async () => "hash",
	} as unknown as ReviewLifecycleDependencies;
	return {
		a,
		events,
		dependencies,
		lifecycle: makeReviewLifecycle(dependencies),
		connection: () => c,
	};
};
describe("hosted review lifecycle", () => {
	it("pauses a confirmed clean worker before publishing and retains settlement reservation", async () => {
		const f = fixture();
		f.a.lifecycle.cleanupConfirmed = true;
		f.a.lifecycle.resultReceived = true;
		f.a.lifecycle.pendingResult = {
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
				eligibleFiles: 0,
				reviewedFiles: 0,
				excludedFiles: 0,
				unreviewedPaths: [],
				contextLimited: false,
			},
		};
		await f.lifecycle.supervise(f.a, now);
		expect(f.events).toEqual([
			"pause",
			"observe",
			"stop",
			"publish",
			"release",
		]);
		expect(f.connection().state).toBe("ready");
	});
	it("parks immediately on upload and leaves verification recoverable without paid idle compute", async () => {
		const f = fixture();
		f.a.lifecycle.cleanupConfirmed = true;
		f.a.lifecycle.resultReceived = true;
		f.a.lifecycle.pendingResult = {
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
				eligibleFiles: 0,
				reviewedFiles: 0,
				excludedFiles: 0,
				unreviewedPaths: [],
				contextLimited: false,
			},
		};
		await f.lifecycle.park(f.a.id, now);
		expect(f.events).toEqual(["pause", "observe", "stop"]);
		expect(f.a.lifecycle.stage).toBe("checking");
		f.dependencies.verify = async (_attempt, result) => {
			f.events.push("check");
			return result;
		};
		await f.lifecycle.supervise(f.a, now + 1);
		expect(f.events).toEqual([
			"pause",
			"observe",
			"stop",
			"check",
			"publish",
			"release",
		]);
	});
	it("destroys uncertain starts instead of resuming a possibly active native process", async () => {
		const f = fixture();
		f.a.lifecycle.stage = "starting";
		f.a.lifecycle.workerStarted = false;
		await f.lifecycle.supervise(f.a, now);
		expect(f.events).toContain("kill");
		expect(f.events).not.toContain("launch");
		expect(f.connection().state).toBe("lost");
	});
	it("cancellation destroys workers without claiming a cleanup confirmation", async () => {
		const f = fixture();
		f.a.run = { ...f.a.run, state: "cancelled" };
		await f.lifecycle.supervise(f.a, now);
		expect(f.events).toEqual(["kill", "observe", "stop", "release", "fail"]);
	});
	it("an uncertain provider kill retains the active attempt for recovery and its reservation", async () => {
		const f = fixture();
		f.a.run = { ...f.a.run, state: "cancelled" };
		f.dependencies.provider = async () => ({
			...(await fixture().dependencies.provider("e2b")),
			kill: () => Effect.fail({ code: "transient" } as never),
		});
		await f.lifecycle.supervise(f.a, now);
		expect(f.a.stoppedAtMs).toBeNull();
		expect(f.events).not.toContain("release-cost");
	});
	it("a denied cap cannot allocate or launch paid compute", async () => {
		const f = fixture();
		f.a.run = { ...f.a.run, state: "queued" };
		f.a.providerSandboxId = null;
		f.dependencies.reserve = async () => {
			throw Error("review_account_budget_exceeded");
		};
		await f.lifecycle.dispatch("run", now);
		expect(f.events).not.toContain("launch");
		expect(f.events).not.toContain("resume");
		expect(f.events).toContain("release-cost");
	});
});
