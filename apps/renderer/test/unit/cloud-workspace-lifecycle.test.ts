import { AgentSessionId, ChatId, CloudWorkspace } from "@zuse/contracts";
import { Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
	cloudTranscriptActivation,
	cloudWorkspaceStartupError,
	isCloudWorkspaceReady,
	waitForCloudWorkspaceReady,
} from "../../src/lib/cloud-workspace-lifecycle.ts";

const workspace = (
	revision: number,
	state: CloudWorkspace["state"],
	runtimeState: CloudWorkspace["runtimeState"],
) =>
	CloudWorkspace.make({
		workspaceId: "workspace-1",
		projectId: "project-1",
		buildId: "build-1",
		providerId: "e2b",
		branch: "zuse/realtime",
		baseRef: "main",
		state,
		desiredState: "ready",
		statusCode: state,
		startupPhase:
			state === "failed" ? "failed" : state === "ready" ? "running" : "booting",
		startupTimings: {},
		runtimeState,
		revision,
		chatId: ChatId.make("chat-1"),
		initialSessionId: AgentSessionId.make("session-1"),
		createdAt: 1,
		updatedAt: revision,
		lastActivityAt: revision,
		recoveryAvailable: false,
	});

describe("cloud workspace lifecycle", () => {
	it("renders paused compute from cache without waking it", () => {
		expect(cloudTranscriptActivation(workspace(1, "paused", "offline"))).toBe(
			"cache-only",
		);
		expect(
			cloudTranscriptActivation(workspace(2, "resuming", "connecting")),
		).toBe("cache-only");
		expect(cloudTranscriptActivation(workspace(3, "ready", "online"))).toBe(
			"connect",
		);
	});

	it("waits through lifecycle changes and returns the first online-ready frame", async () => {
		const seen: number[] = [];
		const ready = await waitForCloudWorkspaceReady(
			Stream.fromIterable([
				workspace(2, "resuming", "offline"),
				workspace(3, "ready", "connecting"),
				workspace(4, "ready", "online"),
			]),
			(next) => seen.push(next.revision),
		);

		expect(seen).toEqual([2, 3, 4]);
		expect(ready.revision).toBe(4);
		expect(isCloudWorkspaceReady(ready)).toBe(true);
	});

	it("fails immediately when the lifecycle enters a terminal failure", async () => {
		const failed = workspace(3, "failed", "offline");
		expect(cloudWorkspaceStartupError(failed)?.message).toContain("failed");
		await expect(
			waitForCloudWorkspaceReady(
				Stream.fromIterable([
					workspace(2, "resuming", "offline"),
					failed,
					workspace(4, "ready", "online"),
				]),
			),
		).rejects.toThrow("Cloud startup failed during failed.");
	});
});
