import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	decodeRuntimeSummary,
	publicCloudWorkspaceSummary,
	runtimeActivityLifecycle,
} from "../../src/cloud-workspace-routes.ts";

describe("cloud workspace runtime ready status", () => {
	it("accepts only the metadata-only runtime summary route body", async () => {
		const valid = await Effect.runPromise(
			decodeRuntimeSummary(
				new Request("https://api.test/runtime/summary", {
					method: "POST",
					body: JSON.stringify({
						summaryRevision: 3,
						title: "Current title",
						lastActivityAt: 1_000,
						sessionHeadVersion: 9,
					}),
				}),
			),
		);
		expect(valid).toMatchObject({
			summaryRevision: 3,
			title: "Current title",
			sessionHeadVersion: 9,
		});

		const contentResult = await Effect.runPromiseExit(
			decodeRuntimeSummary(
				new Request("https://api.test/runtime/summary", {
					method: "POST",
					body: JSON.stringify({
						summaryRevision: 4,
						title: "Current title",
						lastActivityAt: 1_000,
						sessionHeadVersion: 10,
						messages: [{ content: "private transcript" }],
					}),
				}),
			),
		);
		expect(contentResult._tag).toBe("Failure");
	});

	it("publishes lifecycle metadata without archive diagnostics or launch content", () => {
		const summary = publicCloudWorkspaceSummary(
			{
				workspaceId: "workspace-1",
				accountId: "account-1",
				projectId: "project-1",
				buildId: "build-1",
				provider: "fake",
				runtimeState: "offline",
				chatId: "chat-1",
				initialSessionId: "session-1",
				branch: "zuse/workspace-1",
				baseRef: "origin/main",
				state: "failed",
				desiredState: "archived",
				statusCode: "archive-failed",
				idempotencyKey: "workspace-key",
				requestConfig: {
					title: "Public title",
					agent: "codex",
					model: "gpt-5",
					runtimeMode: "full-access",
					firstMessage: "private prompt",
				},
				nextActionAtMs: 1,
				revision: 4,
				createdAtMs: 1,
				updatedAtMs: 2,
				lastActivityAtMs: 2,
			},
			{
				projectId: "project-1",
				accountId: "account-1",
				repositoryIdentity: "github.com/acme/app",
				repositoryUrl: "https://github.com/acme/app.git",
				displayName: "app",
				defaultBranch: "main",
				visibility: "private",
				gitConnectionKind: "github-app",
				cloudEnvironment: {},
				secretBindings: [],
				configurationDigest: "digest",
				state: "ready",
				idempotencyKey: "project-key",
				createdAtMs: 1,
				updatedAtMs: 1,
			},
			false,
			2,
		);
		expect(summary).toMatchObject({
			workspaceId: "workspace-1",
			title: "Public title",
			runtimeMode: "full-access",
		});
		expect(summary).not.toHaveProperty("firstMessage");
		expect(JSON.stringify(summary)).not.toContain("private");
	});

	it("publishes an acknowledged warm resume as fully running", () => {
		const summary = publicCloudWorkspaceSummary(
			{
				workspaceId: "workspace-1",
				accountId: "account-1",
				projectId: "project-1",
				buildId: "build-1",
				provider: "fake",
				state: "ready",
				desiredState: "ready",
				runtimeState: "online",
				statusCode: "agent-running",
				chatId: "chat-1",
				initialSessionId: "session-1",
				branch: "zuse/workspace-1",
				baseRef: "origin/main",
				idempotencyKey: "workspace-key",
				requestConfig: {
					title: "Warm workspace",
					agent: "codex",
					model: "gpt-5",
					startupTimings: { repositoryReadyAt: 2 },
				},
				nextActionAtMs: 3,
				revision: 2,
				createdAtMs: 1,
				updatedAtMs: 2,
				lastActivityAtMs: 2,
			},
			{
				projectId: "project-1",
				accountId: "account-1",
				repositoryIdentity: "github.com/acme/app",
				repositoryUrl: "https://github.com/acme/app.git",
				displayName: "app",
				defaultBranch: "main",
				visibility: "private",
				gitConnectionKind: "github-app",
				cloudEnvironment: {},
				secretBindings: [],
				configurationDigest: "digest",
				state: "ready",
				idempotencyKey: "project-key",
				createdAtMs: 1,
				updatedAtMs: 1,
			},
			false,
			null,
		);

		expect(summary.startupPhase).toBe("running");
	});

	it("treats authenticated runtime traffic as a successful warm resume", () => {
		expect(
			runtimeActivityLifecycle({
				state: "resuming",
				desiredState: "ready",
				runtimeState: "connecting",
				statusCode: "resume-runtime-waking",
			}),
		).toEqual({
			state: "ready",
			runtimeState: "online",
			statusCode: "agent-running",
		});
		expect(
			runtimeActivityLifecycle({
				state: "provisioning",
				desiredState: "ready",
				runtimeState: "offline",
				statusCode: "resume-runtime-restarting",
			}),
		).toEqual({
			state: "ready",
			runtimeState: "online",
			statusCode: "agent-running",
		});
	});
});
