import { EnvironmentId, SessionId } from "@zuse/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { setPlatformOnlineForTest } from "../../src/lib/network-status.ts";
import {
	canResumeQueue,
	clearHeldQueuesForTest,
	heldQueueRefsForTest,
	holdQueueUntilOnline,
	installQueueOnlineRecovery,
	queueHoldReason,
} from "../../src/lib/queue-recovery.ts";

describe("queue recovery", () => {
	afterEach(() => {
		setPlatformOnlineForTest(true);
		clearHeldQueuesForTest();
	});

	it("reports why a queue is held", () => {
		expect(queueHoldReason({ paused: true, runtime: "idle" })).toBe("paused");
		expect(queueHoldReason({ paused: false, runtime: "failed" })).toBe(
			"failed",
		);
		expect(queueHoldReason({ paused: true, runtime: "failed" })).toBe("paused");
		expect(queueHoldReason({ paused: false, runtime: "idle" })).toBeNull();
	});

	it("resumes only a non-empty queue on a settled session", () => {
		const base = {
			itemCount: 1,
			paused: false,
			creationInProgress: false,
			waitingForSandbox: false,
		};
		expect(canResumeQueue({ ...base, runtime: "failed" })).toBe(true);
		expect(canResumeQueue({ ...base, runtime: "idle" })).toBe(true);
		expect(canResumeQueue({ ...base, runtime: "running" })).toBe(false);
		expect(canResumeQueue({ ...base, runtime: "stopping" })).toBe(false);
		expect(canResumeQueue({ ...base, runtime: "starting" })).toBe(false);
		expect(canResumeQueue({ ...base, runtime: "idle", itemCount: 0 })).toBe(
			false,
		);
		expect(
			canResumeQueue({ ...base, runtime: "idle", creationInProgress: true }),
		).toBe(false);
		expect(
			canResumeQueue({ ...base, runtime: "idle", waitingForSandbox: true }),
		).toBe(false);
	});

	it("resumes held queues once on the online edge", async () => {
		const resumed: string[] = [];
		setPlatformOnlineForTest(false);
		const uninstall = installQueueOnlineRecovery(async (ref) => {
			resumed.push(ref.sessionId);
		});
		const ref = {
			environmentId: EnvironmentId.make("env_local"),
			sessionId: SessionId.make("session_held"),
		};
		holdQueueUntilOnline(ref);
		holdQueueUntilOnline(ref);
		expect(heldQueueRefsForTest()).toHaveLength(1);

		setPlatformOnlineForTest(true);
		await Promise.resolve();
		expect(resumed).toEqual(["session_held"]);
		expect(heldQueueRefsForTest()).toHaveLength(0);

		setPlatformOnlineForTest(false);
		setPlatformOnlineForTest(true);
		expect(resumed).toEqual(["session_held"]);
		uninstall();
	});

	it("keeps a held queue registered when resume fails", async () => {
		setPlatformOnlineForTest(false);
		const ref = {
			environmentId: EnvironmentId.make("env_local"),
			sessionId: SessionId.make("session_retry"),
		};
		const uninstall = installQueueOnlineRecovery(async () => {
			throw new Error("resume failed");
		});
		holdQueueUntilOnline(ref);

		setPlatformOnlineForTest(true);
		await Promise.resolve();
		await Promise.resolve();

		expect(heldQueueRefsForTest()).toEqual([ref]);
		uninstall();
	});
});
