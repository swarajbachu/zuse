import { describe, expect, test } from "vitest";
import {
	cloudWorkspaceResumeIsAlreadyRequested,
	failedWorkspaceResumeTarget,
	runtimeUnavailableResumeTarget,
} from "../../src/cloud-workspace-routes.ts";

describe("failed cloud workspace resume policy", () => {
	test("does not rewrite a workspace whose resume is already in flight", () => {
		for (const state of [
			"paused",
			"resuming",
			"provisioning",
			"setup",
			"ready",
		] as const)
			expect(
				cloudWorkspaceResumeIsAlreadyRequested({
					desiredState: "ready",
					state,
				}),
			).toBe(true);

		expect(
			cloudWorkspaceResumeIsAlreadyRequested({
				desiredState: "paused",
				state: "paused",
			}),
		).toBe(false);
		expect(
			cloudWorkspaceResumeIsAlreadyRequested({
				desiredState: "ready",
				state: "failed",
			}),
		).toBe(false);
	});

	test("restarts the runtime inside an existing sandbox after a connection timeout", () => {
		expect(
			failedWorkspaceResumeTarget({
				providerSandboxId: "sandbox-preserve",
				statusCode: "runtime-connection-timeout",
			}),
		).toEqual({ state: "resuming", providerSandboxId: "sandbox-preserve" });
	});

	test("forces a fenced runtime restart when the gateway has no runtime socket", () => {
		expect(
			runtimeUnavailableResumeTarget({
				providerSandboxId: "sandbox-stale-runtime",
			}),
		).toEqual({
			state: "resuming",
			providerSandboxId: "sandbox-stale-runtime",
		});
		expect(
			runtimeUnavailableResumeTarget({ providerSandboxId: undefined }),
		).toEqual({ state: "queued", providerSandboxId: undefined });
	});

	test("replaces compute only after the provider confirms the sandbox is missing", () => {
		expect(
			failedWorkspaceResumeTarget({
				providerSandboxId: "sandbox-gone",
				statusCode: "provider-sandbox-missing",
			}),
		).toEqual({ state: "queued", providerSandboxId: undefined });
	});

	test("replaces an incomplete sandbox after bootstrap fails before the repository is ready", () => {
		for (const statusCode of [
			"initializing-failed",
			"updating-runtime-failed",
			"starting-runtime-failed",
			"syncing-repository-failed",
		] as const)
			expect(
				failedWorkspaceResumeTarget({
					providerSandboxId: "sandbox-incomplete",
					statusCode,
				}),
			).toEqual({ state: "queued", providerSandboxId: undefined });
	});
});
