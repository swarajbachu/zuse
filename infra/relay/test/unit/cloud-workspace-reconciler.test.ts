import {
	FakeSandboxProviderControlService,
	SandboxProvidersFake,
} from "@zuse/sandbox-providers/testing";
import { Effect, Layer, Redacted, Ref } from "effect";
import { describe, expect, test } from "vitest";
import { CloudCredentialVault } from "../../src/cloud-credential-vault.ts";
import {
	reconcileCloudWorkspace,
	reusableAccountBuildSnapshot,
	sanitizeProjectBuildDiagnostic,
	WORKSPACE_ARCHIVE_SCRIPT,
	WORKSPACE_RUNTIME_PROCESS_PATTERN,
	WORKSPACE_RUNTIME_RESUME_COMMAND,
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
	SandboxProvidersFake,
	Layer.succeed(SandboxOfferConfiguration, {
		port: 47_837,
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
		recoveryBundleKey: input.recoveryBundleKey,
		warmRetentionDeadlineMs: input.warmRetentionDeadlineMs,
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

	test("archive quiesces the current versioned runtime before bundling", () => {
		expect(WORKSPACE_ARCHIVE_SCRIPT).toContain(
			WORKSPACE_RUNTIME_PROCESS_PATTERN,
		);
		expect(WORKSPACE_ARCHIVE_SCRIPT).toContain(
			"exec /usr/local/bin/zuse-archive-workspace",
		);
	});

	test("the resume launcher does not match its own stale-runtime kill pattern", () => {
		expect(
			new RegExp(WORKSPACE_RUNTIME_PROCESS_PATTERN).test(
				WORKSPACE_RUNTIME_RESUME_COMMAND,
			),
		).toBe(false);
	});

	test("the resume launcher starts the downloaded runtime with the supported CLI", () => {
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).toContain(
			'exec node "$runtime" serve',
		);
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).not.toContain("--foreground");
	});

	test("the resumed runtime survives release of the provider process stream", () => {
		expect(WORKSPACE_RUNTIME_RESUME_COMMAND).toContain("nohup");
		expect(WORKSPACE_RUNTIME_RESUME_COMMAND).toMatch(/&$/u);
	});

	test("resume starts the installed runtime without blocking on an update", () => {
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).not.toContain("runtime-updater");
	});

	test("publishes archive recovery only after a quarantined fork validates it", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "archive-recovery",
					state: "archiving",
					desiredState: "archived",
					statusCode: "archive-hook-running",
					requestConfig: { runtimeGeneration: 7, gatewayEpoch: 11 },
				});
				yield* Ref.update(control.pathsBySandbox, (paths) =>
					new Map(paths).set(
						workspace.providerSandboxId as string,
						new Set(["/var/lib/zuse/workspace-archive/ready"]),
					),
				);

				yield* reconcileCloudWorkspace(workspace.workspaceId);
				const verifying = yield* store.getWorkspace(workspace.workspaceId);
				const verifierId = `fake-${workspace.workspaceId}-archive-verify`;
				yield* Ref.update(control.pathsBySandbox, (paths) =>
					new Map(paths).set(
						verifierId,
						new Set(["/var/lib/zuse/workspace-restore/ready"]),
					),
				);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				const published = yield* store.getWorkspace(workspace.workspaceId);
				const sandboxesBeforeArchive = yield* Ref.get(control.sandboxes);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					verifying,
					published,
					archived: yield* store.getWorkspace(workspace.workspaceId),
					sandboxesBeforeArchive,
					sandboxes: yield* Ref.get(control.sandboxes),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.verifying).toMatchObject({
			statusCode: "archive-snapshot-verifying",
			recoveryBundleKey: undefined,
		});
		expect(result.published?.recoveryBundleKey).toMatch(/^provider-snapshot:/u);
		expect(result.sandboxesBeforeArchive.has("source-archive-recovery")).toBe(
			true,
		);
		expect(result.archived).toMatchObject({
			state: "archived",
			statusCode: "archived",
		});
		expect(result.sandboxes.has("source-archive-recovery")).toBe(true);
	});

	test("failed staging restore keeps both the verified snapshot and warm source", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const snapshotId = "snapshot-restore-rollback";
				const workspace = yield* seedWorkspace({
					workspaceId: "restore-rollback",
					state: "archived",
					desiredState: "ready",
					statusCode: "archived",
					recoveryBundleKey: `provider-snapshot:${snapshotId}`,
					requestConfig: { runtimeGeneration: 4, gatewayEpoch: 8 },
				});
				yield* Ref.update(control.snapshots, (snapshots) =>
					new Set(snapshots).add(snapshotId),
				);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				const stagingId = `fake-${workspace.workspaceId}-restore-staging`;
				yield* Ref.update(control.pathsBySandbox, (paths) =>
					new Map(paths).set(
						stagingId,
						new Set(["/var/lib/zuse/workspace-restore/failed"]),
					),
				);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					sandboxes: yield* Ref.get(control.sandboxes),
					snapshots: yield* Ref.get(control.snapshots),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.workspace).toMatchObject({
			state: "archived",
			desiredState: "archived",
			statusCode: "recovery-validation-failed",
			providerSandboxId: "source-restore-rollback",
			recoveryBundleKey: "provider-snapshot:snapshot-restore-rollback",
		});
		expect(result.sandboxes.has("source-restore-rollback")).toBe(true);
		expect(result.snapshots.has("snapshot-restore-rollback")).toBe(true);
	});

	test("promotes a verified restore with a new fence and deletes warm source only after health", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const snapshotId = "snapshot-restore-promote";
				const workspace = yield* seedWorkspace({
					workspaceId: "restore-promote",
					state: "archived",
					desiredState: "ready",
					statusCode: "archived",
					recoveryBundleKey: `provider-snapshot:${snapshotId}`,
					requestConfig: { runtimeGeneration: 4, gatewayEpoch: 8 },
				});
				yield* Ref.update(control.snapshots, (snapshots) =>
					new Set(snapshots).add(snapshotId),
				);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				const stagingId = `fake-${workspace.workspaceId}-restore-staging`;
				yield* Ref.update(control.pathsBySandbox, (paths) =>
					new Map(paths).set(
						stagingId,
						new Set(["/var/lib/zuse/workspace-restore/ready"]),
					),
				);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				const promoted = yield* store.getWorkspace(workspace.workspaceId);
				if (promoted === null)
					return yield* Effect.die("workspace disappeared");
				const beforeHealth = yield* Ref.get(control.sandboxes);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				const starting = yield* store.getWorkspace(workspace.workspaceId);
				if (starting === null)
					return yield* Effect.die("workspace disappeared during start");
				yield* store.saveWorkspace({
					...starting,
					state: "ready",
					runtimeState: "online",
					statusCode: "ready",
					nextActionAtMs: Date.now(),
					revision: starting.revision + 1,
					updatedAtMs: starting.updatedAtMs + 1,
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					promoted,
					starting,
					beforeHealth,
					healthy: yield* store.getWorkspace(workspace.workspaceId),
					afterHealth: yield* Ref.get(control.sandboxes),
					snapshots: yield* Ref.get(control.snapshots),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.promoted).toMatchObject({
			providerSandboxId: "fake-restore-promote-restore-staging",
			state: "resuming",
			statusCode: "recovery-promoted-runtime-starting",
			recoveryBundleKey: "provider-snapshot:snapshot-restore-promote",
			requestConfig: {
				runtimeGeneration: 5,
				gatewayEpoch: 9,
				recoveryWarmSourceSandboxId: "source-restore-promote",
			},
		});
		expect(result.promoted?.requestConfig.streamEpoch).toEqual(
			result.promoted?.requestConfig.restoreStreamEpoch,
		);
		expect(result.starting).toMatchObject({
			state: "provisioning",
			requestConfig: { runtimeGeneration: 5, gatewayEpoch: 9 },
		});
		expect(result.beforeHealth.has("source-restore-promote")).toBe(true);
		expect(result.afterHealth.has("source-restore-promote")).toBe(false);
		expect(result.afterHealth.has("fake-restore-promote-restore-staging")).toBe(
			true,
		);
		expect(result.healthy?.recoveryBundleKey).toBe(
			"provider-snapshot:snapshot-restore-promote",
		);
		expect(result.healthy?.requestConfig.recoveryWarmSourceSandboxId).toBe(
			undefined,
		);
		expect(result.snapshots.has("snapshot-restore-promote")).toBe(true);
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
});
