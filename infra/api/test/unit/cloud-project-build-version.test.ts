import { describe, expect, test } from "vitest";
import {
	currentActiveCloudProjectBuilds,
	selectCloudWorkspaceBuild,
} from "../../src/cloud-workspace-routes.ts";
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

	test("uses a direct clone when no compatible snapshot is available", () => {
		const failed = {
			...build("failed", "template-v2"),
			snapshotId: undefined,
			state: "failed" as const,
		};
		expect(
			selectCloudWorkspaceBuild(null, null, [failed], "template-v2"),
		).toEqual({ build: failed, preparedSnapshotAvailable: false });
	});

	test("prefers a compatible snapshot over a stale account snapshot", () => {
		const stale = build("account-stale", "template-v1");
		const current = build("project-current", "template-v2");
		expect(
			selectCloudWorkspaceBuild(stale, current, [current], "template-v2"),
		).toEqual({ build: current, preparedSnapshotAvailable: true });
	});
});
