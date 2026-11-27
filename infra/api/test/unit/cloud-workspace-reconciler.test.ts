import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLOUD_COMMAND_PROTOCOL_VERSION,
	WIRE_PROTOCOL_VERSION,
} from "@zuse/contracts";
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
import { CloudAccountExecution } from "../../src/cloud-account-execution.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import {
	launchAssetFiles,
	launchAssetsDigest,
	WORKSPACE_BOOTSTRAP_FILE,
} from "../../src/cloud-workspace-launch-assets.ts";
import { cloudRepositoryWorkspacePath } from "../../src/cloud-workspace-paths.ts";
import {
	ARCHIVED_WORKSPACE_RETENTION_MS,
	cloudWorkspaceHasRetainedRuntimeData,
	MAILBOX_RUNTIME_STALL_TIMEOUT_MS,
	PROJECT_IMAGE_BUILD_SCRIPT,
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
	startCloudWorkspaceForAccountDirect,
	startCloudWorkspaceInline,
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

const authorityPrewarm = vi.hoisted(() => ({
	calls: [] as string[],
	outcome: null as null | "fail",
}));

vi.mock("../../src/cloud-auth-authority.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../src/cloud-auth-authority.ts")>();
	const { Effect } = await import("effect");
	return {
		...actual,
		prepareExistingCloudAuthAuthority: (accountId: string) => {
			authorityPrewarm.calls.push(accountId);
			return authorityPrewarm.outcome === "fail"
				? Effect.die(new Error("authority unavailable"))
				: Effect.succeed("ready" as const);
		},
	};
});

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

test("yields a pending Boat snapshot before the build lease expires", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const workspace = yield* seedWorkspace({
				workspaceId: "snapshot-pending",
				requestConfig: {},
				state: "ready",
				desiredState: "ready",
				statusCode: "ready",
			});
			const store = yield* CloudWorkspaceStore;
			const original = yield* store.getBuild(workspace.buildId);
			if (original === null) throw new Error("Missing build");
			const build = {
				...original,
				provider: "box",
				createdAtMs: Date.now() - 20 * 60_000,
				state: "sanitizing" as const,
				snapshotId: undefined,
				providerSandboxId: workspace.providerSandboxId,
				logText: "Repository preparation completed",
				nextActionAtMs: 0,
			};
			yield* store.saveBuild(build);
			const providers = yield* SandboxProviders;
			const provider = yield* providers.get(original.provider);
			const snapshot = vi.fn(() => Effect.never);
			yield* reconcileCloudBuild(build.buildId).pipe(
				Effect.provideService(SandboxProviders, {
					...providers,
					get: () =>
						Effect.succeed({ ...provider, providerId: "box", snapshot }),
				}),
			);
			const result = yield* store.getBuild(build.buildId);
			expect(result?.state).toBe("sanitizing");
			expect(result?.lastErrorCode).toBeUndefined();
			expect(result?.providerSandboxId).toBe(workspace.providerSandboxId);
			expect(result?.leaseExpiresAtMs).toBeUndefined();
			expect(result?.logText).toContain(
				"Snapshot publication is still in progress.",
			);
			expect(snapshot).toHaveBeenCalledOnce();
			expect(
				yield* provider.inspect(workspace.providerSandboxId ?? ""),
			).not.toBeNull();
		}).pipe(Effect.provide(testLayer)),
	);
}, 40_000);

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
			readonly validateTemplate?: () => Effect.Effect<
				void,
				SandboxProviderError
			>;
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
							validateTemplate: override.validateTemplate,
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

	test("fails immediately when the configured template is inaccessible", async () => {
		const { build } = await Effect.runPromise(
			reconcileQueued("queued-template-missing", {
				validateTemplate: () =>
					Effect.fail(new SandboxProviderError({ code: "not-found" })),
				recoverByLabel: () =>
					Effect.die("must not allocate after a failed template check"),
			}).pipe(Effect.provide(testLayer)),
		);
		expect(build?.state).toBe("failed");
		expect(build?.lastErrorCode).toBe("provider-template-unavailable");
		expect(build?.logText).toContain("accessible template");
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
			expect(resumed?.logText).toContain("Snapshot published successfully.");
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
		wrappedTranscriptKey: input.wrappedTranscriptKey,
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

	test("a preparing runtime with a valid credential follows the idle policy and rechecks expiry", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const now = Date.now();
				const workspace = yield* seedWorkspace({
					workspaceId: "preparing-online",
					state: "setup",
					desiredState: "ready",
					statusCode: "preparing-credentials",
					runtimeState: "online",
					lastActivityAtMs: now,
					requestConfig: {
						startupTimings: { enrolledAt: now - 60_000 },
						runtimeCredentialExpiresAtMs: now + 60_000,
					},
				});
				yield* store.saveWorkspace({
					...workspace,
					runtimeCredentialHash: "live-runtime",
					revision: workspace.revision + 1,
					updatedAtMs: workspace.updatedAtMs + 1,
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				const preparing = yield* store.getWorkspace(workspace.workspaceId);
				if (preparing === null) throw new Error("workspace missing");
				yield* store.saveWorkspace({
					...preparing,
					lastActivityAtMs: now - 365 * 24 * 60 * 60_000,
					nextActionAtMs: now,
					revision: preparing.revision + 1,
					updatedAtMs: preparing.updatedAtMs + 1,
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					preparing,
					idle: yield* store.getWorkspace(workspace.workspaceId),
				};
			}).pipe(Effect.provide(testLayer)),
		);
		expect(result.preparing).toMatchObject({
			state: "setup",
			runtimeState: "online",
			statusCode: "preparing-credentials",
			runtimeCredentialHash: "live-runtime",
		});
		expect(result.preparing?.nextActionAtMs).toBeGreaterThan(Date.now());
		expect(result.preparing?.nextActionAtMs).toBe(
			result.preparing?.requestConfig.runtimeCredentialExpiresAtMs,
		);
		expect(result.idle).toMatchObject({
			state: "paused",
			statusCode: "paused",
		});
	});

	test("expires stale online startup evidence without replacing retained data", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const now = Date.now();
				const workspace = yield* seedWorkspace({
					workspaceId: "preparing-expired",
					state: "setup",
					desiredState: "ready",
					statusCode: "preparing-credentials",
					runtimeState: "online",
					lastActivityAtMs: now,
					requestConfig: {
						startupTimings: { enrolledAt: now - 60_000 },
						runtimeCredentialExpiresAtMs: now - 1,
						sessionHeadVersion: 1,
					},
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					before: workspace,
					after: yield* store.getWorkspace(workspace.workspaceId),
				};
			}).pipe(Effect.provide(testLayer)),
		);
		expect(result.after).toMatchObject({
			state: "failed",
			runtimeState: "offline",
			statusCode: "runtime-connection-timeout",
			providerSandboxId: result.before.providerSandboxId,
			chatId: result.before.chatId,
			initialSessionId: result.before.initialSessionId,
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
							ZUSE_RUNTIME_WIRE_PROTOCOL: String(WIRE_PROTOCOL_VERSION),
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
				expect(args).toMatch(
					/ensure_workspace_runtime\n(?:workspace_runtime_timing[^\n]*\n)*exec \/bin\/bash/u,
				);
				const saved = yield* (yield* CloudWorkspaceStore).getWorkspace(
					workspace.workspaceId,
				);
				expect(saved?.requestConfig.runtimeInstallPending).toBe(false);
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test.each([
		false,
		true,
		undefined,
	])("only a durably unattempted allocation skips recovery: %s", async (attempted) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-first-allocation",
					state: "queued",
					desiredState: "ready",
					statusCode: "start-queued",
					requestConfig:
						attempted === undefined ? {} : { allocationAttempted: attempted },
				});
				yield* Ref.set(control.sandboxes, new Map());
				yield* store.saveWorkspace({
					...workspace,
					providerSandboxId: undefined,
					revision: workspace.revision + 1,
				});
				const provider = yield* (yield* SandboxProviders).get("fake");
				const recover = vi.spyOn(provider, "recoverByLabel");
				const original = provider.fork;
				const fork = vi.spyOn(provider, "fork").mockImplementation((input) =>
					Effect.gen(function* () {
						if (attempted === false)
							expect(
								(yield* store.getWorkspace(workspace.workspaceId))
									?.requestConfig.allocationAttempted,
							).toBe(true);
						return yield* original(input);
					}),
				);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				expect(recover).toHaveBeenCalledTimes(attempted === false ? 0 : 1);
				expect(fork).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test("stops allocation when the provider machine quota requires account action", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-quota",
					state: "queued",
					desiredState: "ready",
					statusCode: "provisioning-queued",
					requestConfig: { allocationAttempted: false },
				});
				yield* store.saveWorkspace({
					...workspace,
					providerSandboxId: undefined,
					revision: workspace.revision + 1,
				});
				const provider = yield* (yield* SandboxProviders).get("fake");
				const fork = vi
					.spyOn(provider, "fork")
					.mockReturnValue(
						Effect.fail(new SandboxProviderError({ code: "quota-exceeded" })),
					);
				try {
					yield* reconcileCloudWorkspace(workspace.workspaceId);
					expect(fork).toHaveBeenCalledTimes(1);
					return yield* store.getWorkspace(workspace.workspaceId);
				} finally {
					fork.mockRestore();
				}
			}).pipe(Effect.provide(testLayer)),
		);
		expect(result).toMatchObject({
			state: "failed",
			statusCode: "provider-quota-exceeded",
			runtimeState: "offline",
			nextActionAtMs: Number.MAX_SAFE_INTEGER,
		});
		expect(result?.providerSandboxId).toBeUndefined();
	});

	test("a lost first allocation response recovers the created machine without a second fork", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-lost-allocation",
					state: "queued",
					desiredState: "ready",
					statusCode: "start-queued",
					requestConfig: { allocationAttempted: false },
				});
				yield* Ref.set(control.sandboxes, new Map());
				yield* store.saveWorkspace({
					...workspace,
					providerSandboxId: undefined,
					revision: workspace.revision + 1,
				});
				const provider = yield* (yield* SandboxProviders).get("fake");
				const recover = vi.spyOn(provider, "recoverByLabel");
				const original = provider.fork;
				const fork = vi
					.spyOn(provider, "fork")
					.mockImplementationOnce((input) =>
						original(input).pipe(
							Effect.andThen(
								Effect.fail(new SandboxProviderError({ code: "transient" })),
							),
						),
					);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				const failed = yield* store.getWorkspace(workspace.workspaceId);
				expect(failed?.requestConfig.allocationAttempted).toBe(true);
				expect(failed?.providerSandboxId).toBeUndefined();
				if (failed === null) throw new Error("workspace missing");
				yield* store.saveWorkspace({
					...failed,
					nextActionAtMs: 0,
					revision: failed.revision + 1,
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				expect(recover).toHaveBeenCalledTimes(1);
				expect(fork).toHaveBeenCalledTimes(1);
				expect(
					(yield* store.getWorkspace(workspace.workspaceId))?.providerSandboxId,
				).toBe("fake-workspace-lost-allocation");
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test("a rejected allocation marker commit performs no provider mutation", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-allocation-cas",
					state: "queued",
					desiredState: "ready",
					statusCode: "start-queued",
					requestConfig: { allocationAttempted: false },
				});
				yield* Ref.set(control.sandboxes, new Map());
				yield* store.saveWorkspace({
					...workspace,
					providerSandboxId: undefined,
					revision: workspace.revision + 1,
				});
				const provider = yield* (yield* SandboxProviders).get("fake");
				const fork = vi.spyOn(provider, "fork");
				const recover = vi.spyOn(provider, "recoverByLabel");
				vi.spyOn(store, "saveClaimedWorkspace").mockImplementation(() =>
					Effect.succeed(false),
				);
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				expect(fork).not.toHaveBeenCalled();
				expect(recover).not.toHaveBeenCalled();
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

	test.each([
		"resume-queued",
		"resume-runtime-recovery-queued",
	])("allocates only the requested replacement sandbox (%s)", async (statusCode) => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const workspace = yield* seedWorkspace({
					workspaceId: "workspace-incomplete-retry",
					state: "queued",
					desiredState: "ready",
					statusCode,
					requestConfig: {
						runtimeGeneration: 1,
						startupTimings: { requestedAt: Date.now() },
					},
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

	test("archives by pausing the same sandbox for 10 days", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const control = yield* FakeSandboxProviderControlService;
				const deleteAt = Date.now() - 2_000 + ARCHIVED_WORKSPACE_RETENTION_MS;
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

	test("keeps expired archives and their history when no verified recovery point exists", async () => {
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
					wrappedTranscriptKey: "preserved-key",
				});
				yield* reconcileCloudWorkspace(workspace.workspaceId);
				return {
					workspace: yield* store.getWorkspace(workspace.workspaceId),
					sandboxes: yield* Ref.get(control.sandboxes),
				};
			}).pipe(Effect.provide(testLayer)),
		);
		expect(ARCHIVED_WORKSPACE_RETENTION_MS).toBe(10 * 24 * 60 * 60 * 1_000);
		expect(result.workspace).toMatchObject({
			state: "archived",
			desiredState: "archived",
			statusCode: "archive-backup-required",
			providerSandboxId: "source-expired-archive",
			wrappedTranscriptKey: "preserved-key",
		});
		expect(result.sandboxes.has("source-expired-archive")).toBe(true);
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

test("retries an enrolled workspace on its existing machine without its old image", async () => {
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* CloudWorkspaceStore;
			const control = yield* FakeSandboxProviderControlService;
			const workspace = yield* seedWorkspace({
				workspaceId: "retry-existing",
				state: "queued",
				desiredState: "ready",
				statusCode: "provider-connection-unavailable",
				requestConfig: { runtimeGeneration: 1 },
			});
			const providers = yield* SandboxProviders;
			const replacement = {
				...providers,
				get: (id: string) =>
					providers.get(id).pipe(
						Effect.map((adapter) => ({
							...adapter,
							kill: () => Effect.die("must not delete the existing machine"),
							fork: () => Effect.die("must not consume the deleted image"),
							create: () => Effect.die("must not allocate a replacement"),
						})),
					),
			};
			const build = yield* store.getBuild(workspace.buildId);
			if (build)
				yield* store.saveBuild({
					...build,
					snapshotId: undefined,
					state: "failed",
				});
			yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
				Effect.provideService(SandboxProviders, replacement),
			);
			return {
				workspace: yield* store.getWorkspace(workspace.workspaceId),
				calls: yield* Ref.get(control.startProcessCalls),
			};
		}).pipe(Effect.provide(testLayer)),
	);
	expect(result.workspace).toMatchObject({
		providerSandboxId: "source-retry-existing",
		state: "provisioning",
		statusCode: "resume-runtime-restarting",
	});
	expect(result.calls).toHaveLength(1);
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

test.each([
	null,
	"23",
])("a cloned image's stale ready marker cannot complete a new build (receipt %s)", async (completion) => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const workspace = yield* seedWorkspace({
				workspaceId: "stale-image-ready",
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
				state: "building",
				snapshotId: undefined,
				providerSandboxId: workspace.providerSandboxId,
				createdAtMs: Date.now(),
				nextActionAtMs: 0,
			});
			const providers = yield* SandboxProviders;
			const provider = yield* providers.get(build.provider);
			let snapshots = 0;
			yield* reconcileCloudBuild(build.buildId).pipe(
				Effect.provideService(SandboxProviders, {
					...providers,
					get: () =>
						Effect.succeed({
							...provider,
							pathExists: () => Effect.succeed(true),
							readTextFile: (_id, path) =>
								path.includes("/completed-")
									? completion === null
										? Effect.fail(
												new SandboxProviderError({ code: "not-found" }),
											)
										: Effect.succeed(completion)
									: Effect.succeed(
											path.endsWith("failure-phase")
												? "updating-runtime"
												: "old build output",
										),
							snapshot: () =>
								Effect.sync(() => {
									snapshots += 1;
									return "must-not-publish";
								}),
						}),
				}),
			);
			const result = yield* store.getBuild(build.buildId);
			expect(result?.state).toBe(completion === null ? "building" : "failed");
			if (completion !== null)
				expect(result?.lastErrorCode).toBe("project-updating-runtime-failed");
			expect(snapshots).toBe(0);
		}).pipe(Effect.provide(testLayer)),
	);
});

test.each([
	{
		metadata: JSON.stringify({
			schemaVersion: 1,
			appVersion: "0.24.0-preview.9",
			runtimeVersion: "runtime-9",
			wireProtocolVersion: 7,
		}),
		runtime: { appVersion: "0.24.0-preview.9", wireProtocolVersion: 7 },
	},
	{ metadata: null, runtime: undefined },
])("a published image records the runtime release it installed ($runtime)", async ({
	metadata,
	runtime,
}) => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const workspace = yield* seedWorkspace({
				workspaceId: `image-runtime-${runtime === undefined ? "unknown" : "known"}`,
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
				state: "building",
				snapshotId: undefined,
				providerSandboxId: workspace.providerSandboxId,
				createdAtMs: Date.now(),
				nextActionAtMs: 0,
			});
			const files: Record<string, string> = {
				[`/var/lib/zuse/project-build/completed-${build.buildId}`]: "0",
				"/var/lib/zuse/project-build/source-commit": "a".repeat(40),
				"/var/lib/zuse/project-build/template-version": build.templateVersion,
				"/var/lib/zuse/project-build/configuration-digest":
					build.configurationDigest,
				...(metadata === null
					? {}
					: { "/opt/zuse/current/runtime-metadata.json": metadata }),
			};
			const providers = yield* SandboxProviders;
			const provider = yield* providers.get(build.provider);
			yield* reconcileCloudBuild(build.buildId).pipe(
				Effect.provideService(SandboxProviders, {
					...providers,
					get: () =>
						Effect.succeed({
							...provider,
							pathExists: (_id, path) =>
								Effect.succeed(path === "/var/lib/zuse/project-build/ready"),
							readTextFile: (_id, path) =>
								path in files
									? Effect.succeed(files[path] as string)
									: path.endsWith(".log")
										? Effect.succeed("")
										: Effect.fail(
												new SandboxProviderError({ code: "not-found" }),
											),
						}),
				}),
			);
			const promoted = yield* store.getBuild(build.buildId);
			expect(promoted?.lastErrorCode).toBeUndefined();
			expect(promoted?.state).toBe("ready");
			expect(promoted?.settings?.runtime).toEqual(runtime);
		}).pipe(Effect.provide(testLayer)),
	);
});

test.each([
	"none",
	"runtime",
	"toolchain",
	"memory",
])("image build receipts follow the current installer result (failure %s)", (fails) => {
	const root = mkdtempSync(join(tmpdir(), "zuse-image-receipt-"));
	try {
		const status = join(root, "var/lib/zuse/project-build");
		mkdirSync(status, { recursive: true });
		mkdirSync(join(root, "tmp"));
		mkdirSync(join(root, "opt/zuse/current"), { recursive: true });
		writeFileSync(join(status, "ready"), "inherited");
		writeFileSync(join(status, "completed-old-build"), "0\n");
		writeFileSync(join(root, "tmp/zuse-project-builder-exited"), "inherited");
		writeFileSync(
			join(status, "runtime-updater.mjs"),
			`import fs from 'node:fs';
if (fs.existsSync(${JSON.stringify(join(status, "ready"))})) throw new Error('Stale readiness was not cleared');
if (fs.existsSync(${JSON.stringify(join(status, "completed-new-build"))})) throw new Error('Completion written before install');
if (process.env.ZUSE_RUNTIME_WIRE_PROTOCOL !== '7') throw new Error('Wrong requested protocol');
if (${JSON.stringify(fails)} === "runtime") process.exit(23);
fs.writeFileSync(${JSON.stringify(join(root, "opt/zuse/current/runtime-metadata.json"))}, JSON.stringify({wireProtocolVersion:7}));`,
		);
		writeFileSync(
			join(root, "opt/zuse/current/toolchain-reconciler.mjs"),
			`import fs from 'node:fs';
if (process.env.ZUSE_TOOLCHAIN_SKIP_SYSTEM_PACKAGES !== '1') throw new Error('Must not reinstall system packages');
if (${JSON.stringify(fails)} === 'toolchain') process.exit(24);
if (process.env.ZUSE_TOOLCHAIN_BIN_DIR !== '/home/zuse/.local/bin') throw new Error('Must install user-owned tools');
fs.writeFileSync(${JSON.stringify(join(status, "tools-ready"))}, 'ready');`,
		);
		writeFileSync(
			join(status, "builder.sh"),
			`#!/bin/sh
test -f '${join(status, "tools-ready")}' || exit 25
touch '${join(status, "ready")}'
`,
			{ mode: 0o700 },
		);
		writeFileSync(
			join(root, "opt/zuse/current/bin.mjs"),
			"// import-safe runtime fixture\n",
		);
		const script = PROJECT_IMAGE_BUILD_SCRIPT.replaceAll(
			"/tmp/zuse-",
			join(root, "tmp/zuse-"),
		)
			.replaceAll("/var/lib/zuse", join(root, "var/lib/zuse"))
			.replaceAll("/opt/zuse", join(root, "opt/zuse"));
		const result = spawnSync(
			"bash",
			[
				"-c",
				`sleep() { :; }
sudo() { if [ ${JSON.stringify(fails)} != memory ]; then return 99; fi; while [[ "$1" == -* ]]; do if [ "$1" = -u ]; then shift; fi; shift; done; "$@"; }
python3() { return 26; }
${script}`,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					ZUSE_PROJECT_BUILD_ID: "new-build",
					ZUSE_PROJECT_IMAGE_PROVIDER: fails === "memory" ? "e2b" : "boxd",
					ZUSE_RUNTIME_MANIFEST_URL: "https://runtime.invalid/pinned.json",
					ZUSE_RUNTIME_WIRE_PROTOCOL: "7",
				},
			},
		);
		expect(result.status, result.stderr).toBe(
			fails === "runtime"
				? 23
				: fails === "toolchain"
					? 24
					: fails === "memory"
						? 26
						: 0,
		);
		expect(readFileSync(join(status, "completed-new-build"), "utf8")).toBe(
			fails === "runtime"
				? "23\n"
				: fails === "toolchain"
					? "24\n"
					: fails === "memory"
						? "26\n"
						: "0\n",
		);

		expect(existsSync(join(status, "ready"))).toBe(
			fails === "none" || fails === "memory",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a configured runtime channel without its installer fails before allocating an image build", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const workspace = yield* seedWorkspace({
				workspaceId: "missing-image-installer",
				requestConfig: {},
				state: "ready",
				desiredState: "ready",
				statusCode: "ready",
			});
			const store = yield* CloudWorkspaceStore;
			const original = yield* store.getBuild(workspace.buildId);
			if (original === null) throw new Error("Missing build");
			yield* store.saveBuild({
				...original,
				state: "queued",
				snapshotId: undefined,
				providerSandboxId: undefined,
				nextActionAtMs: 0,
			});
			const control = yield* FakeSandboxProviderControlService;
			const before = yield* Ref.get(control.createCalls);
			yield* reconcileCloudBuild(original.buildId).pipe(
				Effect.provideService(SandboxOfferConfiguration, {
					port: 47837,
					createTimeoutSeconds: 3600,
					keepAliveTimeoutSeconds: 600,
					runtimeManifestUrl: "https://runtime.invalid/pinned.json",
				}),
			);
			expect((yield* store.getBuild(original.buildId))?.lastErrorCode).toBe(
				"runtime-installer-unavailable",
			);
			expect(yield* Ref.get(control.createCalls)).toBe(before);
		}).pipe(Effect.provide(testLayer)),
	);
});

test("image runtime installation owns a transaction per build", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const workspace = yield* seedWorkspace({
				workspaceId: "image-transaction",
				requestConfig: {},
				state: "ready",
				desiredState: "ready",
				statusCode: "ready",
			});
			const store = yield* CloudWorkspaceStore;
			const original = yield* store.getBuild(workspace.buildId);
			if (original === null) throw new Error("Missing build");
			yield* store.saveBuild({
				...original,
				state: "queued",
				snapshotId: undefined,
				providerSandboxId: undefined,
				nextActionAtMs: 0,
			});
			const provider = yield* (yield* SandboxProviders).get(original.provider);
			const start = vi.spyOn(provider, "startProcess");
			yield* reconcileCloudBuild(original.buildId).pipe(
				Effect.provideService(SandboxOfferConfiguration, {
					port: 47837,
					createTimeoutSeconds: 3600,
					keepAliveTimeoutSeconds: 600,
					runtimeManifestUrl: "https://runtime.invalid/pinned.json",
					runtimeInstallerSource: "// signed updater",
					runtimeSigningPublicJwk: "public-key",
				}),
			);
			expect(start).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					env: expect.objectContaining({
						ZUSE_PROJECT_BUILD_ID: original.buildId,
						ZUSE_RUNTIME_UPDATE_TRANSACTION_ID: original.buildId,
						ZUSE_RUNTIME_WIRE_PROTOCOL: String(WIRE_PROTOCOL_VERSION),
					}),
				}),
			);
		}).pipe(Effect.provide(testLayer)),
	);
});

describe("managed image launch assets", () => {
	const offer = {
		port: 47837,
		createTimeoutSeconds: 3600,
		keepAliveTimeoutSeconds: 600,
		runtimeManifestUrl: "https://runtime.test/manifest.json",
		runtimeSigningPublicJwk: "public-key",
	};
	const launch = (
		workspaceId: string,
		input: {
			readonly digest: string | undefined;
			readonly recovered: boolean;
		},
	) =>
		Effect.gen(function* () {
			const workspace = yield* seedWorkspace({
				workspaceId,
				state: "queued",
				desiredState: "ready",
				statusCode: "start-queued",
				requestConfig: {},
			});
			const store = yield* CloudWorkspaceStore;
			const build = yield* store.getBuild(workspace.buildId);
			if (build === null) throw new Error("Missing fixture build");
			yield* store.saveBuild({
				...build,
				settings: { launchAssetsDigest: input.digest },
				revision: build.revision + 1,
			});
			const control = yield* FakeSandboxProviderControlService;
			if (!input.recovered) yield* Ref.set(control.sandboxes, new Map());
			const provider = yield* (yield* SandboxProviders).get("fake");
			const write = vi.spyOn(provider, "writeTextFile");
			const network = vi.spyOn(provider, "setNetwork");
			const start = vi.spyOn(provider, "replaceProcess");
			try {
				yield* reconcileCloudWorkspace(workspace.workspaceId).pipe(
					Effect.provideService(SandboxOfferConfiguration, offer),
				);
				return {
					bootstrapWritten: write.mock.calls.some(
						([, path]) => path === WORKSPACE_BOOTSTRAP_FILE,
					),
					networkOpened: network.mock.calls.length > 0,
					started: start.mock.calls.length,
					workspace: yield* store.getWorkspace(workspaceId),
				};
			} finally {
				write.mockRestore();
				network.mockRestore();
				start.mockRestore();
			}
		}).pipe(Effect.provide(testLayer));

	test("a fresh restore of an image with the current digest launches without rewriting scripts", async () => {
		const digest = await Effect.runPromise(
			launchAssetsDigest(launchAssetFiles(offer)),
		);
		const result = await Effect.runPromise(
			launch("assets-match", { digest, recovered: false }),
		);
		expect(result.bootstrapWritten).toBe(false);
		expect(result.networkOpened).toBe(false);
		expect(result.started).toBe(1);
		expect(result.workspace?.state).toBe("provisioning");
	});

	test("a missing or stale image digest writes the current scripts", async () => {
		for (const digest of [undefined, "stale-digest"]) {
			const result = await Effect.runPromise(
				launch(`assets-${digest ?? "missing"}`, { digest, recovered: false }),
			);
			expect(result.bootstrapWritten).toBe(true);
			expect(result.networkOpened).toBe(true);
			expect(result.started).toBe(1);
		}
	});

	test("a recovered sandbox repairs its scripts even when the image digest matches", async () => {
		const digest = await Effect.runPromise(
			launchAssetsDigest(launchAssetFiles(offer)),
		);
		const result = await Effect.runPromise(
			launch("assets-recovered", { digest, recovered: true }),
		);
		expect(result.bootstrapWritten).toBe(true);
		expect(result.networkOpened).toBe(true);
		expect(result.started).toBe(1);
	});

	test("the digest covers the signing key", async () => {
		const withKey = await Effect.runPromise(
			launchAssetsDigest(launchAssetFiles(offer)),
		);
		const otherKey = await Effect.runPromise(
			launchAssetsDigest(
				launchAssetFiles({ ...offer, runtimeSigningPublicJwk: "other-key" }),
			),
		);
		const withoutKey = await Effect.runPromise(
			launchAssetsDigest(
				launchAssetFiles({ ...offer, runtimeSigningPublicJwk: undefined }),
			),
		);
		expect(new Set([withKey, otherKey, withoutKey]).size).toBe(3);
	});
});

describe("inline first startup step", () => {
	const withIdempotentAllocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.gen(function* () {
			const providers = yield* SandboxProviders;
			return yield* effect.pipe(
				Effect.provideService(SandboxProviders, {
					...providers,
					get: (id) =>
						providers.get(id).pipe(
							Effect.map((adapter) => ({
								...adapter,
								supportsIdempotentAllocation: true,
							})),
						),
				}),
			);
		});

	test.each([
		"success",
		"unavailable",
		"lost-response",
	] as const)("account execution preserves one allocation on %s", async (mode) => {
		let delegated = 0;
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const workspace = yield* seedWorkspace({
					workspaceId: `account-execution-${mode}`,
					state: "queued",
					desiredState: "ready",
					statusCode: "provisioning-queued",
					requestConfig: { allocationProtocol: "provider-idempotent-v1" },
				});
				const control = yield* FakeSandboxProviderControlService;
				yield* Ref.set(control.sandboxes, new Map());
				yield* Ref.set(control.createCalls, 0);
				const store = yield* CloudWorkspaceStore;
				yield* store.saveWorkspace({
					...workspace,
					providerSandboxId: undefined,
					revision: workspace.revision + 1,
				});
				const wrongOwner = yield* startCloudWorkspaceForAccountDirect(
					"another-account",
					workspace.workspaceId,
				);
				expect(wrongOwner).toBe(false);
				expect(yield* Ref.get(control.createCalls)).toBe(0);
				const services =
					yield* Effect.context<
						Effect.Services<
							ReturnType<typeof startCloudWorkspaceForAccountDirect>
						>
					>();
				const ran = yield* withIdempotentAllocation(
					startCloudWorkspaceInline(workspace.workspaceId).pipe(
						Effect.provideService(CloudAccountExecution, {
							grant: () => Effect.succeed(null),
							prepare: () => Effect.succeed(null),
							startWorkspace: (accountId, workspaceId) =>
								Effect.gen(function* () {
									delegated++;
									if (mode === "unavailable") return null;
									const accepted = yield* withIdempotentAllocation(
										startCloudWorkspaceForAccountDirect(accountId, workspaceId),
									);
									return mode === "lost-response" ? null : accepted;
								}).pipe(Effect.provide(services)),
						}),
					),
				);
				return { ran, creates: yield* Ref.get(control.createCalls) };
			}).pipe(Effect.provide(testLayer)),
		);
		expect(result).toEqual({ ran: true, creates: 1 });
		expect(delegated).toBe(1);
	});

	test("a fresh managed creation runs allocation and launch from the request under the lease", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const workspace = yield* seedWorkspace({
					workspaceId: "inline-fresh",
					state: "queued",
					desiredState: "ready",
					statusCode: "provisioning-queued",
					requestConfig: { allocationProtocol: "provider-idempotent-v1" },
				});
				const control = yield* FakeSandboxProviderControlService;
				yield* Ref.set(control.sandboxes, new Map());
				const store = yield* CloudWorkspaceStore;
				yield* store.saveWorkspace({
					...workspace,
					providerSandboxId: undefined,
					revision: workspace.revision + 1,
					updatedAtMs: workspace.updatedAtMs + 1,
				});
				const ran = yield* withIdempotentAllocation(
					startCloudWorkspaceInline(workspace.workspaceId),
				);
				const after = yield* store.getWorkspace(workspace.workspaceId);

				const claimed = yield* store.claimWorkspace(
					workspace.workspaceId,
					"alarm",
					Date.now(),
					Date.now() + 1_000,
				);
				return { ran, after, claimed };
			}).pipe(Effect.provide(testLayer)),
		);
		expect(result.ran).toBe(true);
		expect(result.after).toMatchObject({
			state: "provisioning",
			statusCode: "runtime-starting",
		});
		expect(result.after?.providerSandboxId).toBeDefined();
		expect(result.claimed).not.toBeNull();
	});

	test.each([
		{
			name: "recovered sandbox",
			requestConfig: { allocationProtocol: "provider-idempotent-v1" },
			providerSandboxId: "existing",
			state: "queued" as const,
		},
		{
			name: "machine fork",
			requestConfig: {
				allocationProtocol: "provider-idempotent-v1",
				machineFork: {
					workspaceId: "source",
					chatId: "c",
					sessionId: "s",
					messageId: "m",
				},
			},
			providerSandboxId: undefined,
			state: "queued" as const,
		},
		{
			name: "legacy allocation protocol",
			requestConfig: {},
			providerSandboxId: undefined,
			state: "queued" as const,
		},
		{
			name: "resume of a paused workspace",
			requestConfig: { allocationProtocol: "provider-idempotent-v1" },
			providerSandboxId: "existing",
			state: "paused" as const,
		},
	])("does not run for a $name", async ({
		requestConfig,
		providerSandboxId,
		state,
	}) => {
		const ran = await Effect.runPromise(
			Effect.gen(function* () {
				const workspace = yield* seedWorkspace({
					workspaceId: `inline-skip-${state}-${Object.keys(requestConfig).length}-${providerSandboxId ?? "none"}`,
					state,
					desiredState: "ready",
					statusCode: "provisioning-queued",
					requestConfig,
					providerSandboxId,
				});
				const store = yield* CloudWorkspaceStore;
				if (providerSandboxId === undefined)
					yield* store.saveWorkspace({
						...workspace,
						providerSandboxId: undefined,
						revision: workspace.revision + 1,
						updatedAtMs: workspace.updatedAtMs + 1,
					});
				return yield* withIdempotentAllocation(
					startCloudWorkspaceInline(workspace.workspaceId),
				);
			}).pipe(Effect.provide(testLayer)),
		);
		expect(ran).toBe(false);
	});

	test("re-checks eligibility on the claimed row so a transition cannot run other work under the short lease", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const workspace = yield* seedWorkspace({
					workspaceId: "inline-race",
					state: "queued",
					desiredState: "ready",
					statusCode: "provisioning-queued",
					requestConfig: { allocationProtocol: "provider-idempotent-v1" },
				});
				const store = yield* CloudWorkspaceStore;
				yield* store.saveWorkspace({
					...workspace,
					providerSandboxId: undefined,
					revision: workspace.revision + 1,
					updatedAtMs: workspace.updatedAtMs + 1,
				});
				const provider = yield* (yield* SandboxProviders).get("fake");
				const create = vi.spyOn(provider, "create");

				const racing: typeof store = {
					...store,
					claimWorkspace: (id, owner, nowMs, leaseExpiresAtMs) =>
						store.getWorkspace(id).pipe(
							Effect.flatMap((current) =>
								current === null
									? Effect.void
									: store.saveWorkspace({
											...current,
											desiredState: "deleted",
											statusCode: "delete-queued",
											revision: current.revision + 1,
											updatedAtMs: current.updatedAtMs + 1,
										}),
							),
							Effect.andThen(
								store.claimWorkspace(id, owner, nowMs, leaseExpiresAtMs),
							),
						),
				};
				try {
					const ran = yield* withIdempotentAllocation(
						startCloudWorkspaceInline(workspace.workspaceId),
					).pipe(Effect.provideService(CloudWorkspaceStore, racing));
					const after = yield* store.getWorkspace(workspace.workspaceId);
					const released = yield* store.claimWorkspace(
						workspace.workspaceId,
						"alarm",
						Date.now(),
						Date.now() + 1_000,
					);
					return { ran, after, released, creates: create.mock.calls.length };
				} finally {
					create.mockRestore();
				}
			}).pipe(Effect.provide(testLayer)),
		);
		expect(result.ran).toBe(true);
		expect(result.creates).toBe(0);
		expect(result.after).toMatchObject({
			state: "queued",
			desiredState: "deleted",
			statusCode: "delete-queued",
		});
		expect(result.released).not.toBeNull();
	});

	test("skips providers without idempotent allocation and leases held by the scheduler", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const workspace = yield* seedWorkspace({
					workspaceId: "inline-no-capability",
					state: "queued",
					desiredState: "ready",
					statusCode: "provisioning-queued",
					requestConfig: { allocationProtocol: "provider-idempotent-v1" },
				});
				const store = yield* CloudWorkspaceStore;
				yield* store.saveWorkspace({
					...workspace,
					providerSandboxId: undefined,
					revision: workspace.revision + 1,
					updatedAtMs: workspace.updatedAtMs + 1,
				});
				const withoutCapability = yield* startCloudWorkspaceInline(
					workspace.workspaceId,
				);
				const held = yield* store.claimWorkspace(
					workspace.workspaceId,
					"alarm",
					Date.now(),
					Date.now() + 60_000,
				);
				const collided = yield* withIdempotentAllocation(
					startCloudWorkspaceInline(workspace.workspaceId),
				);
				const after = yield* store.getWorkspace(workspace.workspaceId);
				return { withoutCapability, held, collided, after };
			}).pipe(Effect.provide(testLayer)),
		);
		expect(result.withoutCapability).toBe(false);
		expect(result.held).not.toBeNull();

		expect(result.collided).toBe(true);
		expect(result.after?.state).toBe("queued");
		expect(result.after?.providerSandboxId).toBeUndefined();
	});
});

describe("inline authority prewarm", () => {
	const withIdempotentAllocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.gen(function* () {
			const providers = yield* SandboxProviders;
			return yield* effect.pipe(
				Effect.provideService(SandboxProviders, {
					...providers,
					get: (id) =>
						providers.get(id).pipe(
							Effect.map((adapter) => ({
								...adapter,
								supportsIdempotentAllocation: true,
							})),
						),
				}),
			);
		});
	const fresh = (
		workspaceId: string,
		requestConfig: Readonly<Record<string, unknown>>,
	) =>
		Effect.gen(function* () {
			const workspace = yield* seedWorkspace({
				workspaceId,
				state: "queued",
				desiredState: "ready",
				statusCode: "provisioning-queued",
				requestConfig,
			});
			const store = yield* CloudWorkspaceStore;
			yield* store.saveWorkspace({
				...workspace,
				providerSandboxId: undefined,
				revision: workspace.revision + 1,
				updatedAtMs: workspace.updatedAtMs + 1,
			});
			return workspace;
		});

	test("prepares the account authority for a fresh broker launch even when allocation is not inline", async () => {
		authorityPrewarm.calls.length = 0;
		authorityPrewarm.outcome = null;
		const ran = await Effect.runPromise(
			Effect.gen(function* () {
				const workspace = yield* fresh("prewarm-no-inline", {
					providerAuthMode: "broker-v1",
				});
				return yield* startCloudWorkspaceInline(workspace.workspaceId);
			}).pipe(Effect.provide(testLayer)),
		);
		expect(ran).toBe(false);
		expect(authorityPrewarm.calls).toEqual(["account-prewarm-no-inline"]);
	});

	test("runs alongside inline allocation and never changes its outcome, even when it fails", async () => {
		authorityPrewarm.calls.length = 0;
		authorityPrewarm.outcome = "fail";
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const workspace = yield* fresh("prewarm-with-inline", {
					allocationProtocol: "provider-idempotent-v1",
					codexAuthMode: "broker-v1",
				});
				const control = yield* FakeSandboxProviderControlService;
				yield* Ref.set(control.sandboxes, new Map());
				const ran = yield* withIdempotentAllocation(
					startCloudWorkspaceInline(workspace.workspaceId),
				);
				const after = yield* (yield* CloudWorkspaceStore).getWorkspace(
					workspace.workspaceId,
				);
				return { ran, after };
			}).pipe(Effect.provide(testLayer)),
		);
		expect(result.ran).toBe(true);
		expect(result.after?.state).toBe("provisioning");
		expect(authorityPrewarm.calls).toEqual(["account-prewarm-with-inline"]);
	});

	test("never touches the authority for native, custom image, fork, or non-fresh launches", async () => {
		authorityPrewarm.calls.length = 0;
		authorityPrewarm.outcome = null;
		await Effect.runPromise(
			Effect.gen(function* () {
				const native = yield* fresh("prewarm-native", {
					providerAuthMode: "snapshot-native",
					codexAuthMode: "snapshot-native",
				});
				yield* startCloudWorkspaceInline(native.workspaceId);
				const legacy = yield* fresh("prewarm-legacy", {});
				yield* startCloudWorkspaceInline(legacy.workspaceId);
				const fork = yield* fresh("prewarm-fork", {
					providerAuthMode: "broker-v1",
					machineFork: {
						workspaceId: "source",
						chatId: "c",
						sessionId: "s",
						messageId: "m",
					},
				});
				yield* startCloudWorkspaceInline(fork.workspaceId);
				const paused = yield* seedWorkspace({
					workspaceId: "prewarm-paused",
					state: "paused",
					desiredState: "ready",
					statusCode: "paused",
					requestConfig: { providerAuthMode: "broker-v1" },
				});
				yield* startCloudWorkspaceInline(paused.workspaceId);
			}).pipe(Effect.provide(testLayer)),
		);
		expect(authorityPrewarm.calls).toEqual([]);
	});
});
