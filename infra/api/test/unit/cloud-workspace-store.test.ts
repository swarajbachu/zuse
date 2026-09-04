import { ManagedRuntime } from "effect";
import { describe, expect, test } from "vitest";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
	mailboxLifecycleToDeliver,
	withPendingMailboxLifecycle,
	workspaceDeletionIsDurablyFenced,
	workspaceDestructionFence,
	workspaceSupportsCloudCommandMailbox,
} from "../../src/cloud-workspace-store.ts";

describe("cloud auth authority locator", () => {
	test("serializes provisioning and fences epoch changes to the located sandbox", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		const first = await runtime.runPromise(
			store.claimCloudAuthAuthority({
				accountId: "account-auth",
				provider: "e2b",
				candidateStorageIncarnationId: "incarnation-1",
				toolchainVersion: "0.144.5",
				leaseOwner: "worker-1",
				nowMs: 100,
				leaseExpiresAtMs: 200,
			}),
		);
		const contender = await runtime.runPromise(
			store.claimCloudAuthAuthority({
				accountId: "account-auth",
				provider: "e2b",
				candidateStorageIncarnationId: "incarnation-2",
				toolchainVersion: "0.144.5",
				leaseOwner: "worker-2",
				nowMs: 150,
				leaseExpiresAtMs: 250,
			}),
		);
		expect(first.acquired).toBe(true);
		expect(contender.acquired).toBe(false);
		expect(contender.record.storageIncarnationId).toBe("incarnation-1");

		const ready = await runtime.runPromise(
			store.completeCloudAuthAuthorityProvisioning({
				accountId: "account-auth",
				providerSandboxId: "sandbox-authority",
				storageIncarnationId: "incarnation-1",
				toolchainVersion: "0.144.5",
				leaseOwner: "worker-1",
				nowMs: 160,
			}),
		);
		expect(ready?.state).toBe("ready");
		const protectedReady = await runtime.runPromise(
			store.claimCloudAuthAuthority({
				accountId: "account-auth",
				provider: "e2b",
				candidateStorageIncarnationId: "incarnation-ignored",
				toolchainVersion: "0.144.5",
				leaseOwner: "worker-2",
				nowMs: 165,
				leaseExpiresAtMs: 265,
			}),
		);
		expect(protectedReady).toMatchObject({
			acquired: false,
			record: { providerSandboxId: "sandbox-authority", authEpoch: 1 },
		});
		const replacement = await runtime.runPromise(
			store.claimCloudAuthAuthority({
				accountId: "account-auth",
				provider: "e2b",
				candidateStorageIncarnationId: "incarnation-replacement",
				toolchainVersion: "0.144.5",
				leaseOwner: "worker-2",
				nowMs: 166,
				leaseExpiresAtMs: 266,
				replaceReady: true,
			}),
		);
		expect(replacement).toMatchObject({
			acquired: true,
			record: {
				state: "provisioning",
				storageIncarnationId: "incarnation-replacement",
				authEpoch: 2,
			},
		});
		expect(replacement.record.providerSandboxId).toBeUndefined();
		const replacementReady = await runtime.runPromise(
			store.completeCloudAuthAuthorityProvisioning({
				accountId: "account-auth",
				providerSandboxId: "sandbox-replacement",
				storageIncarnationId: "incarnation-replacement",
				toolchainVersion: "0.144.5",
				leaseOwner: "worker-2",
				nowMs: 168,
			}),
		);
		expect(replacementReady).toMatchObject({
			state: "ready",
			providerSandboxId: "sandbox-replacement",
			authEpoch: 2,
		});
		await expect(
			runtime.runPromise(
				store.advanceCloudAuthEpoch({
					accountId: "account-auth",
					providerSandboxId: "wrong-sandbox",
					nowMs: 170,
				}),
			),
		).resolves.toBeNull();
		await expect(
			runtime.runPromise(
				store.advanceCloudAuthEpoch({
					accountId: "account-auth",
					providerSandboxId: "sandbox-replacement",
					nowMs: 180,
				}),
			),
		).resolves.toMatchObject({ authEpoch: 3 });
		await runtime.dispose();
	});
});

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

const workspaceRecord = (workspaceId: string) => ({
	workspaceId,
	accountId: "account-1",
	projectId: project.projectId,
	buildId: build.buildId,
	provider: build.provider,
	runtimeState: "offline" as const,
	chatId: `chat-${workspaceId}`,
	initialSessionId: `session-${workspaceId}`,
	branch: `task/${workspaceId}`,
	baseRef: "origin/main",
	state: "queued" as const,
	desiredState: "ready" as const,
	statusCode: "queued",
	idempotencyKey: `key-${workspaceId}`,
	requestConfig: {},
	nextActionAtMs: 100,
	revision: 0,
	createdAtMs: 100,
	updatedAtMs: 100,
	lastActivityAtMs: 100,
});

describe("cloud workspace store", () => {
	test("soft-removes repositories and lets the same repository be added again", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(store.connectProject(project));
		expect(
			await runtime.runPromise(store.listProjects("account-1")),
		).toHaveLength(1);

		const removed = await runtime.runPromise(
			store.removeProject(project.projectId, 200),
		);
		expect(removed).toMatchObject({ included: false, updatedAtMs: 200 });
		expect(await runtime.runPromise(store.listProjects("account-1"))).toEqual(
			[],
		);

		const reconnected = await runtime.runPromise(
			store.connectProject({
				...project,
				projectId: "project-reconnected",
				idempotencyKey: "connect-2",
				updatedAtMs: 300,
			}),
		);
		expect(reconnected.projectId).toBe(project.projectId);
		expect(reconnected.included).not.toBe(false);
		expect(
			await runtime.runPromise(store.listProjects("account-1")),
		).toHaveLength(1);
		await runtime.dispose();
	});

	test("retains destructive mailbox lifecycle work until delivery is acknowledged", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(store.connectProject(project));
		await runtime.runPromise(store.createBuild(build));
		const workspace = {
			workspaceId: "workspace-lifecycle-outbox",
			accountId: "account-1",
			projectId: project.projectId,
			buildId: build.buildId,
			provider: build.provider,
			runtimeState: "offline" as const,
			chatId: "chat-lifecycle-outbox",
			initialSessionId: "session-lifecycle-outbox",
			branch: "task/lifecycle-outbox",
			baseRef: "origin/main",
			state: "queued" as const,
			desiredState: "archived" as const,
			statusCode: "archive-queued",
			idempotencyKey: "workspace-lifecycle-outbox-key",
			requestConfig: withPendingMailboxLifecycle({}, "archive", 3),
			nextActionAtMs: 100,
			revision: 1,
			createdAtMs: 100,
			updatedAtMs: 100,
			lastActivityAtMs: 100,
		};
		await runtime.runPromise(
			store.createWorkspace(workspace, startCommand(workspace.workspaceId)),
		);

		const [pending] = await runtime.runPromise(
			store.listPendingMailboxLifecycles(10),
		);
		expect(pending).toEqual({
			workspaceId: workspace.workspaceId,
			action: "archive",
			destructionFence: 3,
		});
		if (pending === undefined)
			throw new Error("lifecycle fence was not queued");
		expect(
			await runtime.runPromise(
				store.acknowledgeMailboxLifecycle(
					{ ...pending, destructionFence: 2 },
					200,
				),
			),
		).toBe(false);
		expect(
			await runtime.runPromise(store.acknowledgeMailboxLifecycle(pending, 200)),
		).toBe(true);
		expect(
			await runtime.runPromise(store.listPendingMailboxLifecycles(10)),
		).toEqual([]);
		expect(
			(await runtime.runPromise(store.getWorkspace(workspace.workspaceId)))
				?.requestConfig,
		).toMatchObject({
			destructionFence: 3,
			cloudMailboxLifecycleDelivered: {
				action: "archive",
				destructionFence: 3,
			},
		});
		await runtime.dispose();
	});

	test("serializes competing lifecycle commands and makes delete irreversible", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(store.connectProject(project));
		await runtime.runPromise(store.createBuild(build));
		const workspace = workspaceRecord("workspace-lifecycle-race");
		await runtime.runPromise(
			store.createWorkspace(workspace, startCommand(workspace.workspaceId)),
		);
		const expected = {
			expectedRevision: workspace.revision,
			expectedUpdatedAtMs: workspace.updatedAtMs,
			expectedState: workspace.state,
			expectedDesiredState: workspace.desiredState,
			createdAtMs: 200,
		};
		const [archive, deletion] = await Promise.all([
			runtime.runPromise(
				store.transitionWorkspaceLifecycle({
					...expected,
					workspace: {
						...workspace,
						desiredState: "archived",
						statusCode: "archive-queued",
					},
					commandId: "archive-race",
					action: "archive",
				}),
			),
			runtime.runPromise(
				store.transitionWorkspaceLifecycle({
					...expected,
					workspace: {
						...workspace,
						desiredState: "deleted",
						statusCode: "delete-queued",
					},
					commandId: "delete-race",
					action: "delete",
				}),
			),
		]);
		expect([archive.kind, deletion.kind].sort()).toEqual([
			"applied",
			"contended",
		]);

		let current = await runtime.runPromise(
			store.getWorkspace(workspace.workspaceId),
		);
		if (current === null) throw new Error("workspace disappeared during race");
		if (current.desiredState !== "deleted") {
			const retry = await runtime.runPromise(
				store.transitionWorkspaceLifecycle({
					workspace: {
						...current,
						desiredState: "deleted",
						statusCode: "delete-queued",
					},
					expectedRevision: current.revision,
					expectedUpdatedAtMs: current.updatedAtMs,
					expectedState: current.state,
					expectedDesiredState: current.desiredState,
					commandId: "delete-race",
					action: "delete",
					createdAtMs: 201,
				}),
			);
			expect(retry.kind).toBe("applied");
			current = await runtime.runPromise(
				store.getWorkspace(workspace.workspaceId),
			);
			if (current === null)
				throw new Error("deleted workspace tombstone missing");
		}
		expect(current.desiredState).toBe("deleted");
		expect(mailboxLifecycleToDeliver(current)).toMatchObject({
			action: "delete",
			destructionFence: expect.any(Number),
		});
		await runtime.runPromise(
			store.saveWorkspace({
				...workspace,
				revision: current.revision + 1,
				updatedAtMs: current.updatedAtMs + 1,
			}),
		);
		current = await runtime.runPromise(
			store.getWorkspace(workspace.workspaceId),
		);
		if (current === null)
			throw new Error("delete fence was removed by stale save");
		expect(current.desiredState).toBe("deleted");
		expect(mailboxLifecycleToDeliver(current)?.action).toBe("delete");

		const regressed = await runtime.runPromise(
			store.transitionWorkspaceLifecycle({
				workspace: {
					...current,
					desiredState: "archived",
					statusCode: "archive-queued",
				},
				expectedRevision: current.revision,
				expectedUpdatedAtMs: current.updatedAtMs,
				expectedState: current.state,
				expectedDesiredState: current.desiredState,
				commandId: "archive-after-delete",
				action: "archive",
				createdAtMs: 202,
			}),
		);
		expect(regressed).toMatchObject({
			kind: "rejected",
			reason: "workspace-deleted",
		});
		await runtime.dispose();
	});

	test("atomically receipts an already-requested resume without rewriting it", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(store.connectProject(project));
		await runtime.runPromise(store.createBuild(build));
		const workspace = {
			...workspaceRecord("workspace-resume-receipt"),
			state: "paused" as const,
			desiredState: "ready" as const,
			statusCode: "resume-queued",
			revision: 4,
			updatedAtMs: 200,
		};
		await runtime.runPromise(
			store.createWorkspace(workspace, startCommand(workspace.workspaceId)),
		);
		const input = {
			workspace: { ...workspace, statusCode: "resume-queued" },
			expectedRevision: workspace.revision,
			expectedUpdatedAtMs: workspace.updatedAtMs,
			expectedState: workspace.state,
			expectedDesiredState: workspace.desiredState,
			commandId: "resume-receipt",
			action: "resume" as const,
			deduplicateRequestedResume: true,
			createdAtMs: 300,
		};
		expect(
			await runtime.runPromise(store.transitionWorkspaceLifecycle(input)),
		).toMatchObject({
			kind: "applied",
			workspace: { revision: 4, updatedAtMs: 200 },
		});
		expect(
			await runtime.runPromise(store.transitionWorkspaceLifecycle(input)),
		).toMatchObject({ kind: "replay", action: "resume" });
		expect(
			await runtime.runPromise(
				store.transitionWorkspaceLifecycle({
					...input,
					action: "pause",
				}),
			),
		).toMatchObject({ kind: "rejected", reason: "command-id-reused" });
		await runtime.dispose();
	});

	test("retains account rows until the delete fence is acknowledged", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(store.connectProject(project));
		await runtime.runPromise(store.createBuild(build));
		const workspace = workspaceRecord("workspace-account-delete");
		await runtime.runPromise(
			store.createWorkspace(workspace, startCommand(workspace.workspaceId)),
		);
		const transition = await runtime.runPromise(
			store.transitionWorkspaceLifecycle({
				workspace: {
					...workspace,
					desiredState: "deleted",
					statusCode: "delete-queued",
				},
				expectedRevision: workspace.revision,
				expectedUpdatedAtMs: workspace.updatedAtMs,
				expectedState: workspace.state,
				expectedDesiredState: workspace.desiredState,
				action: "delete",
				createdAtMs: 200,
			}),
		);
		expect(transition.kind).toBe("applied");
		expect(await runtime.runPromise(store.deleteAccountData("account-1"))).toBe(
			false,
		);
		const [pending] = await runtime.runPromise(
			store.listPendingMailboxLifecycles(10),
		);
		if (pending === undefined) throw new Error("delete fence was not retained");
		await runtime.runPromise(store.acknowledgeMailboxLifecycle(pending, 300));
		const acknowledged = await runtime.runPromise(
			store.getWorkspace(workspace.workspaceId),
		);
		if (acknowledged === null) throw new Error("workspace tombstone missing");
		await runtime.runPromise(
			store.saveWorkspace({
				...acknowledged,
				state: "deleted",
				revision: acknowledged.revision + 1,
				updatedAtMs: acknowledged.updatedAtMs + 1,
			}),
		);
		const deleted = await runtime.runPromise(
			store.getWorkspace(workspace.workspaceId),
		);
		expect(
			deleted === null ? false : workspaceDeletionIsDurablyFenced(deleted),
		).toBe(true);
		expect(await runtime.runPromise(store.deleteAccountData("account-1"))).toBe(
			true,
		);
		expect(
			await runtime.runPromise(store.getWorkspace(workspace.workspaceId)),
		).toBeNull();
		await runtime.dispose();
	});

	test("claims one warm sandbox atomically and leaves other generations alone", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		for (const [poolId, generation] of [
			["pool-current-a", "image-2"],
			["pool-current-b", "image-2"],
			["pool-stale", "image-1"],
		] as const)
			await runtime.runPromise(
				store.savePool({
					poolId,
					accountId: "account-1",
					provider: "e2b",
					imageGeneration: generation,
					providerSandboxId: `sandbox-${poolId}`,
					state: "available",
					createdAtMs: 100,
					updatedAtMs: 100,
				}),
			);

		const [first, second, empty] = await Promise.all([
			runtime.runPromise(
				store.claimPool("account-1", "e2b", "image-2", "workspace-a", 200),
			),
			runtime.runPromise(
				store.claimPool("account-1", "e2b", "image-2", "workspace-b", 200),
			),
			runtime.runPromise(
				store.claimPool("account-1", "e2b", "missing", "workspace-c", 200),
			),
		]);

		expect(
			new Set([first?.claimedWorkspaceId, second?.claimedWorkspaceId]),
		).toEqual(new Set(["workspace-a", "workspace-b"]));
		expect(first?.poolId).not.toBe(second?.poolId);
		expect(empty).toBeNull();
		expect(
			(await runtime.runPromise(store.listPool("account-1", "e2b"))).find(
				(item) => item.poolId === "pool-stale",
			)?.state,
		).toBe("available");
		await runtime.dispose();
	});

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
		const archive = {
			workspace: {
				...workspace,
				desiredState: "archived" as const,
				statusCode: "archive-queued",
			},
			expectedRevision: workspace.revision,
			expectedUpdatedAtMs: workspace.updatedAtMs,
			expectedState: workspace.state,
			expectedDesiredState: workspace.desiredState,
			commandId: "archive-command-1",
			action: "archive" as const,
			createdAtMs: 200,
		};
		expect(
			await runtime.runPromise(store.transitionWorkspaceLifecycle(archive)),
		).toMatchObject({ kind: "applied", action: "archive" });
		expect(
			await runtime.runPromise(store.transitionWorkspaceLifecycle(archive)),
		).toMatchObject({ kind: "replay", action: "archive" });
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
					sealedTranscriptKey: "sealed-transcript-key",
					nowMs: 200,
					...overrides,
				}),
			);
		const first = await enroll();
		expect(first).toMatchObject({
			kind: "created",
			launchIntent: { commandId: `launch:${workspace.workspaceId}` },
			workspace: {
				runtimeBootTokenHash: "boot-hash",
				runtimeCredentialHash: "runtime-hash",
				state: "setup",
			},
			receipt: { sealedTranscriptKey: "sealed-transcript-key" },
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
				store.markRuntimeRepositoryReady({
					workspaceId: workspace.workspaceId,
					currentCredentialHash: "wrong-runtime-hash",
					nowMs: 220,
					nextIdleAtMs: 2_000,
				}),
			),
		).toBeNull();
		const repositoryReady = await runtime.runPromise(
			store.markRuntimeRepositoryReady({
				workspaceId: workspace.workspaceId,
				currentCredentialHash: "runtime-hash",
				commandProtocolVersion: 3,
				nowMs: 220,
				nextIdleAtMs: 2_000,
			}),
		);
		expect(repositoryReady).toMatchObject({
			runtimeState: "online",
			state: "setup",
			statusCode: "agent-starting",
			requestConfig: {
				cloudCommandProtocolVersion: 3,
				cloudCommandRuntimeGeneration: 1,
				startupTimings: { connectedAt: 220, repositoryReadyAt: 220 },
			},
		});
		expect(
			repositoryReady === null
				? false
				: workspaceSupportsCloudCommandMailbox(repositoryReady),
		).toBe(true);
		expect(
			repositoryReady === null
				? true
				: workspaceSupportsCloudCommandMailbox({
						...repositoryReady,
						requestConfig: {
							...repositoryReady.requestConfig,
							runtimeGeneration: 2,
						},
					}),
		).toBe(false);
		const retainedV2Runtime = await runtime.runPromise(
			store.markRuntimeRepositoryReady({
				workspaceId: workspace.workspaceId,
				currentCredentialHash: "runtime-hash",
				nowMs: 221,
				nextIdleAtMs: 2_000,
			}),
		);
		expect(retainedV2Runtime?.requestConfig).not.toHaveProperty(
			"cloudCommandProtocolVersion",
		);
		expect(
			retainedV2Runtime === null
				? true
				: workspaceSupportsCloudCommandMailbox(retainedV2Runtime),
		).toBe(false);
		const checkpoint = {
			workspaceId: workspace.workspaceId,
			sessionId: workspace.initialSessionId,
			runtimeGeneration: 1,
			streamEpoch: "epoch-1",
			streamVersion: 5,
			objectKey: "checkpoint-5",
			ciphertextSha256: "hash-5",
			ciphertextBytes: 100,
			createdAtMs: 250,
		};
		expect(
			await runtime.runPromise(store.saveTranscriptCheckpoint(checkpoint)),
		).toBe(true);
		expect(
			await runtime.runPromise(
				store.saveTranscriptCheckpoint({
					...checkpoint,
					streamVersion: 4,
					objectKey: "checkpoint-4",
				}),
			),
		).toBe(false);
		expect(
			await runtime.runPromise(
				store.saveTranscriptCheckpoint({
					...checkpoint,
					streamEpoch: "stale-epoch",
					streamVersion: 6,
				}),
			),
		).toBe(false);
		expect(
			await runtime.runPromise(
				store.saveTranscriptCheckpoint({
					...checkpoint,
					runtimeGeneration: 2,
					streamVersion: 6,
				}),
			),
		).toBe(false);
		expect(
			await runtime.runPromise(
				store.getTranscriptCheckpoint(
					workspace.workspaceId,
					workspace.initialSessionId,
				),
			),
		).toMatchObject({ streamVersion: 5, objectKey: "checkpoint-5" });
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
				runtimeBootstrapReceipt: { acknowledgedAtMs: 300 },
			},
		});
		expect(
			await runtime.runPromise(
				store.getLaunchIntent(workspace.workspaceId, 301),
			),
		).toMatchObject({ commandId: `launch:${workspace.workspaceId}` });
		const currentWorkspace = await runtime.runPromise(
			store.getWorkspace(workspace.workspaceId),
		);
		expect(currentWorkspace).not.toBeNull();
		if (currentWorkspace === null) throw new Error("Workspace disappeared");
		await runtime.runPromise(
			store.saveWorkspace({
				...currentWorkspace,
				requestConfig: {
					...currentWorkspace.requestConfig,
					runtimeGeneration: 2,
				},
				revision: currentWorkspace.revision + 1,
				updatedAtMs: currentWorkspace.updatedAtMs + 1,
			}),
		);
		expect(
			await runtime.runPromise(
				store.saveTranscriptCheckpoint({
					...checkpoint,
					runtimeGeneration: 2,
					streamEpoch: "epoch-2",
					streamVersion: 1,
					objectKey: "empty-recovery-checkpoint",
				}),
			),
		).toBe(false);
		expect(
			await runtime.runPromise(
				store.getTranscriptCheckpoint(
					workspace.workspaceId,
					workspace.initialSessionId,
				),
			),
		).toMatchObject({ streamVersion: 5, objectKey: "checkpoint-5" });
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

	test("mailbox wake reverses an in-flight pause but never a destructive fence", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(store.connectProject(project));
		await runtime.runPromise(store.createBuild(build));
		for (const [workspaceId, state, desiredState] of [
			["workspace-pausing", "pausing", "paused"],
			["workspace-archiving", "archiving", "archived"],
			["workspace-ready-offline", "ready", "ready"],
		] as const) {
			await runtime.runPromise(
				store.createWorkspace(
					{
						workspaceId,
						accountId: "account-1",
						projectId: project.projectId,
						buildId: build.buildId,
						provider: build.provider,
						runtimeState: "offline",
						chatId: `chat:${workspaceId}`,
						initialSessionId: `session:${workspaceId}`,
						branch: `task/${workspaceId}`,
						baseRef: "origin/main",
						state,
						desiredState,
						statusCode: state,
						idempotencyKey: `${workspaceId}-key`,
						requestConfig: {},
						nextActionAtMs: 10_000,
						revision: 1,
						createdAtMs: 100,
						updatedAtMs: 200,
						lastActivityAtMs: 200,
					},
					startCommand(workspaceId),
				),
			);
		}
		await runtime.runPromise(
			store.createWorkspace(
				{
					workspaceId: "workspace-ready-online",
					accountId: "account-1",
					projectId: project.projectId,
					buildId: build.buildId,
					provider: build.provider,
					runtimeState: "online",
					chatId: "chat:workspace-ready-online",
					initialSessionId: "session:workspace-ready-online",
					branch: "task/workspace-ready-online",
					baseRef: "origin/main",
					state: "ready",
					desiredState: "ready",
					statusCode: "agent-running",
					idempotencyKey: "workspace-ready-online-key",
					requestConfig: {},
					nextActionAtMs: 10_000,
					revision: 1,
					createdAtMs: 100,
					updatedAtMs: 200,
					lastActivityAtMs: 200,
				},
				startCommand("workspace-ready-online"),
			),
		);
		await runtime.runPromise(
			store.createWorkspace(
				{
					...workspaceRecord("workspace-stale-delete-fence"),
					state: "ready",
					desiredState: "ready",
					runtimeState: "online",
					requestConfig: {
						destructionFence: 2,
						cloudMailboxLifecycleDelivered: {
							action: "delete",
							destructionFence: 3,
						},
					},
				},
				startCommand("workspace-stale-delete-fence"),
			),
		);

		const resumed = await runtime.runPromise(
			store.requestMailboxWake(
				"workspace-pausing",
				"account-1",
				500,
				3_600_500,
			),
		);
		expect(resumed).toMatchObject({
			desiredState: "ready",
			statusCode: "resume-queued",
			nextActionAtMs: 500,
		});
		expect(
			await runtime.runPromise(
				store.requestMailboxWake(
					"workspace-ready-offline",
					"account-1",
					500,
					3_600_500,
				),
			),
		).toMatchObject({
			desiredState: "ready",
			statusCode: "resume-queued",
			nextActionAtMs: 500,
			requestConfig: {
				startupTimings: { requestedAt: 500, resumeRequestedAt: 500 },
			},
		});
		const onlineWake = await runtime.runPromise(
			store.requestMailboxWake(
				"workspace-ready-online",
				"account-1",
				500,
				3_600_500,
			),
		);
		expect(onlineWake).toMatchObject({
			nextActionAtMs: 500,
			requestConfig: {
				cloudMailboxWakePending: true,
				cloudMailboxWakeRequestedAt: 500,
			},
		});
		if (onlineWake === null) throw new Error("mailbox wake was not recorded");
		const pauseDuringDrain = await runtime.runPromise(
			store.transitionWorkspaceLifecycle({
				workspace: {
					...onlineWake,
					desiredState: "paused",
					statusCode: "pause-queued",
					nextActionAtMs: 550,
					revision: onlineWake.revision + 1,
					updatedAtMs: 550,
				},
				expectedRevision: onlineWake.revision,
				expectedUpdatedAtMs: onlineWake.updatedAtMs,
				expectedState: onlineWake.state,
				expectedDesiredState: onlineWake.desiredState,
				commandId: "pause-after-mailbox-acceptance",
				action: "pause",
				createdAtMs: 550,
			}),
		);
		expect(pauseDuringDrain).toMatchObject({
			kind: "rejected",
			reason: "mailbox-wake-pending",
			workspace: {
				desiredState: "ready",
				nextActionAtMs: 500,
				requestConfig: { cloudMailboxWakePending: true },
			},
		});
		expect(
			await runtime.runPromise(store.getWorkspace("workspace-ready-online")),
		).toMatchObject({
			desiredState: "ready",
			nextActionAtMs: 500,
			requestConfig: { cloudMailboxWakePending: true },
		});
		expect(
			await runtime.runPromise(
				store.recordActivity(
					"workspace-ready-online",
					"account-1",
					550,
					3_600_550,
				),
			),
		).toMatchObject({
			nextActionAtMs: 500,
			requestConfig: { cloudMailboxWakePending: true },
		});
		expect(
			await runtime.runPromise(
				store.recordMailboxRuntimePoll(
					"workspace-ready-online",
					"account-1",
					1,
					600,
					35_600,
				),
			),
		).toBe(1);
		expect(
			await runtime.runPromise(store.getWorkspace("workspace-ready-online")),
		).toMatchObject({
			nextActionAtMs: 35_600,
			requestConfig: {
				cloudMailboxWakePending: true,
				cloudMailboxWakeRevision: 1,
				cloudMailboxRuntimeSeenAt: 600,
			},
		});
		// Empty polls prove the consumer exists but are not progress: sliding this
		// deadline would strand a lease whose response was lost.
		expect(
			await runtime.runPromise(
				store.recordMailboxRuntimePoll(
					"workspace-ready-online",
					"account-1",
					1,
					700,
					35_700,
				),
			),
		).toBe(1);
		expect(
			await runtime.runPromise(store.getWorkspace("workspace-ready-online")),
		).toMatchObject({
			nextActionAtMs: 35_600,
			requestConfig: { cloudMailboxRuntimeSeenAt: 600 },
		});
		expect(
			await runtime.runPromise(
				store.recordMailboxRuntimeProgress(
					"workspace-ready-online",
					"account-1",
					1,
					1,
					10,
					false,
					800,
					35_800,
				),
			),
		).toBe(true);
		expect(
			await runtime.runPromise(
				store.requestMailboxWake(
					"workspace-ready-online",
					"account-1",
					900,
					3_600_900,
				),
			),
		).toMatchObject({
			nextActionAtMs: 900,
			requestConfig: {
				cloudMailboxWakeRevision: 2,
				cloudMailboxProgressRevision: 10,
			},
		});
		// An older empty lease response cannot clear the newer accepted wake.
		expect(
			await runtime.runPromise(
				store.completeMailboxDrain(
					"workspace-ready-online",
					"account-1",
					1,
					1,
					950,
					3_600_950,
				),
			),
		).toBe(false);
		expect(
			await runtime.runPromise(
				store.recordMailboxRuntimeProgress(
					"workspace-ready-online",
					"account-1",
					1,
					2,
					11,
					true,
					960,
					35_960,
				),
			),
		).toBe(true);
		await runtime.runPromise(
			store.recordMailboxRuntimeProgress(
				"workspace-ready-online",
				"account-1",
				1,
				2,
				12,
				false,
				970,
				35_970,
			),
		);
		expect(
			await runtime.runPromise(store.getWorkspace("workspace-ready-online")),
		).toMatchObject({
			nextActionAtMs: 960,
			requestConfig: {
				cloudMailboxFenceRequired: true,
				cloudMailboxProgressRevision: 11,
			},
		});
		expect(
			await runtime.runPromise(
				store.completeMailboxDrain(
					"workspace-ready-online",
					"account-1",
					1,
					2,
					1_000,
					3_601_000,
				),
			),
		).toBe(true);
		expect(
			await runtime.runPromise(store.getWorkspace("workspace-ready-online")),
		).toMatchObject({
			nextActionAtMs: 3_601_000,
			requestConfig: { cloudMailboxWakeRevision: 2 },
		});
		expect(
			await runtime.runPromise(
				store.recordMailboxRuntimePoll(
					"workspace-ready-online",
					"account-1",
					1,
					1_100,
					36_100,
				),
			),
		).toBeNull();
		await expect(
			runtime.runPromise(
				store.requestMailboxWake(
					"workspace-archiving",
					"account-1",
					500,
					3_600_500,
				),
			),
		).resolves.toBeNull();
		const staleDelete = await runtime.runPromise(
			store.getWorkspace("workspace-stale-delete-fence"),
		);
		expect(
			staleDelete === null ? 0 : workspaceDestructionFence(staleDelete),
		).toBe(3);
		await expect(
			runtime.runPromise(
				store.requestMailboxWake(
					"workspace-stale-delete-fence",
					"account-1",
					500,
					3_600_500,
				),
			),
		).resolves.toBeNull();
		await expect(
			runtime.runPromise(
				store.recordActivity(
					"workspace-stale-delete-fence",
					"account-1",
					500,
					3_600_500,
				),
			),
		).resolves.toBeNull();
		await runtime.dispose();
	});

	test("consumes a launch intent only after its matching receipt", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(store.connectProject(project));
		await runtime.runPromise(store.createBuild(build));
		const workspace = {
			workspaceId: "workspace-launch-completion",
			accountId: "account-1",
			projectId: project.projectId,
			buildId: build.buildId,
			provider: build.provider,
			runtimeState: "online" as const,
			chatId: "chat-launch-completion",
			initialSessionId: "session-launch-completion",
			branch: "task/launch-completion",
			baseRef: "origin/main",
			state: "ready" as const,
			desiredState: "ready" as const,
			statusCode: "agent-starting",
			idempotencyKey: "workspace-launch-completion-key",
			requestConfig: { startupTimings: { requestedAt: 100 } },
			nextActionAtMs: 100,
			revision: 2,
			createdAtMs: 100,
			updatedAtMs: 200,
			lastActivityAtMs: 200,
		};
		await runtime.runPromise(
			store.createWorkspace(workspace, startCommand(workspace.workspaceId)),
		);
		expect(
			await runtime.runPromise(
				store.completeLaunchIntent({
					workspaceId: workspace.workspaceId,
					commandId: "launch:wrong",
					sessionHeadVersion: 15,
					nowMs: 300,
					nextActionAtMs: 10_000,
				}),
			),
		).toEqual({ kind: "rejected" });
		const completed = await runtime.runPromise(
			store.completeLaunchIntent({
				workspaceId: workspace.workspaceId,
				commandId: `launch:${workspace.workspaceId}`,
				sessionHeadVersion: 15,
				nowMs: 300,
				nextActionAtMs: 10_000,
			}),
		);
		expect(completed).toMatchObject({
			kind: "completed",
			workspace: {
				statusCode: "agent-running",
				requestConfig: { sessionHeadVersion: 15 },
			},
		});
		expect(
			await runtime.runPromise(
				store.getLaunchIntent(workspace.workspaceId, 400),
			),
		).toBeNull();
		const replay = await runtime.runPromise(
			store.completeLaunchIntent({
				workspaceId: workspace.workspaceId,
				commandId: `launch:${workspace.workspaceId}`,
				sessionHeadVersion: 15,
				nowMs: 400,
				nextActionAtMs: 10_000,
			}),
		);
		expect(replay).toMatchObject({
			kind: "completed",
			workspace: { statusCode: "agent-running" },
		});
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
});
