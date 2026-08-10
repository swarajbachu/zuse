import { describe, expect, test } from "vitest";
import {
	cloudWorkspaceAfterProviderFailure,
	cloudWorkspaceAfterSetupFailure,
	cloudWorkspaceEnrollmentNeedsRefresh,
	cloudWorkspaceReconcileDelay,
	cloudWorkspaceStartupTimedOut,
	cloudWorkspaceWithoutProviderSandbox,
} from "../../src/cloud-workspace-failure.ts";
import type { CloudWorkspaceRecord } from "../../src/cloud-workspace-store.ts";

const workspace = (
	overrides: Partial<CloudWorkspaceRecord> = {},
): CloudWorkspaceRecord => ({
	workspaceId: "workspace_1",
	accountId: "account_1",
	projectId: "project_1",
	buildId: "build_1",
	provider: "provider_1",
	providerSandboxId: "sandbox_1",
	branch: "zuse/task-1",
	baseRef: "origin/main",
	state: "provisioning",
	desiredState: "ready",
	statusCode: "identity-reset",
	credentialEpoch: 1,
	idempotencyKey: "request_1",
	requestConfig: {},
	nextActionAtMs: 0,
	revision: 1,
	createdAtMs: 1_000,
	updatedAtMs: 1_000,
	lastActivityAtMs: 1_000,
	...overrides,
});

describe("cloud workspace provider failures", () => {
	test("uses an operation-specific status for a rejected request", () => {
		expect(
			cloudWorkspaceAfterProviderFailure(
				workspace(),
				"rejected",
				2_000,
				"network-policy-rejected",
			),
		).toMatchObject({
			state: "failed",
			statusCode: "network-policy-rejected",
			nextActionAtMs: Number.MAX_SAFE_INTEGER,
			revision: 2,
			updatedAtMs: 2_000,
		});
	});

	test("does not mislabel another rejected provisioning request as network policy", () => {
		expect(
			cloudWorkspaceAfterProviderFailure(workspace(), "rejected", 2_000),
		).toMatchObject({
			state: "failed",
			statusCode: "provider-request-rejected",
		});
	});

	test("retries a short transient provider outage", () => {
		expect(
			cloudWorkspaceAfterProviderFailure(workspace(), "transient", 60_000),
		).toMatchObject({
			state: "provisioning",
			statusCode: "provider-retrying",
			nextActionAtMs: 65_000,
		});
	});

	test("stops retrying after the workspace startup deadline", () => {
		expect(
			cloudWorkspaceAfterProviderFailure(
				workspace(),
				"transient",
				5 * 60 * 1_000 + 1_000,
			),
		).toMatchObject({
			state: "failed",
			statusCode: "provider-unavailable",
			nextActionAtMs: Number.MAX_SAFE_INTEGER,
		});
	});

	test("reports a missing provider sandbox without retrying", () => {
		expect(
			cloudWorkspaceAfterProviderFailure(
				workspace({ state: "setup" }),
				"not-found",
				2_000,
			),
		).toMatchObject({
			state: "failed",
			statusCode: "provider-sandbox-missing",
		});
	});

	test("does not apply the initial startup deadline to a later resume", () => {
		expect(
			cloudWorkspaceAfterProviderFailure(
				workspace({ state: "resuming", createdAtMs: 1_000 }),
				"transient",
				10 * 60 * 1_000,
			),
		).toMatchObject({
			state: "resuming",
			statusCode: "provider-retrying",
		});
	});
});

describe("cloud workspace terminal startup failures", () => {
	test("times out marker waits even when provider calls keep succeeding", () => {
		expect(
			cloudWorkspaceStartupTimedOut(
				workspace({ state: "setup" }),
				5 * 60 * 1_000 + 1_000,
			),
		).toBe(true);
		expect(
			cloudWorkspaceStartupTimedOut(
				workspace({ state: "resuming" }),
				5 * 60 * 1_000 + 1_000,
			),
		).toBe(false);
	});

	test("shares setup failure mapping and clears unsafe provider identity", () => {
		const failed = cloudWorkspaceWithoutProviderSandbox(
			cloudWorkspaceAfterSetupFailure(workspace(), 2_000),
		);
		expect(failed).toMatchObject({
			state: "failed",
			statusCode: "setup-failed",
			providerSandboxId: undefined,
			enrollmentTokenHash: undefined,
			revision: 2,
		});
	});
});

describe("cloud workspace enrollment refresh", () => {
	test("refreshes an expired enrollment while setup has no environment", () => {
		expect(
			cloudWorkspaceEnrollmentNeedsRefresh(
				workspace({ state: "setup", enrollmentExpiresAtMs: 2_000 }),
				2_000,
			),
		).toBe(true);
	});

	test("does not refresh after the environment enrolled", () => {
		expect(
			cloudWorkspaceEnrollmentNeedsRefresh(
				workspace({
					state: "setup",
					enrollmentExpiresAtMs: 2_000,
					environmentId: "environment_1",
				}),
				2_000,
			),
		).toBe(false);
	});
});

describe("cloud workspace eager reconciliation", () => {
	test("keeps a starting workspace moving between short provider stages", () => {
		expect(
			cloudWorkspaceReconcileDelay(workspace({ nextActionAtMs: 7_000 }), 2_000),
		).toBe(5_000);
	});

	test("does not hold a worker for terminal or long-delay states", () => {
		expect(
			cloudWorkspaceReconcileDelay(
				workspace({ state: "ready", nextActionAtMs: 7_000 }),
				2_000,
			),
		).toBeNull();
		expect(
			cloudWorkspaceReconcileDelay(workspace({ nextActionAtMs: 7_001 }), 2_000),
		).toBeNull();
	});
});
