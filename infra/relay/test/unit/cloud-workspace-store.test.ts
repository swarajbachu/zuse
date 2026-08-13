import { ManagedRuntime } from "effect";
import { describe, expect, test } from "vitest";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";

const project = {
	projectId: "project-1",
	accountId: "account-1",
	repositoryIdentity: "github.com/acme/app",
	repositoryUrl: "https://github.com/acme/app.git",
	displayName: "app",
	defaultBranch: "main",
	visibility: "private" as const,
	gitConnectionKind: "github-app" as const,
	cloudEnvironment: {},
	secretBindings: [],
	configurationDigest: "digest",
	state: "ready" as const,
	idempotencyKey: "connect-1",
	createdAtMs: 100,
	updatedAtMs: 100,
};
const build = {
	buildId: "build-1",
	projectId: "project-1",
	accountId: "account-1",
	provider: "provider-a",
	snapshotId: "snapshot-1",
	templateVersion: "template-1",
	configurationDigest: "digest",
	state: "ready" as const,
	idempotencyKey: "build-key",
	nextActionAtMs: Number.MAX_SAFE_INTEGER,
	revision: 1,
	createdAtMs: 100,
	updatedAtMs: 100,
};

const startCommand = (workspaceId: string, accountId = "account-1") => ({
	workspaceId,
	accountId,
	chatId: `chat:${workspaceId}`,
	sessionId: `session:${workspaceId}`,
	turnId: `turn:${workspaceId}`,
	commandId: `launch:${workspaceId}`,
	ciphertext: "encrypted-launch-intent",
	expiresAtMs: 86_400_100,
	createdAtMs: 100,
});

describe("cloud workspace store", () => {
	test("connects repositories idempotently and leases one active workspace per branch", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		const connected = await runtime.runPromise(store.connectProject(project));
		const duplicate = await runtime.runPromise(
			store.connectProject({ ...project, projectId: "project-2" }),
		);
		expect(duplicate.projectId).toBe(connected.projectId);
		await runtime.runPromise(store.createBuild(build));
		const workspace = {
			workspaceId: "workspace-1",
			accountId: "account-1",
			projectId: project.projectId,
			buildId: build.buildId,
			provider: build.provider,
			runtimeState: "offline" as const,
			chatId: "chat-1",
			initialSessionId: "session-1",
			branch: "task/one",
			baseRef: "origin/main",
			state: "queued" as const,
			desiredState: "ready" as const,
			statusCode: "queued",
			credentialEpoch: 0,
			idempotencyKey: "workspace-key",
			requestConfig: {},
			nextActionAtMs: 100,
			revision: 0,
			createdAtMs: 100,
			updatedAtMs: 100,
			lastActivityAtMs: 100,
		};
		expect(
			(
				await runtime.runPromise(
					store.createWorkspace(workspace, startCommand(workspace.workspaceId)),
				)
			).kind,
		).toBe("created");
		expect(
			await runtime.runPromise(
				store.getLaunchIntent(workspace.workspaceId, 200),
			),
		).toMatchObject({
			workspaceId: workspace.workspaceId,
			commandId: `launch:${workspace.workspaceId}`,
		});
		expect(
			await runtime.runPromise(
				store.acknowledgeLaunchIntent(workspace.workspaceId, "launch:wrong"),
			),
		).toBe(false);
		expect(
			await runtime.runPromise(
				store.acknowledgeLaunchIntent(
					workspace.workspaceId,
					`launch:${workspace.workspaceId}`,
				),
			),
		).toBe(true);
		expect(
			await runtime.runPromise(
				store.getLaunchIntent(workspace.workspaceId, 200),
			),
		).toBeNull();
		const claimed = await runtime.runPromise(
			store.claimWorkspace(workspace.workspaceId, "worker-a", 100, 200),
		);
		expect(claimed?.leaseOwner).toBe("worker-a");
		expect(
			await runtime.runPromise(
				store.claimWorkspace(workspace.workspaceId, "worker-b", 150, 250),
			),
		).toBeNull();
		await runtime.runPromise(
			store.saveWorkspace({
				...(claimed ?? workspace),
				revision: workspace.revision + 1,
			}),
		);
		expect(
			await runtime.runPromise(
				store.claimWorkspace(workspace.workspaceId, "worker-b", 150, 250),
			),
		).toBeNull();
		expect(
			await runtime.runPromise(
				store.releaseWorkspaceLease(workspace.workspaceId, "worker-b"),
			),
		).toBe(false);
		expect(
			await runtime.runPromise(
				store.releaseWorkspaceLease(workspace.workspaceId, "worker-a"),
			),
		).toBe(true);
		expect(
			await runtime.runPromise(
				store.claimWorkspace(workspace.workspaceId, "worker-b", 150, 250),
			),
		).not.toBeNull();
		await runtime.runPromise(store.saveWorkspace(workspace));
		expect(
			(
				await runtime.runPromise(
					store.createWorkspace(
						{
							...workspace,
							workspaceId: "workspace-2",
							idempotencyKey: "other",
						},
						startCommand("workspace-2"),
					),
				)
			).kind,
		).toBe("branch-in-use");
		await runtime.runPromise(
			store.saveWorkspace({
				...workspace,
				state: "archived",
				desiredState: "archived",
			}),
		);
		expect(
			(
				await runtime.runPromise(
					store.createWorkspace(
						{
							...workspace,
							workspaceId: "workspace-2",
							idempotencyKey: "other",
						},
						startCommand("workspace-2"),
					),
				)
			).kind,
		).toBe("branch-in-use");
		await runtime.dispose();
	});

	test("deduplicates usage events", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		const event = {
			eventId: "usage-1",
			workspaceId: "workspace-1",
			accountId: "account-1",
			provider: "provider-a",
			kind: "pause",
			quantity: 1,
			occurredAtMs: 100,
		};
		expect(await runtime.runPromise(store.recordUsage(event))).toBe(true);
		expect(await runtime.runPromise(store.recordUsage(event))).toBe(false);
		await runtime.dispose();
	});

	test("enrolls runtime boot idempotently and clears it only after fenced acknowledgement", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(store.connectProject(project));
		await runtime.runPromise(store.createBuild(build));
		const workspace = {
			workspaceId: "workspace-boot",
			accountId: "account-1",
			projectId: project.projectId,
			buildId: build.buildId,
			provider: build.provider,
			providerSandboxId: "sandbox-boot",
			runtimeBootTokenHash: "boot-hash",
			runtimeBootTokenExpiresAtMs: 1_000,
			runtimeState: "offline" as const,
			chatId: "chat-boot",
			initialSessionId: "session-boot",
			branch: "task/boot",
			baseRef: "origin/main",
			state: "provisioning" as const,
			desiredState: "ready" as const,
			statusCode: "runtime-starting",
			credentialEpoch: 0,
			idempotencyKey: "workspace-boot-key",
			requestConfig: { startupTimings: { allocatedAt: 100 } },
			nextActionAtMs: 100,
			revision: 1,
			createdAtMs: 100,
			updatedAtMs: 100,
			lastActivityAtMs: 100,
		};
		await runtime.runPromise(
			store.createWorkspace(workspace, startCommand(workspace.workspaceId)),
		);
		expect(
			await runtime.runPromise(
				store.getLaunchIntent(workspace.workspaceId, 150),
			),
		).toMatchObject({ commandId: `launch:${workspace.workspaceId}` });
		const enroll = (
			overrides: Partial<Parameters<typeof store.enrollRuntimeBoot>[0]> = {},
		) =>
			runtime.runPromise(
				store.enrollRuntimeBoot({
					workspaceId: workspace.workspaceId,
					bootTokenHash: "boot-hash",
					credentialKeyThumbprint: "credential-key",
					signingKeyThumbprint: "signing-key",
					signingPublicJwk: '{"kty":"OKP"}',
					runtimeCredentialHash: "runtime-hash",
					runtimeCredentialExpiresAtMs: 10_000,
					generation: 1,
					gatewayEpoch: 1,
					cloudCredentials: [
						{
							kind: "github",
							credentialType: "repository-token",
							sealedSecret: "sealed",
							version: 1,
						},
					],
					nowMs: 200,
					...overrides,
				}),
			);
		const first = await enroll();
		expect(first).toMatchObject({
			kind: "created",
			workspace: {
				runtimeBootTokenHash: "boot-hash",
				runtimeCredentialHash: "runtime-hash",
				state: "setup",
			},
			receipt: { cloudCredentials: [{ sealedSecret: "sealed" }] },
		});
		const replay = await enroll({ nowMs: 201 });
		expect(replay).toMatchObject({
			kind: "replay",
			receipt: first?.receipt,
		});
		expect(replay?.workspace.revision).toBe(first?.workspace.revision);
		expect(
			await enroll({ credentialKeyThumbprint: "changed-credential-key" }),
		).toBeNull();
		expect(
			await enroll({ signingKeyThumbprint: "changed-signing-key" }),
		).toBeNull();
		expect(await enroll({ generation: 2 })).toBeNull();
		expect(await enroll({ gatewayEpoch: 2 })).toBeNull();
		expect(
			await runtime.runPromise(
				store.acknowledgeRuntimeBoot({
					workspaceId: workspace.workspaceId,
					currentCredentialHash: "wrong-runtime-hash",
					generation: 1,
					gatewayEpoch: 1,
					nowMs: 300,
				}),
			),
		).toBe(false);
		expect(
			await runtime.runPromise(
				store.acknowledgeRuntimeBoot({
					workspaceId: workspace.workspaceId,
					currentCredentialHash: "runtime-hash",
					generation: 1,
					gatewayEpoch: 1,
					nowMs: 300,
				}),
			),
		).toBe(true);
		expect(
			await runtime.runPromise(
				store.acknowledgeRuntimeBoot({
					workspaceId: workspace.workspaceId,
					currentCredentialHash: "runtime-hash",
					generation: 1,
					gatewayEpoch: 1,
					nowMs: 301,
				}),
			),
		).toBe(true);
		expect(
			await runtime.runPromise(store.getWorkspace(workspace.workspaceId)),
		).toMatchObject({
			runtimeBootTokenHash: undefined,
			requestConfig: {
				runtimeBootstrapReceipt: {
					acknowledgedAtMs: 300,
					cloudCredentials: [],
				},
			},
		});
		expect(
			await runtime.runPromise(
				store.getLaunchIntent(workspace.workspaceId, 301),
			),
		).toMatchObject({ commandId: `launch:${workspace.workspaceId}` });
		await runtime.dispose();
	});

	test("runtime credential renewal is atomic and response-loss safe", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(store.connectProject(project));
		await runtime.runPromise(store.createBuild(build));
		const workspace = {
			workspaceId: "workspace-renew",
			accountId: "account-1",
			projectId: project.projectId,
			buildId: build.buildId,
			provider: build.provider,
			providerSandboxId: "sandbox-renew",
			runtimeCredentialHash: "credential-old",
			runtimeState: "online" as const,
			chatId: "chat-renew",
			initialSessionId: "session-renew",
			branch: "task/renew",
			baseRef: "origin/main",
			state: "ready" as const,
			desiredState: "ready" as const,
			statusCode: "agent-running",
			credentialEpoch: 1,
			idempotencyKey: "workspace-renew-key",
			requestConfig: { runtimeCredentialExpiresAtMs: 2_000 },
			nextActionAtMs: 2_000,
			revision: 1,
			createdAtMs: 100,
			updatedAtMs: 100,
			lastActivityAtMs: 100,
		};
		await runtime.runPromise(
			store.createWorkspace(workspace, startCommand(workspace.workspaceId)),
		);
		const renew = (overrides = {}) =>
			runtime.runPromise(
				store.renewRuntimeCredential({
					workspaceId: workspace.workspaceId,
					currentCredentialHash: "credential-old",
					requestId: "renew-1",
					nextCredentialHash: "credential-new",
					expiresAtMs: 10_000,
					generation: 2,
					gatewayEpoch: 2,
					nowMs: 500,
					...overrides,
				}),
			);
		expect(await renew({ nowMs: 2_500 })).toBeNull();
		const first = await renew();
		expect(first).toMatchObject({
			requestId: "renew-1",
			credentialHash: "credential-new",
			expiresAtMs: 10_000,
		});
		// Simulate losing the first HTTP response: the same old bearer/request id
		// returns the same receipt after the atomic hash swap.
		expect(await renew()).toEqual(first);
		expect(
			await renew({
				requestId: "renew-2",
				nextCredentialHash: "credential-other",
			}),
		).toBeNull();
		expect(
			await runtime.runPromise(store.getWorkspace(workspace.workspaceId)),
		).toMatchObject({ runtimeCredentialHash: "credential-new" });
		await runtime.dispose();
	});

	test("fences runtime summaries by generation and monotonic revision", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(store.connectProject(project));
		await runtime.runPromise(store.createBuild(build));
		const workspace = {
			workspaceId: "workspace-summary",
			accountId: "account-1",
			projectId: project.projectId,
			buildId: build.buildId,
			provider: build.provider,
			runtimeState: "online" as const,
			chatId: "chat-summary",
			initialSessionId: "session-summary",
			branch: "task/summary",
			baseRef: "origin/main",
			state: "ready" as const,
			desiredState: "ready" as const,
			statusCode: "agent-running",
			credentialEpoch: 1,
			idempotencyKey: "workspace-summary-key",
			requestConfig: { runtimeGeneration: 4 },
			nextActionAtMs: 10_000,
			revision: 1,
			createdAtMs: 100,
			updatedAtMs: 100,
			lastActivityAtMs: 100,
		};
		await runtime.runPromise(
			store.createWorkspace(workspace, startCommand(workspace.workspaceId)),
		);
		const save = (overrides = {}) =>
			runtime.runPromise(
				store.saveRuntimeSummary({
					workspaceId: workspace.workspaceId,
					runtimeGeneration: 4,
					summaryRevision: 1,
					title: "Fresh title",
					lastActivityAtMs: 1_000,
					sessionHeadVersion: 8,
					updatedAtMs: 1_000,
					...overrides,
				}),
			);

		expect(await save({ runtimeGeneration: 3 })).toEqual({
			kind: "rejected-generation",
		});
		expect(await save()).toMatchObject({ kind: "applied" });
		expect(
			await save({
				title: "Regressed",
				lastActivityAtMs: 900,
				sessionHeadVersion: 7,
			}),
		).toMatchObject({
			kind: "stale",
			summary: { title: "Fresh title", sessionHeadVersion: 8 },
		});
		expect(
			await save({
				summaryRevision: 2,
				title: "Newest title",
				lastActivityAtMs: 800,
				sessionHeadVersion: 6,
				updatedAtMs: 1_100,
			}),
		).toMatchObject({
			kind: "applied",
			summary: {
				title: "Newest title",
				lastActivityAtMs: 1_000,
				sessionHeadVersion: 8,
			},
		});
		expect(
			await runtime.runPromise(store.getRuntimeSummary(workspace.workspaceId)),
		).toMatchObject({ summaryRevision: 2, title: "Newest title" });
		await runtime.dispose();
	});

	test("does not let a stale reconciler overwrite a newer workspace revision", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(store.connectProject(project));
		await runtime.runPromise(store.createBuild(build));
		const original = {
			workspaceId: "workspace-race",
			accountId: "account-1",
			projectId: project.projectId,
			buildId: build.buildId,
			provider: build.provider,
			runtimeState: "connecting" as const,
			chatId: "chat-race",
			initialSessionId: "session-race",
			branch: "task/race",
			baseRef: "origin/main",
			state: "setup" as const,
			desiredState: "ready" as const,
			statusCode: "enrollment-pending",
			credentialEpoch: 0,
			idempotencyKey: "workspace-race-key",
			requestConfig: {},
			nextActionAtMs: 100,
			revision: 2,
			createdAtMs: 100,
			updatedAtMs: 100,
			lastActivityAtMs: 100,
		};
		await runtime.runPromise(
			store.createWorkspace(original, startCommand(original.workspaceId)),
		);
		const claimed = await runtime.runPromise(
			store.claimWorkspace(original.workspaceId, "reconciler-a", 100, 1_000),
		);
		expect(claimed).not.toBeNull();
		expect(
			await runtime.runPromise(
				store.saveClaimedWorkspace({
					workspace: {
						...(claimed ?? original),
						statusCode: "reconcile-waiting",
						updatedAtMs: 150,
					},
					leaseOwner: "reconciler-b",
					expectedRevision: 2,
					expectedUpdatedAtMs: 100,
				}),
			),
		).toBe(false);
		expect(
			await runtime.runPromise(
				store.saveClaimedWorkspace({
					workspace: {
						...(claimed ?? original),
						statusCode: "reconcile-waiting",
						updatedAtMs: 150,
					},
					leaseOwner: "reconciler-a",
					expectedRevision: 1,
					expectedUpdatedAtMs: 100,
				}),
			),
		).toBe(false);
		expect(
			await runtime.runPromise(
				store.saveClaimedWorkspace({
					workspace: {
						...(claimed ?? original),
						statusCode: "reconcile-waiting",
						updatedAtMs: 150,
					},
					leaseOwner: "reconciler-a",
					expectedRevision: 2,
					expectedUpdatedAtMs: 100,
				}),
			),
		).toBe(true);
		expect(
			await runtime.runPromise(store.getWorkspace(original.workspaceId)),
		).toMatchObject({
			leaseOwner: "reconciler-a",
			statusCode: "reconcile-waiting",
			updatedAtMs: 150,
		});

		const routeUpdate = {
			...original,
			runtimeCredentialHash: "credential-new",
			runtimeState: "online" as const,
			revision: 3,
			updatedAtMs: 200,
		};
		await runtime.runPromise(store.saveWorkspace(routeUpdate));
		expect(
			await runtime.runPromise(
				store.saveClaimedWorkspace({
					workspace: {
						...original,
						statusCode: "stale-retry",
						updatedAtMs: 175,
					},
					leaseOwner: "reconciler-a",
					expectedRevision: 2,
					expectedUpdatedAtMs: 150,
				}),
			),
		).toBe(false);
		await runtime.runPromise(
			store.saveWorkspace({
				...routeUpdate,
				statusCode: "same-version-race",
			}),
		);

		expect(
			await runtime.runPromise(store.getWorkspace(original.workspaceId)),
		).toMatchObject({
			runtimeCredentialHash: "credential-new",
			runtimeState: "online",
			revision: 3,
			statusCode: "enrollment-pending",
			leaseOwner: "reconciler-a",
		});
		expect(
			await runtime.runPromise(
				store.releaseWorkspaceLease(original.workspaceId, "reconciler-a"),
			),
		).toBe(true);
		expect(
			await runtime.runPromise(
				store.claimWorkspace(original.workspaceId, "reconciler-b", 200, 300),
			),
		).not.toBeNull();
		await runtime.dispose();
	});

	test("starts fresh telemetry when workspace activity resumes a paused workspace", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(store.connectProject(project));
		await runtime.runPromise(store.createBuild(build));
		await runtime.runPromise(
			store.createWorkspace(
				{
					workspaceId: "workspace-paused",
					accountId: "account-1",
					projectId: project.projectId,
					buildId: build.buildId,
					provider: build.provider,
					runtimeState: "offline",
					chatId: "chat-paused",
					initialSessionId: "session-paused",
					branch: "task/paused",
					baseRef: "origin/main",
					state: "paused",
					desiredState: "paused",
					statusCode: "paused",
					credentialEpoch: 0,
					idempotencyKey: "workspace-paused-key",
					requestConfig: {
						startupTimings: { requestedAt: 100, agentStartedAt: 200 },
					},
					nextActionAtMs: 10_000,
					revision: 1,
					createdAtMs: 100,
					updatedAtMs: 200,
					lastActivityAtMs: 200,
				},
				startCommand("workspace-paused"),
			),
		);

		const resumed = await runtime.runPromise(
			store.recordActivity("workspace-paused", "account-1", 500, 3_600_500),
		);
		expect(resumed).toMatchObject({
			desiredState: "ready",
			statusCode: "resume-queued",
			nextActionAtMs: 500,
			requestConfig: {
				startupTimings: { requestedAt: 500, resumeRequestedAt: 500 },
			},
		});
		await runtime.dispose();
	});

	test("consumes a launch intent only after its matching receipt", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		expect(
			await runtime.runPromise(
				store.acknowledgeLaunchIntent("workspace-1", "launch:wrong"),
			),
		).toBe(false);
		await runtime.dispose();
	});

	test("expires an unconsumed launch intent into a visible failure", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(store.connectProject(project));
		await runtime.runPromise(store.createBuild(build));
		const workspace = {
			workspaceId: "workspace-expired-launch",
			accountId: "account-1",
			projectId: project.projectId,
			buildId: build.buildId,
			provider: build.provider,
			runtimeState: "offline" as const,
			chatId: "chat-expired-launch",
			initialSessionId: "session-expired-launch",
			branch: "task/expired-launch",
			baseRef: "origin/main",
			state: "queued" as const,
			desiredState: "ready" as const,
			statusCode: "provisioning-queued",
			credentialEpoch: 0,
			idempotencyKey: "workspace-expired-launch-key",
			requestConfig: {},
			nextActionAtMs: 100,
			revision: 0,
			createdAtMs: 100,
			updatedAtMs: 100,
			lastActivityAtMs: 100,
		};
		await runtime.runPromise(
			store.createWorkspace(workspace, {
				...startCommand(workspace.workspaceId),
				expiresAtMs: 200,
			}),
		);
		expect(
			await runtime.runPromise(
				store.getLaunchIntent(workspace.workspaceId, 200),
			),
		).toBeNull();
		expect(
			await runtime.runPromise(store.getWorkspace(workspace.workspaceId)),
		).toMatchObject({
			state: "failed",
			statusCode: "launch-intent-expired",
		});
		await runtime.dispose();
	});

	test("rotates and disconnects account credentials without retaining plaintext", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		const saved = await runtime.runPromise(
			store.saveCredential({
				connectionId: "credential-1",
				accountId: "account-1",
				kind: "claude",
				state: "connected",
				encryptedPayload: "encrypted-envelope",
				encryptionKeyVersion: "v1",
				credentialVersion: 1,
				createdAtMs: 100,
				updatedAtMs: 100,
			}),
		);
		expect(saved.encryptedPayload).toBe("encrypted-envelope");
		const disconnected = await runtime.runPromise(
			store.disconnectCredential("account-1", "claude", 200),
		);
		expect(disconnected).toMatchObject({
			state: "disconnected",
			credentialVersion: 2,
		});
		expect(disconnected?.encryptedPayload).toBeUndefined();
		await runtime.dispose();
	});
});
