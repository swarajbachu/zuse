import { describe, expect, test } from "vitest";
import { currentActiveCloudProjectBuilds } from "../../src/cloud-workspace-routes.ts";
import type { CloudProjectBuildRecord } from "../../src/cloud-workspace-store.ts";

const build = (
	buildId: string,
	templateVersion: string,
): CloudProjectBuildRecord => ({
	buildId,
	projectId: "project-1",
	accountId: "account-1",
	provider: "sandbox",
	snapshotId: `snapshot-${buildId}`,
	templateVersion,
	configurationDigest: "digest",
	state: "ready",
	idempotencyKey: `key-${buildId}`,
	nextActionAtMs: Number.MAX_SAFE_INTEGER,
	revision: 1,
	createdAtMs: 1,
	updatedAtMs: 1,
});

describe("cloud project build version", () => {
	test("does not advertise a stale prepared snapshot as launchable", () => {
		expect(
			currentActiveCloudProjectBuilds(
				[build("old", "template-v1")],
				new Map([["sandbox", "template-v2"]]),
			),
		).toEqual({});
		expect(
			currentActiveCloudProjectBuilds(
				[build("current", "template-v2")],
				new Map([["sandbox", "template-v2"]]),
			),
		).toEqual({ sandbox: "current" });
	});
});
