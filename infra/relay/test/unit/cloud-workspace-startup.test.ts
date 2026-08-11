import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";
import { cloudWorkspaceReadinessAuthorization } from "../../src/cloud-workspace-routes.ts";
import type { CloudWorkspaceRecord } from "../../src/cloud-workspace-store.ts";

const bootstrapUrl = new URL(
	"../../../cloud-sandboxes/workspace-bootstrap.sh",
	import.meta.url,
);

const workspace = (
	overrides: Partial<CloudWorkspaceRecord> = {},
): CloudWorkspaceRecord => ({
	workspaceId: "workspace-1",
	accountId: "account-1",
	projectId: "project-1",
	buildId: "build-1",
	provider: "provider-1",
	branch: "task/one",
	baseRef: "origin/main",
	state: "setup",
	desiredState: "ready",
	statusCode: "repository-setup-running",
	credentialEpoch: 1,
	idempotencyKey: "workspace-key",
	requestConfig: { startupProtocol: "callback-v1" },
	nextActionAtMs: 1_000,
	revision: 1,
	createdAtMs: 1_000,
	updatedAtMs: 1_000,
	lastActivityAtMs: 1_000,
	...overrides,
});

describe("cloud workspace startup path", () => {
	test("starts one runtime without fixed sleeps or dependency setup", async () => {
		const bootstrap = await readFile(bootstrapUrl, "utf8");
		expect(bootstrap.match(/zuse serve --foreground/gu)).toHaveLength(1);
		expect(bootstrap).not.toMatch(/\bsleep\b/u);
		expect(bootstrap).not.toContain("ZUSE_INCREMENTAL_SETUP_COMMAND");
		expect(bootstrap).toContain("workspace-ready.ts");
		expect(bootstrap).toContain("credentials-ready-event");
		expect(bootstrap).toContain(
			'wait -n "$runtime_pid" "$credentials_wait_pid"',
		);
		expect(bootstrap).not.toContain("SIGUSR1");
	});

	test("consumes enrollment once and only retries readiness in ready state", () => {
		expect(
			cloudWorkspaceReadinessAuthorization(
				workspace({
					enrollmentTokenHash: "live",
					enrollmentExpiresAtMs: 2_000,
				}),
				"live",
				1_500,
			),
		).toBe("initial");
		const receipt = workspace({
			state: "ready",
			enrollmentTokenHash: undefined,
			enrollmentExpiresAtMs: undefined,
			requestConfig: {
				readinessReceiptHash: "receipt",
				readinessReceiptExpiresAtMs: 2_000,
				startupTimings: { repositoryReadyAt: 1_400 },
			},
		});
		expect(
			cloudWorkspaceReadinessAuthorization(receipt, "receipt", 1_500),
		).toBe("retry");
		expect(
			cloudWorkspaceReadinessAuthorization(
				{ ...receipt, state: "paused", desiredState: "paused" },
				"receipt",
				1_500,
			),
		).toBe("reject");
	});
});
