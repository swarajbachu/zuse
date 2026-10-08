import { expect, test } from "vitest";

import { cloudLifecycle } from "../../../src/lib/cloud-lifecycle";

const summary = (fields: Record<string, string>) =>
	({ state: "ready", startupPhase: "running", ...fields }) as never;

test("maps workspace state to the chat's setup surface", () => {
	expect(cloudLifecycle(undefined)).toBeNull();
	expect(cloudLifecycle(summary({}))).toBeNull();
	expect(
		cloudLifecycle(
			summary({ state: "provisioning", startupPhase: "allocating" }),
		),
	).toBe("starting");
	expect(cloudLifecycle(summary({ startupPhase: "syncing-repository" }))).toBe(
		"starting",
	);
	expect(cloudLifecycle(summary({ state: "resuming" }))).toBe("resuming");
	expect(cloudLifecycle(summary({ state: "paused" }))).toBe("paused");
	expect(cloudLifecycle(summary({ startupPhase: "failed" }))).toBe("failed");
});
