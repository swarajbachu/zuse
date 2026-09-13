import { CLOUD_COMMAND_PROTOCOL_VERSION } from "@zuse/contracts";
import {
	FakeSandboxProviderControlService,
	SandboxProvidersFake,
} from "@zuse/sandbox-providers/testing";
import { Effect, Layer, Redacted, Ref } from "effect";
import { describe, expect, test, vi } from "vitest";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import { cloudRepositoryWorkspacePath } from "../../src/cloud-workspace-paths.ts";
import {
	ARCHIVED_WORKSPACE_RETENTION_MS,
	cloudWorkspaceHasRetainedRuntimeData,
	cloudWorkspaceStartupNeedsObservation,
	MAILBOX_RUNTIME_STALL_TIMEOUT_MS,
	RUNTIME_CONNECTION_TIMEOUT_MS,
	reconcileCloudResourceBatch,
	reconcileCloudResources,
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

const apiTestConfig = {
	apiIssuer: "https://api.test",
	workosJwksUrl: "https://unused.test/jwks",
	workosIssuer: "https://unused.test",
	mintPrivateKey: Redacted.make("{}"),
	mintPublicKey: '{"kty":"OKP"}',
} as const;

const makeTestLayer = (cloudCommandMailboxEnabled = false) =>
	Layer.mergeAll(
		Config.layer({
			...apiTestConfig,
			cloudCommandMailboxEnabled,
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

const testLayer = makeTestLayer();
const mailboxEnabledTestLayer = makeTestLayer(true);

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
	test("isolates reconciliation defects so later resources still run", async () => {
		const error = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		try {
			const completed = await Effect.runPromise(
				Effect.gen(function* () {
					const completed = yield* Ref.make<ReadonlyArray<string>>([]);
					yield* reconcileCloudResourceBatch({
						resourceKind: "workspace",
						items: ["broken", "healthy"],
						resourceId: (id) => id,
						concurrency: 1,
						reconcile: (id) =>
							id === "broken"
								? Effect.die("unexpected provider defect")
								: Ref.update(completed, (ids) => [...ids, id]),
					});
					return yield* Ref.get(completed);
				}),
			);

			expect(completed).toEqual(["healthy"]);
			expect(error).toHaveBeenCalledWith(
				"[cloud-workspace] isolated reconciliation failure",
				expect.objectContaining({
					resourceKind: "workspace",
					resourceId: "broken",
				}),
			);
		} finally {
			error.mockRestore();
		}
	});

	test("retires unsupported legacy providers without starving due workspaces", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const unsupported = yield* seedWorkspace({
					workspaceId: "workspace-unsupported-provider",
					state: "paused",
					desiredState: "ready",
					statusCode: "resume-queued",
					requestConfig: {},
				});
				yield* store.saveWorkspace({
					...unsupported,
					provider: "box",
					revision: unsupported.revision + 1,
					updatedAtMs: unsupported.updatedAtMs + 1,
				});
				const healthy = yield* seedWorkspace({
					workspaceId: "workspace-supported-provider",
					state: "paused",
					desiredState: "ready",
					statusCode: "resume-queued",
					requestConfig: {},
				});

				yield* reconcileCloudResources();
				return {
					unsupported: yield* store.getWorkspace(unsupported.workspaceId),
					healthy: yield* store.getWorkspace(healthy.workspaceId),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.unsupported).toMatchObject({
			state: "failed",
			runtimeState: "offline",
			statusCode: "provider-unavailable",
			nextActionAtMs: Number.MAX_SAFE_INTEGER,
		});
		expect(result.healthy).toMatchObject({
			state: "resuming",
			runtimeState: "connecting",
			statusCode: "resume-runtime-waking",
		});
	});

	test("recognizes established runtime storage before provider replacement", () => {
		expect(
			cloudWorkspaceHasRetainedRuntimeData({
				statusCode: "agent-running",
				requestConfig: {},
			}),
		).toBe(true);
		expect(
			cloudWorkspaceHasRetainedRuntimeData({
				statusCode: "runtime-starting",
				requestConfig: { sessionHeadVersion: 0 },
			}),
		).toBe(true);
		expect(
			cloudWorkspaceHasRetainedRuntimeData({
				statusCode: "runtime-starting",
				requestConfig: {},
			}),
		).toBe(false);
	});

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
			"/var/lib/zuse/workspace/credentials-ready",
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
				state: "ready",
				runtimeState: "online",
				requestConfig: {
					cloudMailboxWakePending: true,
					cloudMailboxRuntimeSeenAt: Date.now(),
				},
			}),
		).toBe(false);
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
		expect(
			cloudWorkspaceStartupNeedsObservation({
				state: "ready",
				runtimeState: "online",
				requestConfig: { cloudMailboxWakePending: true },
			}),
		).toBe(true);
	});

	test("rechecks provider state when a queued restart auto-paused before cron", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-restart-auto-paused",
					state: "resuming",
					desiredState: "ready",
					statusCode: "restart-queued",
					requestConfig: { runtimeGeneration: 4, gatewayEpoch: 4 },
				});
				yield* Ref.update(control.sandboxes, (sandboxes) => {
					const next = new Map(sandboxes);
					const sandbox = next.get(workspace.providerSandboxId ?? "");
					if (sandbox !== undefined)
						next.set(sandbox.providerSandboxId, {
							...sandbox,
							state: "paused",
						});
					return next;
				});

				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					resumeInputs: yield* Ref.get(control.resumeInputs),
					startProcessCalls: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.resumeInputs).toEqual([
			{ timeoutSeconds: 600, onTimeout: "pause" },
		]);
		expect(result.startProcessCalls).toEqual([
			"source-workspace-restart-auto-paused",
		]);
	});

	test("gives an enrolled runtime a fresh gateway connection window", async () => {
		const enrolledAt = Date.now();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-runtime-authenticating",
					state: "setup",
					desiredState: "ready",
					statusCode: "runtime-authenticating",
					runtimeState: "connecting",
					requestConfig: {
						startupTimings: {
							allocatedAt: enrolledAt - RUNTIME_CONNECTION_TIMEOUT_MS - 1,
							enrolledAt,
						},
					},
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return yield* store.getWorkspace(workspace.workspaceId);
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result).toMatchObject({
			state: "setup",
			statusCode: "runtime-authenticating",
			runtimeState: "connecting",
			nextActionAtMs: enrolledAt + RUNTIME_CONNECTION_TIMEOUT_MS,
		});
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
			kind: "open",
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

	test("rejects an image missing the provider-auth sanitation capability", () => {
		expect(
			snapshotSanitizationFailures({
				forbiddenPaths: [],
				forbiddenResults: [],
				sourceCommit: "a".repeat(64),
				templateVersion: "runtime",
				expectedTemplateVersion: "runtime",
				configurationDigest: "config",
				expectedConfigurationDigest: "config",
				expectedProviderAuthDeliveryVersion: 1,
			}),
		).toEqual(["Provider auth delivery capability mismatch"]);
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
			requestConfig: {
				destructionFence: 1,
				cloudMailboxLifecyclePending: {
					action: "archive",
					destructionFence: 1,
				},
			},
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
			requestConfig: {
				destructionFence: 2,
				cloudMailboxLifecyclePending: {
					action: "delete",
					destructionFence: 2,
				},
			},
		});
		expect(result.deleted).toMatchObject({
			state: "deleted",
			providerSandboxId: undefined,
			requestConfig: {
				destructionFence: 2,
				cloudMailboxLifecyclePending: {
					action: "delete",
					destructionFence: 2,
				},
			},
		});
		expect(result.sandboxes.has("source-expired-archive")).toBe(false);
	});

	test("preserves a paused runtime and refuses a storage-destructive replacement", async () => {
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
					requestConfig: { sessionHeadVersion: 5 },
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
			state: "failed",
			providerSandboxId: undefined,
			statusCode: "runtime-storage-replaced",
			runtimeState: "offline",
			nextActionAtMs: Number.MAX_SAFE_INTEGER,
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

	test("wakes a ready workspace whose preserved runtime is offline", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-ready-offline",
					state: "ready",
					desiredState: "ready",
					runtimeState: "offline",
					statusCode: "resume-queued",
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

		expect(result.resumeInputs).toHaveLength(1);
		expect(result.startProcessCalls).toHaveLength(0);
		expect(result.workspace).toMatchObject({
			state: "resuming",
			runtimeState: "connecting",
			statusCode: "resume-runtime-waking",
		});
	});

	test("restarts a retained v2 runtime when mailbox rollout is enabled", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-mailbox-v2-upgrade",
					state: "paused",
					desiredState: "ready",
					runtimeState: "offline",
					statusCode: "resume-queued",
					requestConfig: { runtimeGeneration: 2, gatewayEpoch: 2 },
				});
				const providerSandboxId = workspace.providerSandboxId;
				if (providerSandboxId === undefined)
					return yield* Effect.die("seeded workspace has no sandbox");
				yield* Ref.update(control.sandboxes, (sandboxes) =>
					new Map(sandboxes).set(providerSandboxId, {
						providerSandboxId,
						providerLabel: `zuse-cloud-workspace-${workspace.workspaceId}`,
						state: "paused",
					}),
				);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					resumeInputs: yield* Ref.get(control.resumeInputs),
					startProcessCalls: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(mailboxEnabledTestLayer)),
		);

		expect(result.resumeInputs).toHaveLength(1);
		expect(result.startProcessCalls).toEqual([
			"source-workspace-mailbox-v2-upgrade",
		]);
		expect(result.workspace).toMatchObject({
			state: "provisioning",
			runtimeState: "offline",
			statusCode: "resume-runtime-restarting",
			requestConfig: { runtimeGeneration: 3, gatewayEpoch: 3 },
		});
	});

	test("warm-resumes a retained v3 runtime when mailbox rollout is enabled", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-mailbox-v3-warm",
					state: "paused",
					desiredState: "ready",
					runtimeState: "offline",
					statusCode: "resume-queued",
					requestConfig: {
						runtimeGeneration: 2,
						gatewayEpoch: 2,
						cloudCommandProtocolVersion: CLOUD_COMMAND_PROTOCOL_VERSION,
						cloudCommandRuntimeGeneration: 2,
					},
				});
				const providerSandboxId = workspace.providerSandboxId;
				if (providerSandboxId === undefined)
					return yield* Effect.die("seeded workspace has no sandbox");
				yield* Ref.update(control.sandboxes, (sandboxes) =>
					new Map(sandboxes).set(providerSandboxId, {
						providerSandboxId,
						providerLabel: `zuse-cloud-workspace-${workspace.workspaceId}`,
						state: "paused",
					}),
				);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					resumeInputs: yield* Ref.get(control.resumeInputs),
					startProcessCalls: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(mailboxEnabledTestLayer)),
		);

		expect(result.resumeInputs).toHaveLength(1);
		expect(result.startProcessCalls).toHaveLength(0);
		expect(result.workspace).toMatchObject({
			state: "resuming",
			runtimeState: "connecting",
			statusCode: "resume-runtime-waking",
			requestConfig: {
				cloudCommandProtocolVersion: CLOUD_COMMAND_PROTOCOL_VERSION,
				cloudCommandRuntimeGeneration: 2,
			},
		});
	});

	test("inspects and wakes a provider-paused runtime after mailbox acceptance", async () => {
		const staleObservationAt = Date.now() - 60_000;
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-mailbox-provider-paused",
					state: "ready",
					desiredState: "ready",
					runtimeState: "online",
					statusCode: "agent-running",
					requestConfig: {
						cloudMailboxWakePending: true,
						cloudMailboxWakeRequestedAt: staleObservationAt,
						cloudMailboxRuntimeSeenAt: staleObservationAt,
						cloudMailboxProgressAt: staleObservationAt,
						cloudMailboxProgressRevision: 4,
					},
				});
				const providerSandboxId = workspace.providerSandboxId;
				if (providerSandboxId === undefined)
					return yield* Effect.die("seeded workspace has no sandbox");
				yield* Ref.update(control.sandboxes, (sandboxes) =>
					new Map(sandboxes).set(providerSandboxId, {
						providerSandboxId,
						providerLabel: `zuse-cloud-workspace-${workspace.workspaceId}`,
						state: "paused",
					}),
				);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					resumeInputs: yield* Ref.get(control.resumeInputs),
					startProcessCalls: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.resumeInputs).toHaveLength(1);
		expect(result.startProcessCalls).toHaveLength(0);
		expect(result.workspace).toMatchObject({
			state: "resuming",
			runtimeState: "connecting",
			statusCode: "resume-runtime-waking",
			requestConfig: {
				cloudMailboxWakePending: true,
				cloudMailboxWakeRequestedAt: expect.any(Number),
			},
		});
		expect(result.workspace?.requestConfig).not.toHaveProperty(
			"cloudMailboxRuntimeSeenAt",
		);
		expect(result.workspace?.requestConfig).not.toHaveProperty(
			"cloudMailboxProgressAt",
		);
	});

	test("gives a running mailbox consumer time to acknowledge before replacement", async () => {
		const requestedAt = Date.now();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-mailbox-consumer-starting",
					state: "ready",
					desiredState: "ready",
					runtimeState: "online",
					statusCode: "agent-running",
					requestConfig: {
						cloudMailboxWakePending: true,
						cloudMailboxWakeRequestedAt: requestedAt,
					},
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					resumeInputs: yield* Ref.get(control.resumeInputs),
					startProcessCalls: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.resumeInputs).toHaveLength(0);
		expect(result.startProcessCalls).toHaveLength(0);
		expect(result.workspace).toMatchObject({
			state: "ready",
			runtimeState: "online",
			requestConfig: { cloudMailboxWakePending: true },
		});
		expect(result.workspace?.nextActionAtMs).toBeGreaterThan(requestedAt);
	});

	test("extends liveness only when the durable mailbox revision progresses", async () => {
		const nowMs = Date.now();
		const progressAt = nowMs - 1_000;
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-mailbox-progressing",
					state: "ready",
					desiredState: "ready",
					runtimeState: "online",
					statusCode: "agent-running",
					requestConfig: {
						cloudMailboxWakePending: true,
						cloudMailboxWakeRequestedAt: nowMs - 60_000,
						cloudMailboxRuntimeSeenAt: nowMs - 60_000,
						cloudMailboxProgressAt: progressAt,
						cloudMailboxProgressRevision: 9,
					},
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					startProcessCalls: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.startProcessCalls).toHaveLength(0);
		expect(result.workspace?.nextActionAtMs).toBe(
			progressAt + MAILBOX_RUNTIME_STALL_TIMEOUT_MS,
		);
	});

	test("fences a runtime after durable mailbox progress stalls", async () => {
		const stalledAt = Date.now() - MAILBOX_RUNTIME_STALL_TIMEOUT_MS - 1;
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-mailbox-progress-stalled",
					state: "ready",
					desiredState: "ready",
					runtimeState: "online",
					statusCode: "agent-running",
					requestConfig: {
						runtimeGeneration: 8,
						gatewayEpoch: 8,
						cloudMailboxWakePending: true,
						cloudMailboxWakeRequestedAt: stalledAt,
						cloudMailboxRuntimeSeenAt: stalledAt,
						cloudMailboxProgressAt: stalledAt,
						cloudMailboxProgressRevision: 12,
					},
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					startProcessCalls: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.startProcessCalls).toHaveLength(1);
		expect(result.workspace).toMatchObject({
			state: "provisioning",
			requestConfig: {
				runtimeGeneration: 9,
				cloudMailboxWakePending: true,
			},
		});
		expect(result.workspace?.requestConfig).not.toHaveProperty(
			"cloudMailboxProgressAt",
		);
	});

	test("retries a transient provider probe without stranding an accepted command", async () => {
		const before = Date.now();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-mailbox-provider-transient",
					state: "ready",
					desiredState: "ready",
					runtimeState: "online",
					statusCode: "agent-running",
					requestConfig: {
						cloudMailboxWakePending: true,
						cloudMailboxWakeRequestedAt: Date.now(),
					},
				});
				yield* Ref.set(control.failNextInspect, true);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return yield* store.getWorkspace(workspace.workspaceId);
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result).toMatchObject({
			state: "ready",
			runtimeState: "online",
			statusCode: "agent-running",
			requestConfig: { cloudMailboxWakePending: true },
		});
		expect(result?.nextActionAtMs).toBeGreaterThanOrEqual(before + 5_000);
		expect(result?.nextActionAtMs).not.toBe(Number.MAX_SAFE_INTEGER);
	});

	test("fences and replaces a running process that never reaches its mailbox", async () => {
		const requestedAt = Date.now() - 5_000;
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-mailbox-consumer-missing",
					state: "ready",
					desiredState: "ready",
					runtimeState: "online",
					statusCode: "agent-running",
					requestConfig: {
						runtimeGeneration: 4,
						gatewayEpoch: 4,
						cloudMailboxWakePending: true,
						cloudMailboxWakeRequestedAt: requestedAt,
					},
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					resumeInputs: yield* Ref.get(control.resumeInputs),
					startProcessCalls: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.resumeInputs).toHaveLength(0);
		expect(result.startProcessCalls).toHaveLength(1);
		expect(result.workspace).toMatchObject({
			state: "provisioning",
			runtimeState: "offline",
			statusCode: "resume-runtime-restarting",
			requestConfig: {
				runtimeGeneration: 5,
				gatewayEpoch: 5,
				cloudMailboxWakePending: true,
			},
		});
	});
});
