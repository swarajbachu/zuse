import { describe, expect, test } from "vitest";

import {
	codexAuthModeForAccountBuild,
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
	readonly providers?: ReadonlyArray<{
		readonly providerId?: string;
		readonly verifiedAt?: number;
	}>;
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

	test("does not rebuild a broker image when account-level Codex auth rotates", () => {
		expect(
			isCloudAccountImageOutdated({
				imagePromotedAtMs: 200,
				imageTemplateVersion: "runtime-v2",
				currentTemplateVersion: "runtime-v2",
				projects: [{ state: "ready", updatedAtMs: 200 }],
				providers: [
					{ providerId: "codex", verifiedAt: 201 },
					{ providerId: "claude", verifiedAt: 100 },
				],
				codexAuthDeliveryVersion: 1,
			}),
		).toBe(false);
	});

	test("marks a pre-broker image outdated when broker enrollment is required", () => {
		expect(
			isCloudAccountImageOutdated({
				imagePromotedAtMs: 200,
				imageTemplateVersion: "runtime-v2",
				currentTemplateVersion: "runtime-v2",
				projects: [{ state: "ready", updatedAtMs: 200 }],
				providers: [],
				requiredCodexAuthDeliveryVersion: 1,
			}),
		).toBe(true);
	});

	test("enrolls only subscription-backed Codex images in the broker", () => {
		const build = (method: "subscription" | "api-key") =>
			({
				buildId: "build-1",
				projectId: "project-1",
				accountId: "account-1",
				provider: "e2b",
				templateVersion: "runtime-v2",
				configurationDigest: "digest",
				settings: {
					codexAuthDeliveryVersion: 1,
					providers: [{ providerId: "codex", method }],
				},
				state: "ready" as const,
				idempotencyKey: "build-1",
				nextActionAtMs: 0,
				revision: 0,
				createdAtMs: 0,
				updatedAtMs: 0,
			}) satisfies CloudProjectBuildRecord;
		expect(codexAuthModeForAccountBuild(build("subscription"), true)).toBe(
			"broker-v1",
		);
		expect(codexAuthModeForAccountBuild(build("api-key"), true)).toBe(
			"legacy-image",
		);
		expect(codexAuthModeForAccountBuild(build("subscription"), false)).toBe(
			"legacy-image",
		);
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
