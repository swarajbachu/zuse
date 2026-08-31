import { describe, expect, test } from "vitest";

import {
	isCloudAccountImageOutdated,
	selectActiveAccountImageBuild,
} from "../../src/cloud-workspace-routes.ts";
import type { CloudProjectBuildRecord } from "../../src/cloud-workspace-store.ts";

const imageStatus = (overrides: {
	readonly imagePromotedAtMs?: number;
	readonly imageTemplateVersion?: string;
	readonly currentTemplateVersion?: string;
	readonly projects?: ReadonlyArray<{
		readonly state: string;
		readonly updatedAtMs: number;
	}>;
	readonly providers?: ReadonlyArray<{ readonly verifiedAt?: number }>;
}) =>
	isCloudAccountImageOutdated({
		imagePromotedAtMs: 200,
		imageTemplateVersion: "runtime-v2",
		currentTemplateVersion: "runtime-v2",
		projects: [{ state: "ready", updatedAtMs: 200 }],
		providers: [{ verifiedAt: 100 }],
		...overrides,
	});

describe("cloud account image status", () => {
	test("is ready after projects are marked ready during promotion", () => {
		expect(imageStatus({})).toBe(false);
	});

	test("is outdated when a repository changes after promotion", () => {
		expect(
			imageStatus({ projects: [{ state: "ready", updatedAtMs: 201 }] }),
		).toBe(true);
	});

	test("is outdated when provider auth changes after promotion", () => {
		expect(imageStatus({ providers: [{ verifiedAt: 201 }] })).toBe(true);
	});

	test("is outdated when the runtime template changes", () => {
		expect(imageStatus({ currentTemplateVersion: "runtime-v3" })).toBe(true);
	});

	test("selects the newest active snapshot from newest-first builds", () => {
		const build = (buildId: string, updatedAtMs: number) =>
			({
				buildId,
				state: "ready",
				snapshotId: `snapshot-${buildId}`,
				templateVersion: "runtime-v2",
				updatedAtMs,
			}) as CloudProjectBuildRecord;
		expect(
			selectActiveAccountImageBuild(
				[build("newest", 200), build("oldest", 100)],
				"runtime-v2",
			)?.buildId,
		).toBe("newest");
	});
});
