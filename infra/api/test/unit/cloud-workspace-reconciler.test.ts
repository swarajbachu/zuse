import { CLOUD_COMMAND_PROTOCOL_VERSION } from "@zuse/contracts";
import {
	SandboxProviderError,
	SandboxProviders,
} from "@zuse/sandbox-providers";
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
	MAILBOX_RUNTIME_STALL_TIMEOUT_MS,
	RUNTIME_CONNECTION_TIMEOUT_MS,
	reconcileCloudBuild,
	reconcileCloudResourceBatch,
	reconcileCloudResources,
	reconcileCloudWorkspace,
	reconcileCloudWorkspaceStartup,
	reusableAccountBuildSnapshot,
	sanitizeProjectBuildDiagnostic,
	sanitizeProjectBuildLog,
	snapshotSanitizationFailures,
	WORKSPACE_RUNTIME_RESUME_SCRIPT,
	workspaceRuntimeProcessSelector,
	workspaceRuntimeReconnectTarget,
} from "../../src/cloud-workspace-reconciler.ts";
import { cloudWorkspaceResumeTarget } from "../../src/cloud-workspace-routes.ts";
import {
	type CloudProjectBuildRecord,
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import * as Config from "../../src/config.ts";
import { SandboxOfferConfiguration } from "../../src/sandbox-provider-module.ts";

vi.mock("../../../cloud-sandboxes/workspace-runtime.sh", async () => {
	const { readFile } = await import("node:fs/promises");
	return {
		default: await readFile(
			new URL("../../../cloud-sandboxes/workspace-runtime.sh", import.meta.url),
			"utf8",
		),
	};
});

const apiTestConfig = {
	apiIssuer: "https://api.test",
	workosJwksUrl: "https://unused.test/jwks",
	workosIssuer: "https://unused.test",
	mintPrivateKey: Redacted.make("{}"),
	mintPublicKey: '{"kty":"OKP"}',
	cloudDataEncryptionKey: Redacted.make(
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	),
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
			createTimeoutSeconds: 3_600,
			keepAliveTimeoutSeconds: 600,
		}),
	);

const testLayer = makeTestLayer();
const mailboxEnabledTestLayer = makeTestLayer(true);

test.each([
	"rejected",
	"transient",
] as const)("persists snapshot failure %s instead of leaving a silent lease", async (code) => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const workspace = yield* seedWorkspace({
				workspaceId: "snapshot-error",
				requestConfig: {},
				state: "ready",
				desiredState: "ready",
				statusCode: "ready",
			});
			const store = yield* CloudWorkspaceStore;
			const build = yield* store.getBuild(workspace.buildId);
			if (build === null) throw new Error("Missing build");
			const project = yield* store.getProject(build.projectId ?? "");
			if (project === null) throw new Error("Missing project");
			yield* store.saveProject({ ...project, state: "preparing" });
			yield* store.saveBuild({
				...build,
				state: "sanitizing",
				snapshotId: undefined,
				providerSandboxId: workspace.providerSandboxId,
				logText: "Setup complete",
				nextActionAtMs: 0,
			});
			const providers = yield* SandboxProviders;
			const provider = yield* providers.get(build.provider);
			yield* reconcileCloudBuild(build.buildId).pipe(
				Effect.provideService(SandboxProviders, {
					...providers,
					get: () =>
						Effect.succeed({
							...provider,
							snapshot: () => Effect.fail(new SandboxProviderError({ code })),
						}),
				}),
			);
			const result = yield* store.getBuild(build.buildId);
			expect(result?.state).toBe(code === "rejected" ? "failed" : "sanitizing");
			expect(result?.lastErrorCode).toBe(`snapshot-${code}`);
			expect(result?.logText).toContain("Setup complete");
			expect(result?.logText).toContain(`Snapshot publication: ${code}`);
			expect(result?.nextActionAtMs).toBeGreaterThan(Date.now());
			if (code === "rejected") {
				expect(result?.providerSandboxId).toBeUndefined();
				expect(yield* provider.inspect("source-snapshot-error")).toBeNull();
				expect((yield* store.getProject(build.projectId ?? ""))?.state).toBe(
					"failed",
				);
			}
		}).pipe(Effect.provide(testLayer)),
	);
});

describe("queued image builds that cannot start", () => {
	const reconcileQueued = (
		workspaceId: string,
		override: {
			readonly recoverByLabel?: (
				label: string,
			) => Effect.Effect<null, SandboxProviderError>;
			readonly create?: () => Effect.Effect<never, SandboxProviderError>;
		},
		updatedAtMs = Date.now(),
	) =>
		Effect.gen(function* () {
			const workspace = yield* seedWorkspace({
				workspaceId,
				requestConfig: {},
				state: "ready",
				desiredState: "ready",
				statusCode: "ready",
			});
			const store = yield* CloudWorkspaceStore;
			const build = yield* store.getBuild(workspace.buildId);
			if (build === null) throw new Error("Missing build");
			yield* store.saveBuild({
				...build,
				state: "queued",
				snapshotId: undefined,
				providerSandboxId: undefined,
				logText: undefined,
				idempotencyKey: `account-image:rebuild:${workspaceId}`,
				nextActionAtMs: 0,
				updatedAtMs,
			});
			const providers = yield* SandboxProviders;
			const provider = yield* providers.get(build.provider);
			const exit = yield* reconcileCloudBuild(build.buildId).pipe(
				Effect.provideService(SandboxProviders, {
					...providers,
					get: () =>
						Effect.succeed({
							...provider,
							...(override.recoverByLabel === undefined
								? {}
								: { recoverByLabel: override.recoverByLabel }),
							...(override.create === undefined
								? {}
								: { create: override.create }),
						}),
				}),
				Effect.exit,
			);
			return { exit, build: yield* store.getBuild(build.buildId) };
		});

	test("fails visibly when the provider refuses the machine lookup", async () => {
		const { build } = await Effect.runPromise(
			reconcileQueued("queued-lookup-rejected", {
				recoverByLabel: () =>
					Effect.fail(new SandboxProviderError({ code: "rejected" })),
			}).pipe(Effect.provide(testLayer)),
		);
		expect(build?.state).toBe("failed");
		expect(build?.lastErrorCode).toBe("provider-rejected");
		expect(build?.logText).toContain("permission denied");
		expect(build?.nextActionAtMs).toBe(Number.MAX_SAFE_INTEGER);
	});

	test("fails visibly when the provider refuses machine creation", async () => {
		const { build } = await Effect.runPromise(
			reconcileQueued("queued-create-rejected", {
				recoverByLabel: () => Effect.succeed(null),
				create: () =>
					Effect.fail(new SandboxProviderError({ code: "rejected" })),
			}).pipe(Effect.provide(testLayer)),
		);
		expect(build?.state).toBe("failed");
		expect(build?.lastErrorCode).toBe("provider-rejected");
	});

	test("retries transient start failures, then gives up after the start window", async () => {
		const transient = {
			recoverByLabel: () =>
				Effect.fail(new SandboxProviderError({ code: "transient" })),
		};
		const recent = await Effect.runPromise(
			reconcileQueued("queued-transient", transient).pipe(
				Effect.provide(testLayer),
			),
		);
		expect(recent.exit._tag).toBe("Failure");
		expect(recent.build?.state).toBe("queued");
		const stale = await Effect.runPromise(
			reconcileQueued("queued-stale", transient, Date.now() - 16 * 60_000).pipe(
				Effect.provide(testLayer),
			),
		);
		expect(stale.build?.state).toBe("failed");
		expect(stale.build?.lastErrorCode).toBe("project-start-timeout");
		expect(stale.build?.logText).toContain("could not start");
	});
});

test("resumes a persisted snapshot stage after the original worker exits", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const workspace = yield* seedWorkspace({
				workspaceId: "snapshot-retry",
				requestConfig: {},
				state: "ready",
				desiredState: "ready",
				statusCode: "ready",
			});
			const store = yield* CloudWorkspaceStore;
			const build = yield* store.getBuild(workspace.buildId);
			if (build === null) throw new Error("Missing fixture build");
			yield* store.saveBuild({
				...build,
				state: "sanitizing",
				snapshotId: undefined,
				providerSandboxId: workspace.providerSandboxId,
				logText: "Repositories prepared",
				nextActionAtMs: 0,
			});
			yield* reconcileCloudBuild(build.buildId);
			const resumed = yield* store.getBuild(build.buildId);
			expect(resumed?.state).toBe("ready");
			expect(resumed?.snapshotId).toBeDefined();
			expect(resumed?.logText).toContain("Repositories prepared");
		}).pipe(Effect.provide(testLayer)),
	);
});

test("recovers snapshot promotion after the worker exits during sandbox cleanup", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const workspace = yield* seedWorkspace({
				workspaceId: "snapshot-cleanup",
				requestConfig: {},
				state: "ready",
				desiredState: "ready",
				statusCode: "ready",
			});
			const store = yield* CloudWorkspaceStore;
			const build = yield* store.getBuild(workspace.buildId);
			if (build === null) throw new Error("Missing build");
			yield* store.saveBuild({
				...build,
				state: "sanitizing",
				snapshotId: undefined,
				providerSandboxId: workspace.providerSandboxId,
				nextActionAtMs: 0,
			});
			const providers = yield* SandboxProviders;
			const provider = yield* providers.get(build.provider);
			const snapshot = vi.fn(provider.snapshot);
			yield* reconcileCloudBuild(build.buildId).pipe(
				Effect.provideService(SandboxProviders, {
					...providers,
					get: () =>
						Effect.succeed({
							...provider,
							snapshot,
							kill: (id) =>
								provider
									.kill(id)
									.pipe(Effect.andThen(Effect.die("worker exited"))),
						}),
				}),
				Effect.exit,
			);
			expect((yield* store.getBuild(build.buildId))?.snapshotId).toBeDefined();
			yield* reconcileCloudBuild(build.buildId).pipe(
				Effect.provideService(SandboxProviders, {
					...providers,
					get: () => Effect.succeed({ ...provider, snapshot }),
				}),
			);
			expect(snapshot).toHaveBeenCalledTimes(1);
			expect((yield* store.getBuild(build.buildId))?.state).toBe("ready");
			expect(
				(yield* store.getBuild(build.buildId))?.providerSandboxId,
			).toBeUndefined();
		}).pipe(Effect.provide(testLayer)),
	);
});

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
		runtimeCredentialHash: input.runtimeCredentialHash,
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
	test.each([
		false,
		true,
	])("native machine fork prepares identity before opening networking (recovered=%s)", async (recovered) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const providers = yield* SandboxProviders;
				const base = yield* providers.get("fake");
				const seeded = yield* seedWorkspace({
					workspaceId: "native-child",
					state: "queued",
					desiredState: "ready",
					statusCode: "start-queued",
					requestConfig: {},
				});
				const source = {
					...seeded,
					workspaceId: "native-parent",
					provider: "boxd",
					providerSandboxId: "parent-vm",
					state: "ready" as const,
					chatId: "parent-chat",
				};
				yield* store.saveWorkspace(source);
				yield* store.saveWorkspace({
					...seeded,
					revision: seeded.revision + 1,
					provider: "boxd",
					providerSandboxId: undefined,
					requestConfig: {
						machineFork: {
							workspaceId: source.workspaceId,
							providerSandboxId: "parent-vm",
							chatId: source.chatId,
							sessionId: "source-session",
							messageId: "fork-point",
						},
					},
				});
				const child = {
					providerSandboxId: "child-vm",
					providerLabel: "child",
					state: "running" as const,
				};
				const events: string[] = [];
				let prepared = false;
				const forkMachine = vi.fn(() => Effect.succeed(child));
				const adapter = {
					...base,
					providerId: "boxd",
					forkMachine,
					recoverByLabel: () => Effect.succeed(recovered ? child : null),
					extendTimeout: () => Effect.void,
					writeTextFile: () => Effect.void,
					pathExists: (_id: string, path: string) =>
						Effect.succeed(path.endsWith("/prepared") && prepared),
					setNetwork: (id: string, policy: { kind: string }) =>
						Effect.sync(() => {
							events.push(`${id}:${policy.kind}`);
							if (id === "child-vm" && policy.kind === "open")
								expect(prepared).toBe(true);
						}),
					replaceProcess: (
						_id: string,
						_selector: unknown,
						input: { env?: Readonly<Record<string, string>> },
					) =>
						Effect.gen(function* () {
							expect(
								(yield* store.getWorkspace(seeded.workspaceId))
									?.providerSandboxId,
							).toBe("child-vm");
							if (input.env?.ZUSE_FORK_SESSION_ID !== undefined) {
								expect(events).toContain("child-vm:quarantined");
								expect(input.env.ZUSE_FORK_SESSION_ID).toBe("source-session");
								prepared = true;
								events.push("prepared");
							} else {
								expect(prepared).toBe(true);
								expect(input.env?.ZUSE_CLOUD_WORKSPACE_ID).toBe("native-child");
								expect(input.env?.ZUSE_FORK_CHECKOUT).toBe("1");
								events.push("bootstrap");
							}
						}),
				};
				yield* reconcileCloudWorkspace(seeded.workspaceId).pipe(
					Effect.provideService(SandboxProviders, {
						...providers,
						get: () => Effect.succeed(adapter),
					}),
				);
				expect(forkMachine).toHaveBeenCalledTimes(1);
				expect(events.slice(-3)).toEqual([
					"prepared",
					"child-vm:open",
					"bootstrap",
				]);
				expect((yield* store.getWorkspace(seeded.workspaceId))?.state).toBe(
					"provisioning",
				);
				expect(
					(yield* store.getWorkspace(source.workspaceId))?.requestConfig
						.forkNetworkRestorePending,
				).toBeUndefined();
				const launched = yield* store.getWorkspace(seeded.workspaceId);
				if (launched === null) throw new Error("Fork workspace missing");
				// The runtime can consume enrollment before its launch response reaches
				// the API. The durable operation must adopt that owner on retry.
				yield* store.saveWorkspace({
					...launched,
					runtimeBootTokenHash: undefined,
					runtimeCredentialHash: "enrolled-child",
					revision: launched.revision + 1,
					updatedAtMs: launched.updatedAtMs + 1,
				});
				events.length = 0;
				yield* reconcileCloudWorkspace(seeded.workspaceId).pipe(
					Effect.provideService(SandboxProviders, {
						...providers,
						get: () => Effect.succeed(adapter),
					}),
				);
				expect(events).toEqual([]);
				expect(forkMachine).toHaveBeenCalledTimes(1);
				const adopted = yield* store.getWorkspace(seeded.workspaceId);
				expect(adopted).toMatchObject({
					providerSandboxId: "child-vm",
					runtimeCredentialHash: "enrolled-child",
					requestConfig: {
						runtimeGeneration: launched.requestConfig.runtimeGeneration,
						gatewayEpoch: launched.requestConfig.gatewayEpoch,
						runtimeActivation: launched.requestConfig.runtimeActivation,
					},
				});
			}).pipe(Effect.provide(testLayer)),
		);
	});

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

	test("fails expired startup without calling into an unavailable sandbox", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const workspace = yield* seedWorkspace({
					workspaceId: "expired-setup",
					state: "setup",
					desiredState: "ready",
					statusCode: "agent-starting",
					requestConfig: {
						startupTimings: { enrolledAt: Date.now() - 60_000 },
						runtimeCredentialExpiresAtMs: Date.now() + 60_000,
					},
				});
				const store = yield* CloudWorkspaceStore;
				yield* store.saveWorkspace({
					...workspace,
					runtimeCredentialHash: "old-runtime",
				});
				const provider = yield* (yield* SandboxProviders).get("fake");
				const pathExists = vi
					.spyOn(provider, "pathExists")
					.mockReturnValue(
						Effect.fail(new SandboxProviderError({ code: "transient" })),
					);
				try {
					yield* reconcileCloudWorkspace(workspace.workspaceId);
					expect(pathExists).not.toHaveBeenCalled();
					return yield* store.getWorkspace(workspace.workspaceId);
				} finally {
					pathExists.mockRestore();
				}
			}).pipe(Effect.provide(testLayer)),
		);
		expect(result).toMatchObject({
			state: "failed",
			runtimeState: "offline",
			statusCode: "runtime-connection-timeout",
			nextActionAtMs: Number.MAX_SAFE_INTEGER,
		});
		expect(result?.runtimeCredentialHash).toBeUndefined();
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
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).toContain(
			"ZUSE_RUNTIME_ACTIVATION_MODE",
		);
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).not.toContain(
			"ensure_workspace_runtime 1",
		);
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).toContain(
			'"$status_dir/credentials-ready"',
		);
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).toContain(
			`exec_workspace_runtime "\${ZUSE_RUNTIME_NODE:-node}" "$runtime" serve >> "$log" 2>&1`,
		);
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).not.toContain("nohup");
		expect(WORKSPACE_RUNTIME_RESUME_SCRIPT).not.toContain("</dev/null &");
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

	test("renews a running machine before replacing its runtime", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-restart-running",
					state: "resuming",
					desiredState: "ready",
					statusCode: "restart-queued",
					requestConfig: { runtimeGeneration: 4, gatewayEpoch: 4 },
				});
				const provider = yield* (yield* SandboxProviders).get("fake");
				const extend = vi.spyOn(provider, "extendTimeout");
				const replace = vi.spyOn(provider, "replaceProcess");
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				expect(extend).toHaveBeenCalledWith(workspace.providerSandboxId, 600);
				const replacementOrder = replace.mock.invocationCallOrder[0];
				if (replacementOrder === undefined)
					throw new Error("runtime not replaced");
				expect(extend.mock.invocationCallOrder[0]).toBeLessThan(
					replacementOrder,
				);
				extend.mockRestore();
				replace.mockRestore();
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test.each([
		{ age: 40_000, state: "provisioning", expected: "provisioning" },
		{ age: 130_000, state: "provisioning", expected: "failed" },
		{ age: 40_000, state: "setup", expected: "failed" },
	] as const)("bounds runtime installation separately from enrollment: $state / $age", async ({
		age,
		state,
		expected,
	}) => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const now = Date.now();
				const workspace = yield* seedWorkspace({
					workspaceId: "install-window",
					state,
					desiredState: "ready",
					statusCode: "resume-runtime-restarting",
					requestConfig: {
						runtimeInstallPending: true,
						// Deadline remains terminal once bounded replacement retries are exhausted.
						runtimeLaunchRecoveryAttempts: 2,
						startupTimings: {
							allocatedAt: now - age,
							...(state === "setup" ? { enrolledAt: now - age } : {}),
						},
					},
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return yield* (yield* CloudWorkspaceStore).getWorkspace(
					workspace.workspaceId,
				);
			}).pipe(Effect.provide(testLayer)),
		);
		expect(result?.state).toBe(expected);
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

	test("starts the pinned image through a fenced operation without fetching the channel", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-old-image",
					state: "queued",
					desiredState: "ready",
					statusCode: "start-queued",
					requestConfig: {},
				});
				const control = yield* FakeSandboxProviderControlService;
				yield* Ref.set(control.sandboxes, new Map());
				const provider = yield* (yield* SandboxProviders).get("fake");
				const start = vi.spyOn(provider, "replaceProcess");
				const write = vi.spyOn(provider, "writeTextFile");
				yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
					Effect.provideService(SandboxOfferConfiguration, {
						port: 47837,
						createTimeoutSeconds: 3600,
						keepAliveTimeoutSeconds: 600,
						runtimeManifestUrl: "https://runtime.test/manifest.json",
						runtimeSigningPublicJwk: "public-key",
					}),
				);
				expect(start).toHaveBeenCalledWith(
					"fake-workspace-old-image",
					expect.anything(),
					expect.objectContaining({
						env: expect.objectContaining({
							ZUSE_RUNTIME_MANIFEST_URL: "https://runtime.test/manifest.json",
							ZUSE_RUNTIME_WIRE_PROTOCOL: "6",
							ZUSE_RUNTIME_PUBLIC_KEY_FILE:
								"/home/zuse/.zuse-runtime-signing-public.jwk",
						}),
					}),
				);
				expect(write).toHaveBeenCalledWith(
					"fake-workspace-old-image",
					"/home/zuse/.zuse-runtime-signing-public.jwk",
					"public-key",
					"zuse",
				);
				const args = start.mock.calls[0]?.[2].args?.join(" ") ?? "";
				expect(args).not.toContain("runtime-updater.mjs");
				expect(args).toContain("ensure_workspace_runtime\nexec /bin/bash");
				const saved = yield* (yield* CloudWorkspaceStore).getWorkspace(
					workspace.workspaceId,
				);
				expect(saved?.requestConfig.runtimeInstallPending).toBe(false);
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test.each([
		true,
		false,
	])("idempotent allocation skips lookup only for new protocol requests: %s", async (newProtocol) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-direct-allocation",
					state: "queued",
					desiredState: "ready",
					statusCode: "start-queued",
					requestConfig: newProtocol
						? { allocationProtocol: "provider-idempotent-v1" }
						: {},
				});
				yield* Ref.set(control.sandboxes, new Map());
				yield* store.saveWorkspace({
					...workspace,
					providerSandboxId: undefined,
					revision: workspace.revision + 1,
				});
				const providers = yield* SandboxProviders;
				const provider = yield* providers.get("fake");
				const recover = vi.spyOn(provider, "recoverByLabel");
				const fork = vi.spyOn(provider, "fork");
				const extend = vi.spyOn(provider, "extendTimeout");
				yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
					Effect.provideService(SandboxProviders, {
						...providers,
						get: () =>
							Effect.succeed({
								...provider,
								supportsIdempotentAllocation: true,
								configuresAllocationTimeout: true,
							}),
					}),
				);
				expect(recover).toHaveBeenCalledTimes(newProtocol ? 0 : 1);
				expect(fork).toHaveBeenCalledTimes(1);
				expect(extend).not.toHaveBeenCalled();
				const saved = yield* store.getWorkspace(workspace.workspaceId);
				expect(saved?.providerSandboxId).toBe(
					"fake-workspace-direct-allocation",
				);
				expect(saved?.requestConfig.runtimeActivation).toBeDefined();
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test.each([
		"running",
		"paused",
	] as const)("reuses a %s allocation with a fresh startup window", async (recoveredState) => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-on-demand",
					state: "queued",
					desiredState: "ready",
					statusCode: "start-queued",
					requestConfig: { startupTimings: { requestedAt: Date.now() } },
				});
				yield* Ref.set(control.sandboxes, new Map());
				yield* store.saveWorkspace({
					...workspace,
					providerSandboxId: undefined,
					revision: workspace.revision + 1,
				});
				const provider = yield* (yield* SandboxProviders).get("fake");
				const start = vi.spyOn(provider, "replaceProcess");
				const extend = vi.spyOn(provider, "extendTimeout");
				const resume = vi.spyOn(provider, "resume");
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				expect(start).toHaveBeenCalledWith(
					"fake-workspace-on-demand",
					expect.anything(),
					expect.objectContaining({
						command: "/bin/bash",
						args: [
							"-lc",
							expect.stringContaining(
								"exec /bin/bash /var/lib/zuse/project-build/workspace-bootstrap.sh",
							),
						],
					}),
				);
				expect(extend).toHaveBeenCalledWith("fake-workspace-on-demand", 600);
				const originalActivation = start.mock.calls[0]?.[2].activation;
				start.mockClear();
				extend.mockClear();
				const allocated = yield* store.getWorkspace(workspace.workspaceId);
				if (allocated === null) throw new Error("workspace missing");
				// Retry a queued allocation after the provider succeeded but its
				// response was lost: recover by workspace label instead of forking again.
				yield* Ref.update(control.sandboxes, (sandboxes) => {
					const updated = new Map(sandboxes);
					const sandbox = updated.get("fake-workspace-on-demand");
					if (!sandbox) throw new Error("sandbox missing");
					updated.set(sandbox.providerSandboxId, {
						...sandbox,
						state: recoveredState,
					});
					return updated;
				});
				yield* store.saveWorkspace({
					...allocated,
					state: "queued",
					providerSandboxId: undefined,
					revision: allocated.revision + 1,
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				const renewed = recoveredState === "paused" ? resume : extend;
				expect(renewed).toHaveBeenCalledTimes(1);
				expect(start).toHaveBeenCalledTimes(1);
				expect(start.mock.calls[0]?.[2].activation).toEqual(originalActivation);
				const startOrder = start.mock.invocationCallOrder[0];
				if (startOrder === undefined)
					throw new Error("bootstrap did not start");
				expect(renewed.mock.invocationCallOrder[0]).toBeLessThan(startOrder);
				start.mockRestore();
				extend.mockRestore();
				resume.mockRestore();
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					sandboxes: yield* Ref.get(control.sandboxes),
				};
			}).pipe(Effect.provide(testLayer)),
		);
		expect(result.sandboxes.size).toBe(1);
		expect(result.workspace?.providerSandboxId).toBe(
			"fake-workspace-on-demand",
		);
	});

	test("allocates only the requested replacement sandbox", async () => {
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
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
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
		expect(result.sandboxes.has("source-workspace-incomplete-retry")).toBe(
			false,
		);
		expect(result.sandboxes.size).toBe(1);
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
				// Missing callbacks do not establish process death. The provider must
				// prove no managed or legacy runtime remains before replacement.
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				if ((yield* Ref.get(control.startProcessCalls)).length !== 0)
					return yield* Effect.die(
						"warm runtime restarted before grace deadline",
					);
				if (warming === null) return yield* Effect.die("workspace disappeared");
				yield* store.saveWorkspace({
					...warming,
					nextActionAtMs: Date.now() - 1,
					revision: warming.revision + 1,
					updatedAtMs: warming.updatedAtMs + 1,
				});
				const providers = yield* SandboxProviders;
				const adapter = yield* providers.get(workspace.provider);
				yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
					Effect.provideService(SandboxProviders, {
						...providers,
						get: () =>
							Effect.succeed({
								...adapter,
								inspectProcess: () => Effect.succeed("inactive" as const),
							}),
					}),
				);
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
			(result.workspace?.updatedAtMs ?? 0) + 5_000,
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

	test("replaces a runtime only after reconnect grace and confirmed guest process absence", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-unresponsive-runtime",
					state: "ready",
					desiredState: "ready",
					runtimeState: "online",
					statusCode: "agent-running",
					requestConfig: { runtimeGeneration: 1, sessionHeadVersion: 18 },
				});
				const providers = yield* SandboxProviders;
				const adapter = yield* providers.get(workspace.provider);
				const inspectProcess = vi.fn(() => Effect.succeed("inactive" as const));
				const reconcile = reconcileCloudWorkspace(workspace.workspaceId).pipe(
					Effect.provideService(SandboxProviders, {
						...providers,
						get: () => Effect.succeed({ ...adapter, inspectProcess }),
					}),
				);
				const checking = workspaceRuntimeReconnectTarget(workspace, Date.now());
				yield* store.saveWorkspace(checking);
				yield* reconcile;
				expect(yield* Ref.get(control.startProcessCalls)).toHaveLength(0);
				expect(inspectProcess).not.toHaveBeenCalled();
				expect(
					(yield* store.getWorkspace(workspace.workspaceId))?.requestConfig
						.runtimeGeneration,
				).toBe(1);
				const current = yield* store.getWorkspace(workspace.workspaceId);
				if (current === null) return yield* Effect.die("workspace disappeared");
				yield* store.saveWorkspace({
					...current,
					nextActionAtMs: Date.now() - 1,
					revision: current.revision + 1,
					updatedAtMs: current.updatedAtMs + 1,
				});
				yield* reconcile;
				expect(inspectProcess).toHaveBeenCalledWith(
					workspace.providerSandboxId,
					workspaceRuntimeProcessSelector(),
					"zuse",
				);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					starts: yield* Ref.get(control.startProcessCalls),
					resumes: yield* Ref.get(control.resumeInputs),
				};
			}).pipe(Effect.provide(testLayer)),
		);
		expect(result.starts).toHaveLength(1);
		expect(result.resumes).toHaveLength(0);
		expect(result.workspace).toMatchObject({
			state: "provisioning",
			statusCode: "resume-runtime-restarting",
			providerSandboxId: "source-workspace-unresponsive-runtime",
			requestConfig: { runtimeGeneration: 2, sessionHeadVersion: 18 },
		});
	});

	test.each([
		"active",
		"unknown",
		"missing",
		"transient",
	] as const)("preserves runtime authority when reconnect times out and process observation is %s", async (observation) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const providers = yield* SandboxProviders;
				const workspace = yield* seedWorkspace({
					workspaceId: `preserved-${observation}`,
					state: "ready",
					desiredState: "ready",
					runtimeState: "online",
					statusCode: "agent-running",
					requestConfig: {
						runtimeGeneration: 12,
						gatewayEpoch: 12,
						sessionHeadVersion: 19,
					},
				});
				const adapter = yield* providers.get(workspace.provider);
				const { inspectProcess: _unused, ...withoutProbe } = adapter;
				const inspectProcess = vi.fn(
					(): Effect.Effect<"active" | "unknown", SandboxProviderError> =>
						observation === "transient"
							? Effect.fail(new SandboxProviderError({ code: "transient" }))
							: Effect.succeed(observation === "active" ? "active" : "unknown"),
				);
				yield* store.saveWorkspace({
					...workspaceRuntimeReconnectTarget(workspace, Date.now()),
					runtimeCredentialHash: "retained-runtime-credential",
					runtimeBootTokenHash: "retained-boot-hash",
					runtimeBootTokenExpiresAtMs: Date.now() + 60_000,
					nextActionAtMs: Date.now() - 1,
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
					Effect.provideService(SandboxProviders, {
						...providers,
						get: () =>
							Effect.succeed({
								...withoutProbe,
								...(observation === "missing" ? {} : { inspectProcess }),
							}),
					}),
				);
				const preserved = yield* store.getWorkspace(workspace.workspaceId);
				expect(preserved).toMatchObject({
					providerSandboxId: workspace.providerSandboxId,
					chatId: workspace.chatId,
					initialSessionId: workspace.initialSessionId,
					state: "resuming",
					runtimeCredentialHash: "retained-runtime-credential",
					runtimeBootTokenHash: "retained-boot-hash",
					requestConfig: {
						runtimeGeneration: 12,
						gatewayEpoch: 12,
						sessionHeadVersion: 19,
					},
				});
				expect(yield* Ref.get(control.startProcessCalls)).toHaveLength(0);
				expect(yield* Ref.get(control.resumeInputs)).toHaveLength(0);
				expect(yield* Ref.get(control.createCalls)).toBe(0);
				expect(
					(yield* Ref.get(control.sandboxes)).get(
						workspace.providerSandboxId ?? "",
					)?.state,
				).toBe("running");
				expect(preserved?.nextActionAtMs).toBeGreaterThan(Date.now());
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test.each([
		{ attempts: 0, failed: false },
		{ attempts: 1, failed: false },
		{ attempts: 2, failed: false },
		{ attempts: 0, failed: true },
	])("recovers an interrupted replacement launch in place, bounded at two retries (%s)", async ({
		attempts,
		failed,
	}) => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-interrupted-replacement",
					state: "provisioning",
					desiredState: "ready",
					statusCode: "resume-runtime-restarting",
					requestConfig: {
						runtimeGeneration: 23,
						sessionHeadVersion: 708,
						runtimeLaunchRecoveryAttempts: attempts,
						startupTimings: { allocatedAt: Date.now() - 20 * 60_000 },
					},
				});
				const providers = yield* SandboxProviders;
				const adapter = yield* providers.get(workspace.provider);
				const replacement = {
					...providers,
					get: (id: string) =>
						id === workspace.provider && failed
							? Effect.succeed({
									...adapter,
									pathExists: (_id: string, path: string) =>
										Effect.succeed(path.endsWith("/failed")),
									readTextFile: (_id: string, path: string) =>
										Effect.succeed(
											path.endsWith("/failure-phase") ? "repository-setup" : "",
										),
								})
							: providers.get(id),
				};
				yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
					Effect.provideService(SandboxProviders, replacement),
				);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					starts: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(testLayer)),
		);
		expect(result.workspace?.providerSandboxId).toBe(
			"source-workspace-interrupted-replacement",
		);
		expect(result.workspace?.requestConfig.sessionHeadVersion).toBe(708);
		expect(result.starts).toHaveLength(!failed && attempts < 2 ? 1 : 0);
		expect(result.workspace?.state).toBe(
			!failed && attempts < 2 ? "provisioning" : "failed",
		);
		if (failed)
			expect(result.workspace?.statusCode).toBe("repository-setup-failed");
		if (!failed && attempts < 2) {
			expect(result.workspace?.requestConfig.runtimeGeneration).toBe(24);
			expect(
				result.workspace?.requestConfig.runtimeLaunchRecoveryAttempts,
			).toBe(attempts + 1);
		}
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
					requestConfig: { runtimeLaunchRecoveryAttempts: 2 },
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					resumeInputs: yield* Ref.get(control.resumeInputs),
					startProcessCalls: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.workspace?.requestConfig.runtimeLaunchRecoveryAttempts).toBe(
			0,
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

	test("overlaps restart preparation and waits for network readiness before launch", async () => {
		let resolveFile!: () => void;
		const fileWritten = new Promise<void>((resolve) => {
			resolveFile = resolve;
		});
		let networkReady = false;
		let launched = false;
		await Effect.runPromise(
			Effect.gen(function* () {
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-parallel-preparation",
					state: "resuming",
					desiredState: "ready",
					statusCode: "restart-queued",
					requestConfig: {},
				});
				const providers = yield* SandboxProviders;
				yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
					Effect.provideService(SandboxOfferConfiguration, {
						port: 47837,
						createTimeoutSeconds: 3600,
						keepAliveTimeoutSeconds: 600,
						runtimeSigningPublicJwk: "public-key",
					}),
					Effect.provideService(SandboxProviders, {
						...providers,
						get: (id) =>
							providers.get(id).pipe(
								Effect.map((adapter) => ({
									...adapter,
									setNetwork: () =>
										Effect.promise(async () => {
											await fileWritten;
											networkReady = true;
										}),
									writeTextFile: (...args) =>
										adapter
											.writeTextFile(...args)
											.pipe(Effect.tap(() => Effect.sync(() => resolveFile()))),
									replaceProcess: (...args) =>
										Effect.sync(() => {
											expect(networkReady).toBe(true);
											launched = true;
										}).pipe(Effect.andThen(adapter.replaceProcess(...args))),
								})),
							),
					}),
				);
			}).pipe(Effect.provide(testLayer)),
		);
		expect(launched).toBe(true);
	});

	test("does not launch the runtime when parallel network preparation fails", async () => {
		let launched = false;
		await Effect.runPromise(
			Effect.gen(function* () {
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-network-failed",
					state: "resuming",
					desiredState: "ready",
					statusCode: "restart-queued",
					requestConfig: {},
				});
				const providers = yield* SandboxProviders;
				yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
					Effect.provideService(SandboxProviders, {
						...providers,
						get: (id) =>
							providers.get(id).pipe(
								Effect.map((adapter) => ({
									...adapter,
									setNetwork: () =>
										Effect.fail(
											new SandboxProviderError({ code: "transient" }),
										),
									replaceProcess: (...args) =>
										Effect.sync(() => {
											launched = true;
										}).pipe(Effect.andThen(adapter.replaceProcess(...args))),
								})),
							),
					}),
				);
			}).pipe(Effect.provide(testLayer)),
		);
		expect(launched).toBe(false);
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

	test("cold-resumes disk snapshots with a fenced restart without mailbox rollout", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-cold-resume",
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
				const providers = yield* SandboxProviders;
				const adapter = yield* providers.get(workspace.provider);
				yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
					Effect.provideService(SandboxProviders, {
						...providers,
						get: (id) =>
							providers.get(id).pipe(
								Effect.map((value) => ({
									...value,
									preservesProcessesOnResume: false,
								})),
							),
						getDefault: Effect.succeed({
							...adapter,
							preservesProcessesOnResume: false,
						}),
					}),
				);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					resumeInputs: yield* Ref.get(control.resumeInputs),
					startProcessCalls: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.resumeInputs).toHaveLength(1);
		expect(result.startProcessCalls).toEqual(["source-workspace-cold-resume"]);
		expect(result.workspace).toMatchObject({
			state: "provisioning",
			runtimeState: "offline",
			statusCode: "resume-runtime-restarting",
			requestConfig: { runtimeGeneration: 3, gatewayEpoch: 3 },
		});
	});

	test.each([
		"lost",
		"unknown",
	] as const)("uses resume continuity %s without treating unknown as process death", async (processContinuity) => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const workspace = yield* seedWorkspace({
					workspaceId: `continuity-${processContinuity}`,
					state: "paused",
					desiredState: "ready",
					runtimeState: "offline",
					runtimeCredentialHash: "retained-owner",
					statusCode: "resume-queued",
					requestConfig: {
						runtimeGeneration: 4,
						gatewayEpoch: 4,
						sessionHeadVersion: 9,
						cloudCommandProtocolVersion: CLOUD_COMMAND_PROTOCOL_VERSION,
						cloudCommandRuntimeGeneration: 4,
					},
				});
				const providers = yield* SandboxProviders;
				yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
					Effect.provideService(SandboxProviders, {
						...providers,
						get: (id) =>
							providers.get(id).pipe(
								Effect.map((adapter) => ({
									...adapter,
									preservesProcessesOnResume: true,
									resume: (...args) =>
										adapter.resume(...args).pipe(
											Effect.map((sandbox) => ({
												...sandbox,
												processContinuity,
											})),
										),
								})),
							),
					}),
				);
				const control = yield* FakeSandboxProviderControlService;
				return {
					workspace: yield* (yield* CloudWorkspaceStore).getWorkspace(
						workspace.workspaceId,
					),
					starts: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(testLayer)),
		);
		expect(result.starts).toHaveLength(processContinuity === "lost" ? 1 : 0);
		expect(result.workspace?.requestConfig.runtimeGeneration).toBe(
			processContinuity === "lost" ? 5 : 4,
		);
		if (processContinuity === "unknown")
			expect(result.workspace?.runtimeCredentialHash).toBe("retained-owner");
		expect(result.workspace?.requestConfig.sessionHeadVersion).toBe(9);
	});

	test("gives a retained runtime its reconnect grace after a slow provider resume", async () => {
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
				const providers = yield* SandboxProviders;
				let providerReturnedAt = 0;
				yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
					Effect.provideService(SandboxProviders, {
						...providers,
						get: (id) =>
							providers.get(id).pipe(
								Effect.map((adapter) => ({
									...adapter,
									resume: (...args) =>
										adapter.resume(...args).pipe(
											Effect.tap(() => Effect.sleep("600 millis")),
											Effect.tap(() =>
												Effect.sync(() => {
													providerReturnedAt = Date.now();
												}),
											),
										),
								})),
							),
					}),
				);
				return {
					providerReturnedAt,
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					resumeInputs: yield* Ref.get(control.resumeInputs),
					startProcessCalls: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(mailboxEnabledTestLayer)),
		);

		expect(result.workspace?.nextActionAtMs).toBeGreaterThanOrEqual(
			result.providerReturnedAt + 12_000,
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

	test.each([
		true,
		false,
	])("wakes a mailbox runtime with process preservation=%s", async (preservesProcessesOnResume) => {
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
				const providers = yield* SandboxProviders;
				yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
					Effect.provideService(SandboxProviders, {
						...providers,
						get: (id) =>
							providers.get(id).pipe(
								Effect.map((adapter) => ({
									...adapter,
									preservesProcessesOnResume,
								})),
							),
					}),
				);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					resumeInputs: yield* Ref.get(control.resumeInputs),
					startProcessCalls: yield* Ref.get(control.startProcessCalls),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.resumeInputs).toHaveLength(1);
		expect(result.startProcessCalls).toHaveLength(
			preservesProcessesOnResume ? 0 : 1,
		);
		expect(result.workspace).toMatchObject({
			state: preservesProcessesOnResume ? "resuming" : "provisioning",
			runtimeState: preservesProcessesOnResume ? "connecting" : "offline",
			statusCode: preservesProcessesOnResume
				? "resume-runtime-waking"
				: "resume-runtime-restarting",
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

test.each([
	"transient",
	"rejected",
] as const)("retains the sandbox and classifies %s deletion failures", async (code) => {
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* CloudWorkspaceStore;
			const workspace = yield* seedWorkspace({
				workspaceId: "failed-cleanup",
				statusCode: "delete-queued",
				desiredState: "deleted",
				state: "archived",
				requestConfig: {
					cloudMailboxLifecyclePending: {
						action: "delete",
						destructionFence: 1,
					},
				},
			});
			const providers = yield* SandboxProviders;
			yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
				Effect.provideService(SandboxProviders, {
					...providers,
					get: (id) =>
						providers.get(id).pipe(
							Effect.map((adapter) => ({
								...adapter,
								kill: () => Effect.fail(new SandboxProviderError({ code })),
							})),
						),
				}),
			);
			return yield* store.getWorkspace(workspace.workspaceId);
		}).pipe(Effect.provide(testLayer)),
	);
	expect(result?.providerSandboxId).toBe("source-failed-cleanup");
	expect(result?.statusCode).toBe(
		code === "rejected" ? "delete-rejected" : "delete-retrying",
	);
	if (code === "rejected")
		expect(result?.nextActionAtMs).toBe(Number.MAX_SAFE_INTEGER);
	else expect(result?.nextActionAtMs).toBeLessThan(Date.now() + 60_000);
});

test.each([
	false,
	true,
])("durably schedules startup regardless of process preservation: %s", async (preservesProcessesOnResume) => {
	const schedule = vi.fn(async () => {});
	await Effect.runPromise(
		Effect.gen(function* () {
			const workspace = yield* seedWorkspace({
				workspaceId: "workspace-startup-routing",
				state: "paused",
				desiredState: "paused",
				statusCode: "paused",
				requestConfig: {},
			});
			const providers = yield* SandboxProviders;
			yield* reconcileCloudWorkspaceStartup(
				workspace.workspaceId,
				schedule,
			).pipe(
				Effect.provideService(SandboxProviders, {
					...providers,
					get: (id) =>
						providers.get(id).pipe(
							Effect.map((adapter) => ({
								...adapter,
								preservesProcessesOnResume,
							})),
						),
				}),
			);
		}).pipe(Effect.provide(testLayer)),
	);
	expect(schedule).toHaveBeenCalledExactlyOnceWith("workspace-startup-routing");
});

describe("memory-aware runtime recovery", () => {
	test.each([
		{
			name: "pressure waits",
			available: 100,
			kills: 0,
			attempts: 0,
			age: 0,
			status: "runtime-memory-pressure",
			launches: 0,
		},
		{
			name: "confirmed OOM restarts",
			available: 2000000,
			kills: 1,
			attempts: 0,
			age: 0,
			status: "runtime-memory-recovering",
			launches: 1,
		},
		{
			name: "repeated OOM stops",
			available: 2000000,
			kills: 1,
			attempts: 3,
			age: 1000,
			status: "runtime-memory-recovery-failed",
			launches: 0,
		},
		{
			name: "persistent pressure stops",
			continuingPressure: true,
			available: 100,
			kills: 0,
			attempts: 0,
			age: 301000,
			status: "runtime-memory-recovery-failed",
			launches: 0,
		},
		{
			name: "new pressure does not inherit an earlier OOM or pressure deadline",
			available: 100,
			kills: 0,
			attempts: 1,
			age: 301000,
			status: "runtime-memory-pressure",
			launches: 0,
		},
		{
			name: "continuous pressure expires even after the OOM window rolls over",
			available: 100,
			kills: 0,
			attempts: 0,
			age: 601000,
			continuingPressure: true,
			status: "runtime-memory-recovery-failed",
			launches: 0,
		},
		{
			name: "ordinary disconnect stays ordinary",
			available: 2000000,
			kills: 0,
			attempts: 0,
			age: 0,
			status: "resume-runtime-restarting",
			launches: 1,
		},
	])("$name without replacing the sandbox or queued message", async (input) => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "memory-check",
					state: "resuming",
					desiredState: "ready",
					statusCode:
						"continuingPressure" in input
							? "runtime-memory-pressure"
							: "resume-queued",
					requestConfig: {
						runtimeGeneration: 1,
						memoryRecoveryAttempts: input.attempts,
						memoryRecoveryStartedAt: Date.now() - input.age,
						memoryPressureSince: Date.now() - input.age,
					},
				});
				const before = yield* store.getLaunchIntent(
					workspace.workspaceId,
					Date.now(),
				);
				const providers = yield* SandboxProviders;
				const replacement = {
					...providers,
					get: (id: string) =>
						providers.get(id).pipe(
							Effect.map((adapter) => ({
								...adapter,
								readTextFile: (_id: string, path: string) =>
									Effect.succeed(
										path === "/proc/meminfo"
											? `MemTotal: 4096000 kB\nMemAvailable: ${input.available} kB`
											: path === "/proc/vmstat"
												? `oom_kill ${input.kills}`
												: path === "/proc/sys/kernel/random/boot_id"
													? "boot"
													: path.endsWith("runtime-memory.json")
														? JSON.stringify({
																bootId: "boot",
																generation: "1",
																oomKills: 0,
															})
														: "",
									),
							})),
						),
				};
				yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
					Effect.provideService(SandboxProviders, replacement),
				);
				// A fast observer must respect the pressure backoff and not launch anything.
				if (input.status === "runtime-memory-pressure")
					yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
						Effect.provideService(SandboxProviders, replacement),
					);
				return {
					before,
					after: yield* store.getLaunchIntent(
						workspace.workspaceId,
						Date.now(),
					),
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					launches: yield* Ref.get(control.startProcessCalls),
					resumes: yield* Ref.get(control.resumeInputs),
				};
			}).pipe(Effect.provide(testLayer)),
		);
		expect(result.workspace?.statusCode).toBe(input.status);
		expect(result.launches).toHaveLength(input.launches);
		expect(result.resumes).toHaveLength(0);
		expect(result.workspace?.providerSandboxId).toBe("source-memory-check");
		expect(result.after).toEqual(result.before);
	});
});

test("automatically restarts the retained runtime once memory pressure clears", async () => {
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* CloudWorkspaceStore;
			const control = yield* FakeSandboxProviderControlService;
			const workspace = yield* seedWorkspace({
				workspaceId: "memory-clears",
				state: "resuming",
				desiredState: "ready",
				statusCode: "resume-queued",
				requestConfig: { runtimeGeneration: 1 },
			});
			const providers = yield* SandboxProviders;
			let available = 100;
			const replacement = {
				...providers,
				get: (id: string) =>
					providers.get(id).pipe(
						Effect.map((adapter) => ({
							...adapter,
							readTextFile: (_id: string, path: string) =>
								Effect.succeed(
									path === "/proc/meminfo"
										? `MemTotal: 4096000 kB\nMemAvailable: ${available} kB`
										: "",
								),
						})),
					),
			};
			const reconcile = reconcileCloudWorkspace(workspace.workspaceId).pipe(
				Effect.provideService(SandboxProviders, replacement),
			);
			yield* reconcile;
			const waiting = yield* store.getWorkspace(workspace.workspaceId);
			expect(waiting?.statusCode).toBe("runtime-memory-pressure");
			expect(yield* Ref.get(control.startProcessCalls)).toHaveLength(0);
			if (!waiting) throw new Error("workspace missing");
			// Simulate the next scheduled check, without sleeping or changing the queue.
			available = 2000000;
			yield* store.saveWorkspace({
				...waiting,
				revision: waiting.revision + 1,
				updatedAtMs: waiting.updatedAtMs + 1,
				nextActionAtMs: Date.now() - 1,
			});
			yield* reconcile;
			return {
				workspace: yield* store.getWorkspace(workspace.workspaceId),
				calls: yield* Ref.get(control.startProcessCalls),
			};
		}).pipe(Effect.provide(testLayer)),
	);
	expect(result.calls).toHaveLength(1);
	expect(result.workspace?.requestConfig.memoryPressureSince).toBeUndefined();
	expect(result.workspace).toMatchObject({
		providerSandboxId: "source-memory-clears",
		state: "provisioning",
		statusCode: "resume-runtime-restarting",
	});
});

test("pauses an idle ready workspace before recovering its offline runtime", async () => {
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* CloudWorkspaceStore;
			const control = yield* FakeSandboxProviderControlService;
			const workspace = yield* seedWorkspace({
				workspaceId: "workspace-idle-offline",
				state: "ready",
				desiredState: "ready",
				runtimeState: "offline",
				statusCode: "agent-running",
				requestConfig: {},
			});
			yield* store.saveWorkspace({
				...workspace,
				lastActivityAtMs: Date.now() - 60 * 60 * 1000,
				revision: workspace.revision + 1,
			});
			yield* reconcileCloudWorkspace(workspace.workspaceId);
			return {
				workspace: yield* store.getWorkspace(workspace.workspaceId),
				resumed: yield* Ref.get(control.resumeInputs),
				started: yield* Ref.get(control.startProcessCalls),
				sandbox: (yield* Ref.get(control.sandboxes)).get(
					workspace.providerSandboxId ?? "",
				),
			};
		}).pipe(Effect.provide(testLayer)),
	);
	expect(result.workspace).toMatchObject({
		state: "paused",
		desiredState: "paused",
	});
	expect(result.sandbox?.state).toBe("paused");
	expect(result.resumed).toHaveLength(0);
	expect(result.started).toHaveLength(0);
});

test("honors an explicit resume after an old session became idle", async () => {
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* CloudWorkspaceStore;
			const control = yield* FakeSandboxProviderControlService;
			const workspace = yield* seedWorkspace({
				workspaceId: "workspace-explicit-resume",
				state: "ready",
				desiredState: "ready",
				runtimeState: "offline",
				statusCode: "agent-running",
				requestConfig: {},
			});
			yield* store.saveWorkspace(
				cloudWorkspaceResumeTarget(
					{ ...workspace, lastActivityAtMs: Date.now() - 60 * 60 * 1000 },
					Date.now(),
				),
			);
			yield* reconcileCloudWorkspace(workspace.workspaceId);
			return {
				workspace: yield* store.getWorkspace(workspace.workspaceId),
				resumed: yield* Ref.get(control.resumeInputs),
			};
		}).pipe(Effect.provide(testLayer)),
	);
	expect(result.resumed).toHaveLength(1);
	expect(result.workspace).toMatchObject({
		state: "resuming",
		desiredState: "ready",
	});
});
