import {
	FakeSandboxProviderControlService,
	SandboxProvidersFake,
} from "@zuse/sandbox-providers/testing";
import { Effect, Layer, Redacted, Ref } from "effect";
import { describe, expect, test } from "vitest";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import { cloudRepositoryWorkspacePath } from "../../src/cloud-workspace-paths.ts";
import {
	ARCHIVED_WORKSPACE_RETENTION_MS,
	cloudWorkspaceStartupNeedsObservation,
	RUNTIME_CONNECTION_TIMEOUT_MS,
	reconcileCloudWorkspace,
	reusableAccountBuildSnapshot,
	sanitizeProjectBuildDiagnostic,
	sanitizeProjectBuildLog,
	snapshotSanitizationFailures,
	WORKSPACE_RUNTIME_RESUME_SCRIPT,
	WORKSPACE_START_OBSERVATION_MS,
	workspaceRuntimeProcessSelector,
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
		apiIssuer: "https://api.test",
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
	test("maps GitHub repositories to stable folders outside the runtime home", () => {
		expect(cloudRepositoryWorkspacePath("github.com/swarajbachu/zuse")).toBe(
			"/home/repos/swarajbachu/zuse",
		);
		expect(() =>
			cloudRepositoryWorkspacePath("github.com/owner/../escape"),
		).toThrow("Unsupported repository identity");
	});

	test("cleans untagged runtimes when replacing after a memory pause", () => {
		expect(workspaceRuntimeProcessSelector()).toMatchObject({
			tag: "zuse-runtime",
			legacyCleanup: "matching-command",
			legacyCommandMarkers: expect.arrayContaining([
				"zuse-workspace-bootstrap",
				"/usr/local/bin/zuse serve",
			]),
		});
	});
	test("updates a stale baked runtime when resuming even if wire-compatible", () => {
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).toContain(
			"/opt/zuse/current/bin.mjs",
		);
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).toContain("serve --foreground");
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).not.toContain("installed_wire");
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).toContain("runtime-updater.mjs");
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).toContain(
			"ZUSE_RUNTIME_INSTALL_ONLY=1",
		);
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).toContain(
			'exec node "$runtime" serve >> "$log" 2>&1',
		);
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).not.toContain("nohup");
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).not.toContain("</dev/null &");
	});

	test("actively observes startup and the bounded warm-resume window", () => {
		expect(RUNTIME_CONNECTION_TIMEOUT_MS).toBe(10_000);
		expect(WORKSPACE_START_OBSERVATION_MS).toBeGreaterThan(
			RUNTIME_CONNECTION_TIMEOUT_MS,
		);
		expect(
			cloudWorkspaceStartupNeedsObservation({
				state: "resuming",
				runtimeState: "connecting",
			}),
		).toBe(true);
		expect(
			cloudWorkspaceStartupNeedsObservation({
				state: "provisioning",
				runtimeState: "offline",
			}),
		).toBe(true);
		expect(
			cloudWorkspaceStartupNeedsObservation({
				state: "setup",
				runtimeState: "connecting",
			}),
		).toBe(false);
		expect(
			cloudWorkspaceStartupNeedsObservation({
				state: "failed",
				runtimeState: "offline",
			}),
		).toBe(false);
	});

	test("forks instead of resuming a paused pool sandbox", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-incomplete-retry",
					state: "queued",
					desiredState: "ready",
					statusCode: "resume-queued",
					requestConfig: { startupTimings: { requestedAt: Date.now() } },
				});
				const warmSandboxId = "warm-incomplete-retry";
				yield* Ref.update(control.sandboxes, (sandboxes) =>
					new Map(sandboxes).set(warmSandboxId, {
						providerSandboxId: warmSandboxId,
						providerLabel: "warm-incomplete-retry",
						state: "paused",
					}),
				);
				yield* store.savePool({
					poolId: "pool-incomplete-retry",
					accountId: workspace.accountId,
					provider: workspace.provider,
					imageGeneration: workspace.buildId,
					providerSandboxId: warmSandboxId,
					state: "available",
					createdAtMs: Date.now(),
					updatedAtMs: Date.now(),
				});

				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					pool: yield* store.listPool(workspace.accountId, workspace.provider),
					sandboxes: yield* Ref.get(control.sandboxes),
					network: yield* Ref.get(control.networkBySandbox),
					resumeInputs: yield* Ref.get(control.resumeInputs),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.workspace).toMatchObject({
			state: "provisioning",
			providerSandboxId: "fake-workspace-incomplete-retry",
			statusCode: "runtime-starting",
		});
		expect(result.workspace?.requestConfig.poolClaimedAt).toEqual(
			expect.any(Number),
		);
		expect(result.pool).toContainEqual(
			expect.objectContaining({
				state: "claimed",
				claimedWorkspaceId: "workspace-incomplete-retry",
			}),
		);
		expect(result.sandboxes.has("source-workspace-incomplete-retry")).toBe(
			false,
		);
		expect(result.sandboxes.has("warm-incomplete-retry")).toBe(false);
		expect(result.resumeInputs).toHaveLength(0);
		expect(result.network.get("fake-workspace-incomplete-retry")).toEqual({
			kind: "quarantined",
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

	test("retains full sanitized build output without retaining secrets", () => {
		const log = sanitizeProjectBuildLog(
			`starting\nAPI_KEY=super-secret-value\nclone https://user:password@github.com/acme/private.git\n${"a".repeat(10_000)}`,
		);

		expect(log).toContain("starting");
		expect(log).not.toContain("super-secret-value");
		expect(log).not.toContain("password");
		expect(log.length).toBeLessThanOrEqual(256 * 1_024);
	});

	test("reports the exact safe snapshot validation failures", () => {
		expect(
			snapshotSanitizationFailures({
				forbiddenPaths: ["/home/zuse/.netrc"],
				forbiddenResults: [true],
				sourceCommit: "not-a-digest",
				templateVersion: "old-runtime",
				expectedTemplateVersion: "current-runtime",
				configurationDigest: "same-config",
				expectedConfigurationDigest: "same-config",
			}),
		).toEqual([
			"/home/zuse/.netrc",
			"invalid source manifest digest",
			"runtime version mismatch",
		]);
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
					deleteAt,
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.workspace?.nextActionAtMs).toBe(result.deleteAt);
		expect(result.workspace).toMatchObject({
			state: "archived",
			desiredState: "archived",
			statusCode: "archived",
			nextActionAtMs: expect.any(Number),
			providerSandboxId: "source-archive-paused",
		});
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
					networkBySandbox: yield* Ref.get(control.networkBySandbox),
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
		// The boot token travels directly to the runtime process. Resume must not
		// serialize a remote file write and chmod before starting it.
		expect(result.startProcessCalls).toHaveLength(1);
		expect(result.workspace).toMatchObject({
			state: "provisioning",
			statusCode: "resume-runtime-restarting",
			runtimeState: "offline",
		});
		expect(result.workspace?.nextActionAtMs).toBe(
			(result.workspace?.updatedAtMs ?? 0) + RUNTIME_CONNECTION_TIMEOUT_MS,
		);
		expect(result.workspace?.runtimeBootTokenHash).toBeTruthy();
		expect(result.networkBySandbox.get("sandbox-resume")).toEqual({
			kind: "open",
		});
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
		// resume — it relaunches the runtime with a fresh in-memory boot token.
		expect(result.resumeInputs).toHaveLength(0);
		expect(result.startProcessCalls).toHaveLength(1);
		expect(result.workspace).toMatchObject({
			state: "provisioning",
			statusCode: "resume-runtime-restarting",
			runtimeState: "offline",
		});
		expect(result.workspace?.runtimeBootTokenHash).toBeTruthy();
	});
});
