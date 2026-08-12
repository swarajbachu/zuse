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
	commandId: `start:${workspaceId}`,
	workspaceId,
	accountId,
	sequence: 1,
	kind: "start-agent" as const,
	payload: {},
	state: "queued" as const,
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

	test("creates the first command atomically and consumes runtime boot once", async () => {
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
				store.listCommands(workspace.workspaceId, 0, 150),
			),
		).toHaveLength(1);
		const consume = () =>
			runtime.runPromise(
				store.consumeRuntimeBoot({
					workspaceId: workspace.workspaceId,
					bootTokenHash: "boot-hash",
					runtimeCredentialHash: "runtime-hash",
					runtimeCredentialExpiresAtMs: 10_000,
					nowMs: 200,
				}),
			);
		expect(await consume()).toMatchObject({
			runtimeBootTokenHash: undefined,
			runtimeCredentialHash: "runtime-hash",
			state: "setup",
		});
		expect(await consume()).toBeNull();
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
		await runtime.runPromise(
			store.saveWorkspace({
				...original,
				runtimeCredentialHash: "credential-new",
				runtimeState: "online",
				revision: 3,
				updatedAtMs: 200,
			}),
		);
		await runtime.runPromise(
			store.saveWorkspace({
				...original,
				statusCode: "stale-retry",
				updatedAtMs: 150,
			}),
		);

		expect(
			await runtime.runPromise(store.getWorkspace(original.workspaceId)),
		).toMatchObject({
			runtimeCredentialHash: "credential-new",
			runtimeState: "online",
			revision: 3,
			statusCode: "enrollment-pending",
		});
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

	test("delivers commands and stores runtime events idempotently", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		const command = {
			commandId: "start:workspace-1",
			workspaceId: "workspace-1",
			accountId: "account-1",
			sequence: 1,
			kind: "start-agent" as const,
			payload: { firstMessage: "hello" },
			state: "queued" as const,
			createdAtMs: 100,
		};
		await runtime.runPromise(store.createCommand(command));
		expect(
			await runtime.runPromise(store.listCommands("workspace-1", 0, 200)),
		).toMatchObject([{ state: "claimed", sequence: 1 }]);
		expect(
			await runtime.runPromise(
				store.acknowledgeCommand("workspace-1", command.commandId, 300),
			),
		).toBe(true);
		const failedCommand = {
			...command,
			commandId: "message:workspace-1",
			sequence: 2,
			kind: "send-message" as const,
			state: "queued" as const,
		};
		await runtime.runPromise(store.createCommand(failedCommand));
		await runtime.runPromise(store.listCommands("workspace-1", 1, 350));
		expect(
			await runtime.runPromise(
				store.failCommand("workspace-1", failedCommand.commandId, 400),
			),
		).toBe(true);
		expect(
			await runtime.runPromise(store.listCommands("workspace-1", 0, 450)),
		).toEqual([]);

		const event = {
			workspaceId: "workspace-1",
			runtimeSequence: 1,
			eventId: "event-1",
			streamId: "session-1",
			streamVersion: 1,
			type: "MessagePersisted",
			payloadJson: '{"_tag":"MessagePersisted"}',
			createdAtMs: 300,
		};
		expect(
			await runtime.runPromise(store.appendEvents("workspace-1", [event])),
		).toBe(1);
		expect(
			await runtime.runPromise(store.appendEvents("workspace-1", [event])),
		).toBe(0);
		const replacementEvent = {
			...event,
			eventId: "event-after-replacement",
			streamVersion: 2,
			type: "SessionStatusSet",
			createdAtMs: 400,
		};
		expect(
			await runtime.runPromise(
				store.appendEvents("workspace-1", [replacementEvent]),
			),
		).toBe(1);
		expect(
			await runtime.runPromise(store.listEvents("workspace-1", 0)),
		).toEqual([event, { ...replacementEvent, runtimeSequence: 2 }]);
		expect(await runtime.runPromise(store.latestMessageAt("workspace-1"))).toBe(
			300,
		);
		await runtime.dispose();
	});

	test("queues durable cloud messages in strict workspace order", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		const message = (id: string, text: string) => ({
			commandId: `message:${id}`,
			workspaceId: "workspace-1",
			accountId: "account-1",
			kind: "send-message" as const,
			payload: { clientMessageId: id, input: { text } },
			state: "queued" as const,
			createdAtMs: 400,
		});
		const first = await runtime.runPromise(
			store.createNextCommand(message("message-1", "first")),
		);
		const duplicate = await runtime.runPromise(
			store.createNextCommand(message("message-1", "first")),
		);
		const second = await runtime.runPromise(
			store.createNextCommand(message("message-2", "second")),
		);

		expect(duplicate).toEqual(first);
		expect(second.sequence).toBe(first.sequence + 1);
		expect(
			await runtime.runPromise(store.listMessageCommands("workspace-1")),
		).toEqual([first, second]);
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
