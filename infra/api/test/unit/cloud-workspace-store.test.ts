import { ManagedRuntime } from "effect";
import { describe, expect, test } from "vitest";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
	mailboxLifecycleToDeliver,
	withPendingMailboxLifecycle,
	workspaceAcceptsCloudCommandMailbox,
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

	test("atomically guards an API append with its workspace resume", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(store.connectProject(project));
		await runtime.runPromise(store.createBuild(build));
		const pausedWorkspace = {
			workspaceId: "workspace-guarded-append",
			accountId: "account-1",
			projectId: project.projectId,
			buildId: build.buildId,
			provider: build.provider,
			runtimeState: "offline" as const,
			chatId: "chat-guarded-append",
			initialSessionId: "session-guarded-append",
			branch: "task/guarded-append",
			baseRef: "origin/main",
			state: "paused" as const,
			desiredState: "paused" as const,
			statusCode: "paused",
			idempotencyKey: "workspace-guarded-append-key",
			requestConfig: {},
			nextActionAtMs: 10_000,
			revision: 1,
			createdAtMs: 100,
			updatedAtMs: 200,
			lastActivityAtMs: 200,
		};
		await runtime.runPromise(
			store.createWorkspace(
				pausedWorkspace,
				startCommand(pausedWorkspace.workspaceId),
			),
		);
		await runtime.runPromise(
			store.appendApiMessage({
				messageId: "message-assistant-before-user",
				workspaceId: pausedWorkspace.workspaceId,
				accountId: pausedWorkspace.accountId,
				role: "assistant",
				sealedContent: "sealed:assistant",
				turnId: "turn-guarded-append",
				status: "settled",
				createdAtMs: 250,
			}),
		);
		const resumedWorkspace = {
			...pausedWorkspace,
			desiredState: "ready" as const,
			statusCode: "resume-queued",
			nextActionAtMs: 300,
			revision: 2,
			updatedAtMs: 300,
		};
		const userMessage = {
			messageId: "message-guarded-user",
			workspaceId: pausedWorkspace.workspaceId,
			accountId: pausedWorkspace.accountId,
			role: "user" as const,
			sealedContent: "sealed:user",
			commandId: "api-command-guarded",
			turnId: "turn-guarded-append",
			status: "delivered" as const,
			createdAtMs: 300,
		};
		const committed = await runtime.runPromise(
			store.appendApiMessageGuarded({
				message: userMessage,
				expectedWorkspace: pausedWorkspace,
				lifecycleCommand: {
					workspace: resumedWorkspace,
					commandId: "resume-for-api-command",
					action: "resume",
					createdAtMs: 300,
				},
			}),
		);
		expect(committed).toMatchObject({
			kind: "committed",
			append: {
				kind: "created",
				message: { seq: 2, status: "settled" },
			},
			workspace: { revision: 2, statusCode: "resume-queued" },
			lifecycleCommandSaved: true,
		});
		expect(
			await runtime.runPromise(
				store.getWorkspaceLifecycleCommand(
					pausedWorkspace.workspaceId,
					"resume-for-api-command",
				),
			),
		).toBe("resume");

		const stale = await runtime.runPromise(
			store.appendApiMessageGuarded({
				message: {
					...userMessage,
					messageId: "message-stale-guard",
					turnId: undefined,
					status: "pending",
				},
				expectedWorkspace: pausedWorkspace,
				lifecycleCommand: {
					workspace: {
						...resumedWorkspace,
						revision: 3,
						updatedAtMs: 400,
					},
					commandId: "stale-resume-for-api-command",
					action: "resume",
					createdAtMs: 400,
				},
			}),
		);
		expect(stale).toMatchObject({
			kind: "workspace-contended",
			workspace: { revision: 2, statusCode: "resume-queued" },
		});
		expect(
			await runtime.runPromise(store.getApiMessage("message-stale-guard")),
		).toBeNull();
		expect(
			await runtime.runPromise(
				store.getWorkspaceLifecycleCommand(
					pausedWorkspace.workspaceId,
					"stale-resume-for-api-command",
				),
			),
		).toBeNull();

		expect(
			await runtime.runPromise(
				store.appendApiMessageGuarded({
					message: userMessage,
					expectedWorkspace: pausedWorkspace,
					lifecycleCommand: {
						workspace: {
							...resumedWorkspace,
							revision: 3,
							updatedAtMs: 500,
						},
						commandId: "terminal-message-must-not-resume",
						action: "resume",
						createdAtMs: 500,
					},
				}),
			),
		).toMatchObject({
			kind: "committed",
			append: { kind: "existing", message: { seq: 2, status: "settled" } },
			workspace: { revision: 2, statusCode: "resume-queued" },
			lifecycleCommandSaved: false,
		});
		expect(
			await runtime.runPromise(
				store.getWorkspaceLifecycleCommand(
					pausedWorkspace.workspaceId,
					"terminal-message-must-not-resume",
				),
			),
		).toBeNull();
		expect(
			await runtime.runPromise(store.getWorkspace(pausedWorkspace.workspaceId)),
		).toMatchObject({ revision: 2, statusCode: "resume-queued" });
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

	test("settles API commands by turn and projects the full ledger summary", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		const appendUser = (messageId: string, createdAtMs: number) =>
			runtime.runPromise(
				store.appendApiMessage({
					messageId,
					workspaceId: "workspace-api",
					accountId: "account-1",
					role: "user",
					sealedContent: `sealed:${messageId}`,
					commandId: `command:${messageId}`,
					status: "pending",
					createdAtMs,
				}),
			);

		expect(
			await runtime.runPromise(
				store.getApiWorkspaceLedgerSummary("workspace-api"),
			),
		).toEqual({
			latestSeq: 0,
			hasOutstanding: false,
			lastAssistant: null,
		});
		await appendUser("message-user-1", 100);
		await appendUser("message-user-2", 110);
		expect(
			await runtime.runPromise(
				store.ackApiCommand(
					"workspace-api",
					"message-user-1",
					"turn-1",
					undefined,
					200,
				),
			),
		).toBe(true);
		expect(
			await runtime.runPromise(
				store.ackApiCommand(
					"workspace-api",
					"message-user-2",
					"turn-2",
					undefined,
					210,
				),
			),
		).toBe(true);
		expect(
			await runtime.runPromise(
				store.ackApiCommand(
					"workspace-api",
					"message-user-1",
					"different-turn",
					undefined,
					220,
				),
			),
		).toBe(false);

		const turn2 = await runtime.runPromise(
			store.recordApiTurnEvent({
				messageId: "message-assistant-2",
				workspaceId: "workspace-api",
				accountId: "account-1",
				turnId: "turn-2",
				outcome: "completed",
				sealedContent: "sealed:assistant-2",
				contentDigest: "digest:assistant-2",
				nowMs: 300,
				receivedAtMs: 300,
			}),
		);
		expect(turn2.kind).toBe("created");
		if (turn2.kind !== "created" && turn2.kind !== "replay")
			throw new Error("unexpected replay");
		expect(
			await runtime.runPromise(store.listApiMessages("workspace-api", 0, 10)),
		).toEqual([
			expect.objectContaining({
				messageId: "message-user-1",
				turnId: "turn-1",
				status: "delivered",
			}),
			expect.objectContaining({
				messageId: "message-user-2",
				turnId: "turn-2",
				status: "settled",
			}),
			expect.objectContaining({
				messageId: "message-assistant-2",
				turnId: "turn-2",
				status: "settled",
			}),
		]);
		expect(
			await runtime.runPromise(
				store.getApiWorkspaceLedgerSummary("workspace-api"),
			),
		).toEqual({
			latestSeq: 3,
			hasOutstanding: true,
			lastAssistant: turn2.message,
		});

		const turn1 = await runtime.runPromise(
			store.recordApiTurnEvent({
				messageId: "message-assistant-1",
				workspaceId: "workspace-api",
				accountId: "account-1",
				turnId: "turn-1",
				outcome: "completed",
				sealedContent: "sealed:assistant-1",
				contentDigest: "digest:assistant-1",
				nowMs: 310,
				receivedAtMs: 310,
			}),
		);
		if (turn1.kind !== "created" && turn1.kind !== "replay")
			throw new Error("unexpected replay");
		expect(
			await runtime.runPromise(
				store.getApiWorkspaceLedgerSummary("workspace-api"),
			),
		).toEqual({
			latestSeq: 4,
			hasOutstanding: false,
			lastAssistant: turn1.message,
		});

		await appendUser("message-user-3", 320);
		await runtime.runPromise(
			store.recordApiTurnEvent({
				messageId: "message-assistant-3",
				workspaceId: "workspace-api",
				accountId: "account-1",
				turnId: "turn-3",
				outcome: "completed",
				sealedContent: "sealed:assistant-3",
				contentDigest: "digest:assistant-3",
				nowMs: 330,
				receivedAtMs: 330,
			}),
		);
		expect(
			await runtime.runPromise(
				store.ackApiCommand(
					"workspace-api",
					"message-user-3",
					"turn-3",
					undefined,
					340,
				),
			),
		).toBe(true);
		expect(
			(
				await runtime.runPromise(store.listApiMessages("workspace-api", 0, 10))
			).find((message) => message.messageId === "message-user-3"),
		).toMatchObject({ turnId: "turn-3", status: "settled" });

		// A launch turn may reach API before the public create response appends
		// its mirror user row. The late append must converge immediately instead
		// of leaving a permanently outstanding delivered command.
		await runtime.runPromise(
			store.recordApiTurnEvent({
				messageId: "message-assistant-launch",
				workspaceId: "workspace-api",
				accountId: "account-1",
				turnId: "turn-launch",
				outcome: "completed",
				sealedContent: "sealed:assistant-launch",
				contentDigest: "digest:assistant-launch",
				nowMs: 360,
				receivedAtMs: 360,
			}),
		);
		const lateLaunch = await runtime.runPromise(
			store.appendApiMessage({
				messageId: "message-user-launch",
				workspaceId: "workspace-api",
				accountId: "account-1",
				role: "user",
				sealedContent: "sealed:user-launch",
				turnId: "turn-launch",
				status: "delivered",
				createdAtMs: 350,
			}),
		);
		expect(lateLaunch.message.status).toBe("settled");

		await runtime.runPromise(
			store.appendApiMessage({
				messageId: "message-user-expired-pending",
				workspaceId: "workspace-api",
				accountId: "account-1",
				role: "user",
				sealedContent: "sealed:user-expired-pending",
				turnId: "turn-expired-pending",
				status: "pending",
				createdAtMs: 370,
				expiresAtMs: 400,
			}),
		);
		await runtime.runPromise(
			store.appendApiMessage({
				messageId: "message-user-expired-delivered",
				workspaceId: "workspace-api",
				accountId: "account-1",
				role: "user",
				sealedContent: "sealed:user-expired-delivered",
				turnId: "turn-expired-delivered",
				status: "pending",
				createdAtMs: 370,
				expiresAtMs: 400,
			}),
		);
		await runtime.runPromise(
			store.ackApiCommand(
				"workspace-api",
				"message-user-expired-delivered",
				"turn-expired-delivered",
				undefined,
				380,
			),
		);
		await runtime.runPromise(store.expireApiCommands(400));
		const expired = await runtime.runPromise(
			store.listApiMessages("workspace-api", 0, 20),
		);
		expect(
			expired.find(
				(message) => message.messageId === "message-user-expired-delivered",
			),
		).toMatchObject({ status: "failed" });
		expect(
			expired.find(
				(message) => message.messageId === "message-user-expired-pending",
			),
		).toMatchObject({ status: "expired" });
		await runtime.runPromise(
			store.recordApiTurnEvent({
				messageId: "message-assistant-expired-delivered",
				workspaceId: "workspace-api",
				accountId: "account-1",
				turnId: "turn-expired-delivered",
				outcome: "completed",
				sealedContent: "sealed:assistant-expired-delivered",
				contentDigest: "digest:assistant-expired-delivered",
				nowMs: 410,
				receivedAtMs: 410,
			}),
		);
		expect(
			(
				await runtime.runPromise(store.listApiMessages("workspace-api", 0, 20))
			).find(
				(message) => message.messageId === "message-user-expired-delivered",
			),
		).toMatchObject({ status: "settled" });
		expect(
			await runtime.runPromise(
				store.ackApiCommand(
					"workspace-api",
					"message-assistant-3",
					"turn-3",
					undefined,
					350,
				),
			),
		).toBe(false);
		await runtime.dispose();
	});

	test("associates legacy ACKs and adopts pre-receipt assistant turns", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);

		await runtime.runPromise(
			store.appendApiMessage({
				messageId: "legacy-command",
				workspaceId: "workspace-legacy",
				accountId: "account-1",
				role: "user",
				sealedContent: "sealed:legacy-command",
				turnId: "turn_API-assigned",
				status: "pending",
				createdAtMs: 10,
			}),
		);
		expect(
			await runtime.runPromise(
				store.ackApiCommand(
					"workspace-legacy",
					"legacy-command",
					undefined,
					undefined,
					20,
				),
			),
		).toBe(true);
		await runtime.runPromise(
			store.recordApiTurnEvent({
				messageId: "legacy-command-assistant",
				workspaceId: "workspace-legacy",
				accountId: "account-1",
				turnId: "turn-generated-by-legacy-runtime",
				outcome: "completed",
				sealedContent: "sealed:legacy-command-assistant",
				contentDigest: "digest:legacy-command-assistant",
				nowMs: 30,
				receivedAtMs: 30,
			}),
		);
		expect(
			(
				await runtime.runPromise(
					store.listApiMessages("workspace-legacy", 0, 10),
				)
			).find((message) => message.messageId === "legacy-command"),
		).toMatchObject({
			status: "settled",
			turnId: "turn-generated-by-legacy-runtime",
		});

		// The event stream can beat an old runtime's message-id-only ACK. A prior
		// human turn may also be published late, so only a turn settled and received
		// inside the latest command-fetch attempt is claimable.
		await runtime.runPromise(
			store.appendApiMessage({
				messageId: "legacy-racing-command",
				workspaceId: "workspace-legacy-race",
				accountId: "account-1",
				role: "user",
				sealedContent: "sealed:legacy-racing-command",
				turnId: "turn_API-assigned-racing",
				status: "pending",
				createdAtMs: 40,
			}),
		);
		await runtime.runPromise(
			store.appendApiMessage({
				messageId: "unrelated-pending-command",
				workspaceId: "workspace-legacy-race",
				accountId: "account-1",
				role: "user",
				sealedContent: "sealed:unrelated-pending-command",
				turnId: "turn_API-assigned-unrelated",
				status: "pending",
				createdAtMs: 41,
			}),
		);
		await runtime.runPromise(
			store.claimNextApiCommand("workspace-legacy-race", 42),
		);
		await runtime.runPromise(
			store.recordApiTurnEvent({
				messageId: "unrelated-delayed-assistant",
				workspaceId: "workspace-legacy-race",
				accountId: "account-1",
				turnId: "turn-unrelated-human",
				outcome: "completed",
				sealedContent: "sealed:unrelated-delayed-assistant",
				contentDigest: "digest:unrelated-delayed-assistant",
				nowMs: 39,
				receivedAtMs: 43,
			}),
		);
		const retriedClaim = await runtime.runPromise(
			store.claimNextApiCommand("workspace-legacy-race", 44),
		);
		expect(retriedClaim).toMatchObject({
			messageId: "legacy-racing-command",
			deliveryAttemptedAtMs: 44,
		});
		await runtime.runPromise(
			store.recordApiTurnEvent({
				messageId: "legacy-racing-command-assistant",
				workspaceId: "workspace-legacy-race",
				accountId: "account-1",
				turnId: "turn-generated-before-legacy-ack",
				outcome: "completed",
				sealedContent: "sealed:legacy-racing-command-assistant",
				contentDigest: "digest:legacy-racing-command-assistant",
				nowMs: 45,
				receivedAtMs: 45,
			}),
		);
		expect(
			await runtime.runPromise(
				store.ackApiCommand(
					"workspace-legacy-race",
					"legacy-racing-command",
					undefined,
					undefined,
					46,
				),
			),
		).toBe(true);
		const racedMessages = await runtime.runPromise(
			store.listApiMessages("workspace-legacy-race", 0, 10),
		);
		expect(
			racedMessages.find(
				(message) => message.messageId === "legacy-racing-command",
			),
		).toMatchObject({
			status: "settled",
			turnId: "turn-generated-before-legacy-ack",
		});
		expect(
			racedMessages.find(
				(message) => message.messageId === "unrelated-pending-command",
			),
		).toMatchObject({
			status: "pending",
			turnId: "turn_API-assigned-unrelated",
		});

		// A restarted upgraded runtime can recover an older domain turn for the
		// same command. Rebinding is permitted only when the ACK echoes the exact
		// provisional turn that API issued for this command.
		await runtime.runPromise(
			store.appendApiMessage({
				messageId: "recovered-command",
				workspaceId: "workspace-recovered-command",
				accountId: "account-1",
				role: "user",
				sealedContent: "sealed:recovered-command",
				turnId: "turn_API-provisional",
				status: "pending",
				createdAtMs: 50,
			}),
		);
		await runtime.runPromise(
			store.recordApiTurnEvent({
				messageId: "recovered-command-assistant",
				workspaceId: "workspace-recovered-command",
				accountId: "account-1",
				turnId: "turn_domain-recovered",
				outcome: "completed",
				sealedContent: "sealed:recovered-command-assistant",
				contentDigest: "digest:recovered-command-assistant",
				nowMs: 51,
				receivedAtMs: 51,
			}),
		);
		expect(
			await runtime.runPromise(
				store.ackApiCommand(
					"workspace-recovered-command",
					"recovered-command",
					"turn_domain-recovered",
					"turn_not-issued",
					52,
				),
			),
		).toBe(false);
		expect(
			await runtime.runPromise(
				store.ackApiCommand(
					"workspace-recovered-command",
					"recovered-command",
					"turn_domain-recovered",
					"turn_API-provisional",
					53,
				),
			),
		).toBe(true);
		expect(
			await runtime.runPromise(store.getApiMessage("recovered-command")),
		).toMatchObject({
			status: "settled",
			turnId: "turn_domain-recovered",
		});

		// Migration 0017 adds the compact receipt table after assistant rows may
		// already exist. A verified historical replay adopts one receipt and also
		// binds the unique delivered launch row that predated deterministic turns.
		await runtime.runPromise(
			store.appendApiMessage({
				messageId: "legacy-launch",
				workspaceId: "workspace-adoption",
				accountId: "account-1",
				role: "user",
				sealedContent: "sealed:legacy-launch",
				status: "delivered",
				createdAtMs: 40,
			}),
		);
		await runtime.runPromise(
			store.appendApiMessage({
				messageId: "legacy-assistant",
				workspaceId: "workspace-adoption",
				accountId: "account-1",
				role: "assistant",
				sealedContent: "sealed:legacy-assistant",
				turnId: "legacy-turn",
				outcome: "completed",
				status: "settled",
				createdAtMs: 50,
			}),
		);
		const adopted = await runtime.runPromise(
			store.recordApiTurnEvent({
				messageId: "legacy-assistant",
				workspaceId: "workspace-adoption",
				accountId: "account-1",
				turnId: "legacy-turn",
				outcome: "completed",
				sealedContent: "new-seal-is-not-used-for-replay",
				contentDigest: "digest:adopted",
				nowMs: 45,
				receivedAtMs: 60,
				adoptLegacyReplay: true,
			}),
		);
		expect(adopted).toMatchObject({
			kind: "replay",
			receipt: { contentDigest: "digest:adopted", settledAtMs: 45 },
		});
		expect(
			await runtime.runPromise(
				store.getApiWorkspaceLedgerSummary("workspace-adoption"),
			),
		).toMatchObject({ hasOutstanding: false });
		expect(
			(
				await runtime.runPromise(
					store.listApiMessages("workspace-adoption", 0, 10),
				)
			).find((message) => message.messageId === "legacy-launch"),
		).toMatchObject({ status: "settled", turnId: "legacy-turn" });
		expect(
			await runtime.runPromise(
				store.recordApiTurnEvent({
					messageId: "legacy-assistant",
					workspaceId: "workspace-adoption",
					accountId: "account-1",
					turnId: "legacy-turn",
					outcome: "completed",
					sealedContent: "ignored",
					contentDigest: "digest:changed-after-adoption",
					nowMs: 45,
					receivedAtMs: 61,
					adoptLegacyReplay: true,
				}),
			),
		).toMatchObject({ kind: "conflict" });
		await runtime.dispose();
	});

	test("records turn receipts and webhook outbox rows atomically across replays", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(
			store.createApiWebhook(
				{
					webhookId: "webhook-atomic",
					accountId: "account-1",
					url: "https://example.test/webhook",
					sealedSecret: "sealed:webhook-secret",
					createdAtMs: 1,
				},
				20,
			),
		);
		const fanout = (eventId: string, deliveryId: string) => ({
			eventId,
			eventType: "workspace.turn.completed" as const,
			sealedPayload: `sealed:${eventId}`,
			enqueuedAtMs: 10,
			targets: [{ webhookId: "webhook-atomic", deliveryId }],
		});
		const turn = {
			messageId: "assistant-atomic",
			workspaceId: "workspace-atomic",
			accountId: "account-1",
			turnId: "turn-atomic",
			outcome: "completed",
			sealedContent: "sealed:assistant-atomic",
			contentDigest: "digest:assistant-atomic",
			nowMs: 5,
			receivedAtMs: 5,
			webhookFanout: fanout("event-atomic", "delivery-atomic"),
		} as const;

		expect(
			(await runtime.runPromise(store.recordApiTurnEvent(turn))).kind,
		).toBe("created");
		expect(
			(await runtime.runPromise(store.recordApiTurnEvent(turn))).kind,
		).toBe("replay");
		expect(
			await runtime.runPromise(
				store.recordApiTurnEvent({
					...turn,
					contentDigest: "digest:changed",
					webhookFanout: fanout("event-poison", "delivery-poison"),
				}),
			),
		).toMatchObject({ kind: "conflict" });

		const repairTurn = {
			...turn,
			messageId: "assistant-repair",
			workspaceId: "workspace-repair",
			turnId: "turn-repair",
			sealedContent: "sealed:assistant-repair",
			contentDigest: "digest:assistant-repair",
			webhookFanout: undefined,
		} as const;
		expect(
			(await runtime.runPromise(store.recordApiTurnEvent(repairTurn))).kind,
		).toBe("created");
		expect(
			(
				await runtime.runPromise(
					store.recordApiTurnEvent({
						...repairTurn,
						webhookFanout: fanout("event-repair", "delivery-repair"),
					}),
				)
			).kind,
		).toBe("replay");

		expect(
			(
				await runtime.runPromise(
					store.claimDueApiWebhookDeliveries(10, 10, 100),
				)
			).map(({ delivery }) => delivery.deliveryId),
		).toEqual(["delivery-atomic", "delivery-repair"]);
		expect(
			await runtime.runPromise(
				store.listApiMessages("workspace-atomic", 0, 10),
			),
		).toHaveLength(1);
		await runtime.dispose();
	});

	test("atomically enforces the active webhook limit per account", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		const registrations = await Promise.all(
			Array.from({ length: 30 }, (_, index) =>
				runtime.runPromise(
					store.createApiWebhook(
						{
							webhookId: `webhook-limit-${index}`,
							accountId: "account-limit",
							url: `https://example.test/webhook/${index}`,
							sealedSecret: `sealed:webhook-secret-${index}`,
							createdAtMs: index,
						},
						20,
					),
				),
			),
		);

		expect(registrations.filter(Boolean)).toHaveLength(20);
		expect(
			await runtime.runPromise(store.listApiWebhooks("account-limit")),
		).toHaveLength(20);
		expect(
			await runtime.runPromise(
				store.createApiWebhook(
					{
						webhookId: "webhook-other-account",
						accountId: "account-other",
						url: "https://example.test/webhook/other",
						sealedSecret: "sealed:webhook-secret-other",
						createdAtMs: 1,
					},
					20,
				),
			),
		).toBe(true);
		expect(
			await runtime.runPromise(store.listApiWebhooks("account-other")),
		).toHaveLength(1);
		await runtime.dispose();
	});

	test("compacts terminal API data without losing ledger high-water marks or webhook tombstones", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(
			store.appendApiMessage({
				messageId: "pending-old",
				workspaceId: "workspace-retention",
				accountId: "account-1",
				role: "user",
				sealedContent: "sealed:pending-old",
				status: "pending",
				createdAtMs: 1,
			}),
		);
		const legacyUnreceiptedTurn = {
			messageId: "assistant-legacy-unreceipted",
			workspaceId: "workspace-retention",
			accountId: "account-1",
			turnId: "turn-legacy-unreceipted",
			outcome: "completed",
			sealedContent: "sealed:assistant-legacy-unreceipted",
			contentDigest: "digest:assistant-legacy-unreceipted",
			nowMs: 1,
			receivedAtMs: 1,
		} as const;
		await runtime.runPromise(
			store.appendApiMessage({
				messageId: legacyUnreceiptedTurn.messageId,
				workspaceId: legacyUnreceiptedTurn.workspaceId,
				accountId: legacyUnreceiptedTurn.accountId,
				role: "assistant",
				sealedContent: legacyUnreceiptedTurn.sealedContent,
				turnId: legacyUnreceiptedTurn.turnId,
				outcome: legacyUnreceiptedTurn.outcome,
				status: "settled",
				createdAtMs: 1,
			}),
		);
		const oldTurn = {
			messageId: "assistant-old",
			workspaceId: "workspace-retention",
			accountId: "account-1",
			turnId: "turn-old",
			outcome: "completed",
			sealedContent: "sealed:assistant-old",
			contentDigest: "digest:assistant-old",
			nowMs: 1,
			receivedAtMs: 1,
		} as const;
		await runtime.runPromise(store.recordApiTurnEvent(oldTurn));
		for (let index = 0; index < 1_001; index += 1)
			await runtime.runPromise(
				store.appendApiMessage({
					messageId: `terminal-${index}`,
					workspaceId: "workspace-retention",
					accountId: "account-1",
					role: "user",
					sealedContent: `sealed:terminal-${index}`,
					status: "settled",
					createdAtMs: 1,
				}),
			);

		await runtime.runPromise(
			store.createApiWebhook(
				{
					webhookId: "webhook-retention",
					accountId: "account-1",
					url: "https://example.test/webhook",
					sealedSecret: "sealed:webhook-secret",
					createdAtMs: 1,
				},
				20,
			),
		);
		const deliveryTurn = (
			deliveryId: string,
			eventId: string,
			enqueuedAtMs: number,
		) =>
			({
				messageId: `assistant-${eventId}`,
				workspaceId: `workspace-${eventId}`,
				accountId: "account-1",
				turnId: `turn-${eventId}`,
				outcome: "completed",
				sealedContent: `sealed:assistant-${eventId}`,
				contentDigest: `digest:${eventId}`,
				nowMs: 1,
				receivedAtMs: 1,
				webhookFanout: {
					eventId,
					eventType: "workspace.turn.completed" as const,
					sealedPayload: `sealed:${eventId}`,
					enqueuedAtMs,
					targets: [{ webhookId: "webhook-retention", deliveryId }],
				},
			}) as const;
		const deliveredOld = deliveryTurn(
			"delivery-delivered-old",
			"event-delivered-old",
			1,
		);
		await runtime.runPromise(store.recordApiTurnEvent(deliveredOld));
		const [claimedDeliveredOld] = await runtime.runPromise(
			store.claimDueApiWebhookDeliveries(1, 1, 100),
		);
		if (claimedDeliveredOld === undefined)
			throw new Error("delivery not queued");
		await runtime.runPromise(
			store.completeApiWebhookDelivery(
				claimedDeliveredOld.delivery.deliveryId,
				1,
			),
		);
		const failedOld = deliveryTurn(
			"delivery-failed-old",
			"event-failed-old",
			1,
		);
		await runtime.runPromise(store.recordApiTurnEvent(failedOld));
		const [claimedFailedOld] = await runtime.runPromise(
			store.claimDueApiWebhookDeliveries(1, 1, 100),
		);
		if (claimedFailedOld === undefined) throw new Error("delivery not queued");
		await runtime.runPromise(
			store.failApiWebhookDelivery({
				deliveryId: claimedFailedOld.delivery.deliveryId,
				nowMs: 1,
				error: "terminal",
				nextAttemptAtMs: 1,
				terminal: true,
			}),
		);
		const deliveredCurrent = deliveryTurn(
			"delivery-delivered-current",
			"event-delivered-current",
			100,
		);
		await runtime.runPromise(store.recordApiTurnEvent(deliveredCurrent));
		const [claimedDeliveredCurrent] = await runtime.runPromise(
			store.claimDueApiWebhookDeliveries(100, 1, 100),
		);
		if (claimedDeliveredCurrent === undefined)
			throw new Error("delivery not queued");
		await runtime.runPromise(
			store.completeApiWebhookDelivery(
				claimedDeliveredCurrent.delivery.deliveryId,
				100,
			),
		);
		const pendingOld = deliveryTurn(
			"delivery-pending-old",
			"event-pending-old",
			1,
		);
		await runtime.runPromise(store.recordApiTurnEvent(pendingOld));

		await runtime.runPromise(store.pruneApiData(100));
		const retained = await runtime.runPromise(
			store.listApiMessages("workspace-retention", 0, 2_000),
		);
		expect(retained).toHaveLength(1_002);
		expect(retained.some(({ messageId }) => messageId === "pending-old")).toBe(
			true,
		);
		expect(retained.some(({ messageId }) => messageId === "terminal-0")).toBe(
			false,
		);
		expect(
			retained.some(({ messageId }) => messageId === "assistant-old"),
		).toBe(false);
		expect(
			retained.some(
				({ messageId }) => messageId === legacyUnreceiptedTurn.messageId,
			),
		).toBe(true);
		expect(
			(
				await runtime.runPromise(
					store.recordApiTurnEvent({
						...legacyUnreceiptedTurn,
						adoptLegacyReplay: true,
					}),
				)
			).kind,
		).toBe("replay");
		await runtime.runPromise(store.pruneApiData(100));
		expect(
			(
				await runtime.runPromise(
					store.listApiMessages("workspace-retention", 0, 2_000),
				)
			).some(({ messageId }) => messageId === legacyUnreceiptedTurn.messageId),
		).toBe(false);
		expect(
			await runtime.runPromise(
				store.recordApiTurnEvent({
					...oldTurn,
					webhookFanout: {
						eventId: "event-pruned-repair",
						eventType: "workspace.turn.completed",
						sealedPayload: "sealed:event-pruned-repair",
						enqueuedAtMs: 200,
						targets: [
							{
								webhookId: "webhook-retention",
								deliveryId: "delivery-pruned-repair",
							},
						],
					},
				}),
			),
		).toEqual({
			kind: "pruned-replay",
			receipt: {
				workspaceId: oldTurn.workspaceId,
				turnId: oldTurn.turnId,
				outcome: oldTurn.outcome,
				settledAtMs: oldTurn.nowMs,
				receivedAtMs: oldTurn.receivedAtMs,
				contentDigest: oldTurn.contentDigest,
			},
		});
		expect(
			await runtime.runPromise(
				store.listApiMessages("workspace-retention", 0, 2_000),
			),
		).toHaveLength(1_001);
		const appended = await runtime.runPromise(
			store.appendApiMessage({
				messageId: "after-prune",
				workspaceId: "workspace-retention",
				accountId: "account-1",
				role: "user",
				sealedContent: "sealed:after-prune",
				status: "pending",
				createdAtMs: 200,
			}),
		);
		expect(appended.message.seq).toBe(1_005);

		for (const [input, replacementId] of [
			[deliveredOld, "replacement-delivered-old"],
			[failedOld, "replacement-failed-old"],
			[pendingOld, "replacement-pending-old"],
			[deliveredCurrent, "replacement-delivered-current"],
		] as const)
			await runtime.runPromise(
				store.recordApiTurnEvent({
					...input,
					webhookFanout: {
						...input.webhookFanout,
						enqueuedAtMs: 200,
						targets: [
							{
								webhookId: "webhook-retention",
								deliveryId: replacementId,
							},
						],
					},
				}),
			);
		expect(
			new Set(
				(
					await runtime.runPromise(
						store.claimDueApiWebhookDeliveries(300, 10, 100),
					)
				).map(({ delivery: claimed }) => claimed.deliveryId),
			),
		).toEqual(new Set(["delivery-pending-old", "delivery-pruned-repair"]));
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
		const readinessRetry = await runtime.runPromise(
			store.markRuntimeRepositoryReady({
				workspaceId: workspace.workspaceId,
				currentCredentialHash: "runtime-hash",
				commandProtocolVersion: 3,
				nowMs: 230,
				nextIdleAtMs: 2_010,
			}),
		);
		expect(readinessRetry?.nextActionAtMs).toBe(
			repositoryReady?.nextActionAtMs,
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
		if (repositoryReady === null) throw new Error("runtime must be ready");
		for (const desiredState of ["paused", "archived", "deleted"] as const) {
			const blockedId = `workspace-ready-blocked-${desiredState}`;
			await runtime.runPromise(
				store.createWorkspace(
					{
						...repositoryReady,
						desiredState,
						workspaceId: blockedId,
						idempotencyKey: blockedId,
						branch: blockedId,
					},
					startCommand(blockedId),
				),
			);
			expect(
				await runtime.runPromise(
					store.markRuntimeRepositoryReady({
						workspaceId: blockedId,
						currentCredentialHash: "runtime-hash",
						nowMs: 220,
						nextIdleAtMs: 2000,
					}),
				),
			).toBeNull();
			expect(
				(await runtime.runPromise(store.getWorkspace(blockedId)))?.desiredState,
			).toBe(desiredState);
		}
		for (const [suffix, patch] of [
			["restart", { statusCode: "restart-queued" }],
			["recovery", { statusCode: "resume-runtime-recovery-queued" }],
			[
				"fence",
				{
					requestConfig: {
						...repositoryReady.requestConfig,
						cloudMailboxFenceRequired: true,
					},
				},
			],
		] as const) {
			const blockedId = `workspace-ready-blocked-${suffix}`;
			await runtime.runPromise(
				store.createWorkspace(
					{
						...repositoryReady,
						...patch,
						workspaceId: blockedId,
						branch: blockedId,
						idempotencyKey: blockedId,
					},
					startCommand(blockedId),
				),
			);
			expect(
				await runtime.runPromise(
					store.markRuntimeRepositoryReady({
						workspaceId: blockedId,
						currentCredentialHash: "runtime-hash",
						nowMs: 220,
						nextIdleAtMs: 2000,
					}),
				),
			).toBeNull();
		}
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
		expect(
			retainedV2Runtime === null
				? false
				: workspaceAcceptsCloudCommandMailbox({
						...retainedV2Runtime,
						requestConfig: {
							...retainedV2Runtime.requestConfig,
							cloudCommandEnrollmentProtocolVersion: 3,
						},
					}),
		).toBe(true);
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
					activeSessionId: "session-summary",
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
			await save({
				summaryRevision: 3,
				title: "Newest title",
				activeSessionId: "session-replacement",
				sessionHeadVersion: 2,
				updatedAtMs: 1_200,
			}),
		).toMatchObject({
			kind: "applied",
			summary: {
				activeSessionId: "session-replacement",
				sessionHeadVersion: 2,
			},
		});
		expect(
			await runtime.runPromise(store.getRuntimeSummary(workspace.workspaceId)),
		).toMatchObject({
			summaryRevision: 3,
			title: "Newest title",
			activeSessionId: "session-replacement",
		});
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
		expect(
			await runtime.runPromise(
				store.recordActivity(
					"workspace-paused",
					"account-1",
					499,
					3_600_499,
					true,
				),
			),
		).toBeNull();
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
