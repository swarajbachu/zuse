import { describe, expect, test } from "vitest";
import {
	chatLandingProgress,
	cloudWorkspaceFailureMessage,
} from "../../src/lib/chat-landing-progress.ts";

describe("chat landing progress", () => {
	test("shows only cloud progress while a cloud workspace is starting", () => {
		expect(
			chatLandingProgress({
				cloudStatus: "Allocating cloud sandbox…",
				hasPendingWorktree: true,
			}),
		).toEqual({ kind: "cloud", status: "Allocating cloud sandbox…" });
	});

	test("shows worktree progress for local workspace creation", () => {
		expect(
			chatLandingProgress({
				cloudStatus: null,
				hasPendingWorktree: true,
			}),
		).toEqual({ kind: "worktree" });
	});

	test("shows no setup progress when neither operation is active", () => {
		expect(
			chatLandingProgress({
				cloudStatus: null,
				hasPendingWorktree: false,
			}),
		).toEqual({ kind: "none" });
	});
});

describe("cloud workspace failure messages", () => {
	test("explains a rejected network policy without exposing internals", () => {
		expect(cloudWorkspaceFailureMessage("network-policy-rejected")).toBe(
			"Cloud Sandbox could not apply its network policy. Try again after the provider configuration is fixed.",
		);
	});

	test("explains when the provider sandbox disappeared", () => {
		expect(cloudWorkspaceFailureMessage("provider-sandbox-missing")).toBe(
			"The cloud sandbox no longer exists. Start a new cloud workspace.",
		);
	});

	test("keeps an unknown status available for support", () => {
		expect(cloudWorkspaceFailureMessage("unexpected-status")).toBe(
			"Cloud workspace setup failed (unexpected-status).",
		);
	});
});
