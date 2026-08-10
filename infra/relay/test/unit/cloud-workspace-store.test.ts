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
			(await runtime.runPromise(store.createWorkspace(workspace))).kind,
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
			store.saveWorkspace({ ...workspace, revision: workspace.revision + 1 }),
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
					store.createWorkspace({
						...workspace,
						workspaceId: "workspace-2",
						idempotencyKey: "other",
					}),
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
					store.createWorkspace({
						...workspace,
						workspaceId: "workspace-2",
						idempotencyKey: "other",
					}),
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
