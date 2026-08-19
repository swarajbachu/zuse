import {
	FakeSandboxProviderControlService,
	SandboxProvidersFake,
} from "@zuse/sandbox-providers/testing";
import { Effect, Layer, Redacted, Ref } from "effect";
import { describe, expect, test } from "vitest";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import { CloudCredentialVault } from "../../src/cloud-credential-vault.ts";
import {
	ARCHIVED_WORKSPACE_RETENTION_MS,
	reconcileCloudWorkspace,
	reusableAccountBuildSnapshot,
	sanitizeProjectBuildDiagnostic,
	WORKSPACE_RUNTIME_PROCESS_SELECTOR,
	WORKSPACE_RUNTIME_RESUME_SCRIPT,
} from "../../src/cloud-workspace-reconciler.ts";
import {
	type CloudProjectBuildRecord,
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import * as Config from "../../src/config.ts";
import { SandboxOfferConfiguration } from "../../src/sandbox-provider-module.ts";

const testLayer = Layer.mergeAll(
	Config.layer({
		relayIssuer: "https://relay.test",
		workosJwksUrl: "https://unused.test/jwks",
		workosIssuer: "https://unused.test",
		mintPrivateKey: Redacted.make("{}"),
		mintPublicKey: '{"kty":"OKP"}',
	}),
	CloudWorkspaceStoreMemory,
	CloudBillingStoreMemory,
	SandboxProvidersFake,
	Layer.succeed(SandboxOfferConfiguration, {
		port: 47_837,
		vcpuCount: 2,
		memoryMib: 1_024,
		createTimeoutSeconds: 3_600,
		keepAliveTimeoutSeconds: 600,
	}),
	Layer.succeed(CloudCredentialVault, {
		enabled: false,
		encrypt: () => Effect.die("unused"),
		decrypt: () => Effect.die("unused"),
	}),
);

const seedWorkspace = Effect.fn("seedArchiveWorkspace")(function* (
	input: Pick<
		CloudWorkspaceRecord,
		"workspaceId" | "state" | "desiredState" | "statusCode" | "requestConfig"
	> &
		Partial<CloudWorkspaceRecord>,
) {
	const store = yield* CloudWorkspaceStore;
	const control = yield* FakeSandboxProviderControlService;
	const nowMs = Date.now();
	const workspaceId = input.workspaceId;
	const accountId = `account-${workspaceId}`;
	const projectId = `project-${workspaceId}`;
	const buildId = `build-${workspaceId}`;
	const providerSandboxId = input.providerSandboxId ?? `source-${workspaceId}`;
	yield* store.connectProject({
		projectId,
		accountId,
		repositoryIdentity: `github.com/acme/${workspaceId}`,
		repositoryUrl: `https://github.com/acme/${workspaceId}.git`,
		displayName: workspaceId,
		defaultBranch: "main",
		visibility: "public",
		gitConnectionKind: "github-app",
		cloudEnvironment: {},
		secretBindings: [],
		configurationDigest: "digest",
		state: "ready",
		idempotencyKey: `connect-${workspaceId}`,
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
	});
	yield* store.createBuild({
		buildId,
		projectId,
		accountId,
		provider: "fake",
		snapshotId: `base-${workspaceId}`,
		templateVersion: "test-template",
		configurationDigest: "digest",
		state: "ready",
		idempotencyKey: `build-key-${workspaceId}`,
		nextActionAtMs: Number.MAX_SAFE_INTEGER,
		revision: 1,
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
	});
	const workspace: CloudWorkspaceRecord = {
		workspaceId,
		accountId,
		projectId,
		buildId,
		provider: "fake",
		providerSandboxId,
		runtimeState: input.runtimeState ?? "offline",
		chatId: `chat-${workspaceId}`,
		initialSessionId: `session-${workspaceId}`,
		branch: `task/${workspaceId}`,
		baseRef: "origin/main",
		state: input.state,
		desiredState: input.desiredState,
		statusCode: input.statusCode,
		credentialEpoch: 0,
		archiveRequestedAtMs: input.archiveRequestedAtMs,
		archiveDeleteAtMs: input.archiveDeleteAtMs,
		idempotencyKey: `workspace-key-${workspaceId}`,
		requestConfig: input.requestConfig,
		nextActionAtMs: nowMs,
		revision: 1,
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
		lastActivityAtMs: nowMs,
	};
	yield* store.createWorkspace(workspace, {
		workspaceId,
		accountId,
		chatId: workspace.chatId,
		sessionId: workspace.initialSessionId,
		turnId: `turn:${workspaceId}`,
		commandId: `launch:${workspaceId}`,
		ciphertext: "encrypted-launch-intent",
		expiresAtMs: nowMs + 86_400_000,
		createdAtMs: nowMs,
	});
	yield* Ref.update(control.sandboxes, (sandboxes) =>
		new Map(sandboxes).set(providerSandboxId, {
			providerSandboxId,
			providerLabel: `zuse-cloud-workspace-${workspaceId}`,
			state: "running",
		}),
	);
	return workspace;
});

describe("cloud workspace reconciler", () => {
	test("updates the signed runtime before a resumed launch", () => {
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).toContain(
			"ZUSE_RUNTIME_INSTALL_ONLY=1",
		);
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).toContain(
			"/usr/local/lib/zuse/runtime-updater.mjs",
		);
	});

	test("cleans matching runtime children on every replacement", () => {
		expect(WORKSPACE_RUNTIME_PROCESS_SELECTOR).toMatchObject({
			tag: "zuse-runtime",
			legacyCleanup: "matching-command",
		});
	});

	test("bounds and redacts project builder diagnostics", () => {
		const diagnostic = sanitizeProjectBuildDiagnostic(
			`clone https://user:password@github.com/acme/private.git\nAuthorization: Bearer secret-token\nGITHUB_TOKEN=ghp_${"x".repeat(40)}\n${"a".repeat(3_000)}`,
		);

		expect(diagnostic).not.toContain("password");
		expect(diagnostic).not.toContain("secret-token");
		expect(diagnostic).not.toContain("ghp_");
		expect(diagnostic).not.toContain("github.com/acme/private");
		expect(diagnostic.length).toBeLessThanOrEqual(2_048);
	});

	test("reuses account snapshots only from the current template", () => {
		const build = {
			templateVersion: "old-template",
			snapshotId: "old-snapshot",
		} as CloudProjectBuildRecord;

		expect(reusableAccountBuildSnapshot(build, "new-template")).toBeUndefined();
		expect(reusableAccountBuildSnapshot(build, "old-template")).toBe(
			"old-snapshot",
		);
	});

	test("archives by pausing the same sandbox for 30 days", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const deleteAt = Date.now() + ARCHIVED_WORKSPACE_RETENTION_MS;
				const workspace = yield* seedWorkspace({
					workspaceId: "archive-paused",
					state: "ready",
					desiredState: "archived",
					statusCode: "archive-queued",
					requestConfig: {},
					archiveRequestedAtMs: Date.now() - 2_000,
					archiveDeleteAtMs: deleteAt,
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					sandboxes: yield* Ref.get(control.sandboxes),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.workspace).toMatchObject({
			state: "archived",
			desiredState: "archived",
			statusCode: "archived",
			nextActionAtMs: expect.any(Number),
			providerSandboxId: "source-archive-paused",
		});
		expect(result.workspace?.nextActionAtMs).toBeGreaterThan(Date.now());
		expect(result.sandboxes.has("source-archive-paused")).toBe(true);
	});

	test("permanently deletes an archived sandbox after 30 days", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "expired-archive",
					state: "archived",
					desiredState: "archived",
					statusCode: "archived",
					requestConfig: {},
					archiveDeleteAtMs: Date.now() - 1,
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				const expiring = yield* store.getWorkspace(workspace.workspaceId);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					expiring,
					deleted: yield* store.getWorkspace(workspace.workspaceId),
					sandboxes: yield* Ref.get(control.sandboxes),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(ARCHIVED_WORKSPACE_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1_000);
		expect(result.expiring).toMatchObject({
			desiredState: "deleted",
			statusCode: "archive-retention-expired",
		});
		expect(result.deleted).toMatchObject({
			state: "deleted",
			providerSandboxId: undefined,
		});
		expect(result.sandboxes.has("source-expired-archive")).toBe(false);
	});

	test("preserves a paused runtime before falling back to a restart", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const nowMs = Date.now();
				const project = {
					projectId: "project-resume",
					accountId: "account-resume",
					repositoryIdentity: "github.com/acme/app",
					repositoryUrl: "https://github.com/acme/app.git",
					displayName: "app",
					defaultBranch: "main",
					visibility: "public" as const,
					gitConnectionKind: "github-app" as const,
					cloudEnvironment: {},
					secretBindings: [],
					configurationDigest: "digest",
					state: "ready" as const,
					idempotencyKey: "connect-resume",
					createdAtMs: nowMs,
					updatedAtMs: nowMs,
				};
				const build = {
					buildId: "build-resume",
					projectId: project.projectId,
					accountId: project.accountId,
					provider: "fake",
					snapshotId: "snapshot-resume",
					templateVersion: "test-template",
					configurationDigest: "digest",
					state: "ready" as const,
					idempotencyKey: "build-resume-key",
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
					revision: 1,
					createdAtMs: nowMs,
					updatedAtMs: nowMs,
				};
				const workspace = {
					workspaceId: "workspace-resume",
					accountId: project.accountId,
					projectId: project.projectId,
					buildId: build.buildId,
					provider: "fake",
					providerSandboxId: "sandbox-resume",
					runtimeState: "online" as const,
					chatId: "chat-resume",
					initialSessionId: "session-resume",
					branch: "task/resume",
					baseRef: "origin/main",
					state: "ready" as const,
					desiredState: "paused" as const,
					statusCode: "agent-running",
					credentialEpoch: 0,
					idempotencyKey: "workspace-resume-key",
					requestConfig: {},
					nextActionAtMs: nowMs,
					revision: 1,
					createdAtMs: nowMs,
					updatedAtMs: nowMs,
					lastActivityAtMs: nowMs,
				};

				yield* store.connectProject(project);
				yield* store.createBuild(build);
				yield* store.createWorkspace(workspace, {
					workspaceId: workspace.workspaceId,
					accountId: workspace.accountId,
					chatId: workspace.chatId,
					sessionId: workspace.initialSessionId,
					turnId: "turn:workspace-resume",
					commandId: "launch:workspace-resume",
					ciphertext: "encrypted-launch-intent",
					expiresAtMs: nowMs + 86_400_000,
					createdAtMs: nowMs,
				});
				yield* Ref.update(control.sandboxes, (sandboxes) =>
					new Map(sandboxes).set(workspace.providerSandboxId, {
						providerSandboxId: workspace.providerSandboxId,
						providerLabel: "zuse-cloud-workspace-workspace-resume",
						state: "running",
					}),
				);

				yield* reconcileCloudWorkspace(workspace.workspaceId);
				const paused = yield* store.getWorkspace(workspace.workspaceId);
				yield* store.recordActivity(
					workspace.workspaceId,
					workspace.accountId,
					nowMs + 1,
					nowMs + 600_001,
				);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				const warming = yield* store.getWorkspace(workspace.workspaceId);
				const callsBeforeFallback = yield* Ref.get(control.startProcessCalls);
				// If the provider preserved the runtime, its gateway reconnect callback
				// advances the workspace to ready before this retry. When no callback
				// arrives, the next reconciliation performs the existing hard restart.
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				const resumed = yield* store.getWorkspace(workspace.workspaceId);
				const resumeBeforeMissing = yield* Ref.get(control.resumeInputs);
				if (resumed === null) return yield* Effect.die("workspace disappeared");
				yield* Ref.update(control.sandboxes, (sandboxes) => {
					const next = new Map(sandboxes);
					next.delete(workspace.providerSandboxId);
					return next;
				});
				yield* store.saveWorkspace({
					...resumed,
					state: "paused",
					desiredState: "ready",
					runtimeState: "offline",
					statusCode: "resume-queued",
					nextActionAtMs: nowMs + 2,
					revision: resumed.revision + 1,
					updatedAtMs: nowMs + 2,
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					paused,
					warming,
					workspace: resumed,
					missing: yield* store.getWorkspace(workspace.workspaceId),
					callsBeforeFallback,
					resumeBeforeMissing,
					resumeInputs: yield* Ref.get(control.resumeInputs),
					startProcessCalls: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.paused).toMatchObject({
			state: "paused",
			statusCode: "paused",
			runtimeState: "offline",
		});
		expect(result.paused?.leaseOwner).toBeUndefined();
		expect(result.resumeBeforeMissing).toHaveLength(1);
		expect(result.callsBeforeFallback).toHaveLength(0);
		expect(result.warming).toMatchObject({
			state: "resuming",
			statusCode: "resume-runtime-waking",
			runtimeState: "connecting",
		});
		// One chmod for the boot token and one runtime launch. Resume must not
		// serialize extra remote process calls before starting the runtime.
		expect(result.startProcessCalls).toHaveLength(2);
		expect(result.workspace).toMatchObject({
			state: "provisioning",
			statusCode: "resume-runtime-restarting",
			runtimeState: "offline",
		});
		expect(result.workspace?.runtimeBootTokenHash).toBeTruthy();
		expect(result.missing).toMatchObject({
			state: "queued",
			providerSandboxId: undefined,
			statusCode: "provider-sandbox-replacing",
			runtimeState: "offline",
		});
		expect(result.missing?.leaseOwner).toBeUndefined();
	});

	test("restart of a running workspace relaunches the runtime in place", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-restart",
					state: "resuming",
					desiredState: "ready",
					statusCode: "restart-queued",
					requestConfig: {},
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					resumeInputs: yield* Ref.get(control.resumeInputs),
					startProcessCalls: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		// The sandbox is already running, so restart must not call provider
		// resume — only stage a boot token and relaunch the runtime process.
		expect(result.resumeInputs).toHaveLength(0);
		expect(result.startProcessCalls).toHaveLength(2);
		expect(result.workspace).toMatchObject({
			state: "provisioning",
			statusCode: "resume-runtime-restarting",
			runtimeState: "offline",
		});
		expect(result.workspace?.runtimeBootTokenHash).toBeTruthy();
	});
});
