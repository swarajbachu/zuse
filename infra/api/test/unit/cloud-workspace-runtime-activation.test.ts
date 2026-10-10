import type { DurableObjectState } from "@cloudflare/workers-types";
import {
	type SandboxProcessInput,
	type SandboxProviderAdapter,
	SandboxProviderError,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import {
	FakeSandboxProviderControlService,
	SandboxProvidersFake,
} from "@zuse/sandbox-providers/testing";
import { Effect, Layer, ManagedRuntime, Redacted, Ref } from "effect";
import { describe, expect, test } from "vitest";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import {
	reconcileCloudWorkspace,
	reconcileCloudWorkspaceStartup,
} from "../../src/cloud-workspace-reconciler.ts";
import {
	openRuntimeActivationBoot,
	RUNTIME_ACTIVATION_JOURNAL,
	RUNTIME_ACTIVATION_TIMEOUT_MS,
	RUNTIME_PREPARATION_TIMEOUT_MS,
	type RuntimeActivation,
	runtimeActivation,
	sealRuntimeActivationBoot,
} from "../../src/cloud-workspace-runtime-activation.ts";
import { workspaceStartupOutcome } from "../../src/cloud-workspace-runtime-scheduling.ts";
import {
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
	type RuntimeBootstrapReceipt,
} from "../../src/cloud-workspace-store.ts";
import * as Config from "../../src/config.ts";
import { SandboxOfferConfiguration } from "../../src/sandbox-provider-module.ts";
import { WorkspaceStartupTask } from "../../src/workspace-startup.ts";

const testLayer = Layer.mergeAll(
	Config.layer({
		apiIssuer: "https://api.test",
		workosJwksUrl: "https://unused.test/jwks",
		workosIssuer: "https://unused.test",
		mintPrivateKey: Redacted.make("{}"),
		mintPublicKey: "{}",
		cloudDataEncryptionKey: Redacted.make(
			"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		),
	}),
	CloudWorkspaceStoreMemory,
	CloudBillingStoreMemory,
	SandboxProvidersFake,
	Layer.succeed(SandboxOfferConfiguration, {
		port: 47_837,
		createTimeoutSeconds: 3_600,
		keepAliveTimeoutSeconds: 600,
		runtimeManifestUrl: "https://releases.test/stable-manifest.json",
		runtimeInstallerSource: "// signed-runtime transaction installer",
		runtimeSigningPublicJwk: "{}",
	}),
);

const fixture = Effect.fn("runtimeActivationFixture")(function* () {
	const store = yield* CloudWorkspaceStore;
	const control = yield* FakeSandboxProviderControlService;
	const providers = yield* SandboxProviders;
	const base = yield* providers.get("fake");
	const nowMs = Date.now();
	yield* store.connectProject({
		projectId: "project",
		accountId: "account",
		repositoryIdentity: "github.com/acme/repo",
		repositoryUrl: "https://github.com/acme/repo.git",
		displayName: "repo",
		defaultBranch: "main",
		visibility: "public",
		gitConnectionKind: "github-app",
		cloudEnvironment: {},
		secretBindings: [],
		configurationDigest: "digest",
		state: "ready",
		idempotencyKey: "project",
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
	});
	yield* store.createBuild({
		buildId: "build",
		projectId: "project",
		accountId: "account",
		provider: "fake",
		snapshotId: "image",
		templateVersion: "test-template",
		configurationDigest: "digest",
		state: "ready",
		idempotencyKey: "build",
		nextActionAtMs: Number.MAX_SAFE_INTEGER,
		revision: 1,
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
	});
	const initial: CloudWorkspaceRecord = {
		workspaceId: "workspace",
		accountId: "account",
		projectId: "project",
		buildId: "build",
		provider: "fake",
		providerSandboxId: "machine",
		runtimeState: "offline",
		runtimeCredentialHash: "old-credential",
		chatId: "original-chat",
		initialSessionId: "original-session",
		branch: "task",
		baseRef: "origin/main",
		state: "resuming",
		desiredState: "ready",
		statusCode: "restart-queued",
		idempotencyKey: "workspace",
		requestConfig: {
			runtimeGeneration: 7,
			gatewayEpoch: 7,
			sessionHeadVersion: 4,
		},
		nextActionAtMs: nowMs,
		revision: 1,
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
		lastActivityAtMs: nowMs,
	};
	yield* store.createWorkspace(initial, {
		workspaceId: initial.workspaceId,
		accountId: initial.accountId,
		chatId: initial.chatId,
		sessionId: initial.initialSessionId,
		turnId: "turn",
		commandId: "launch",
		ciphertext: "sealed-intent",
		expiresAtMs: nowMs + 86_400_000,
		createdAtMs: nowMs,
	});
	yield* Ref.update(control.sandboxes, (entries) =>
		new Map(entries).set("machine", {
			providerSandboxId: "machine",
			providerLabel: "zuse-cloud-workspace-workspace",
			state: "running",
		}),
	);
	let journal: unknown = null;
	let loseNextLaunch = false;
	let processState: "active" | "inactive" | "unknown" = "inactive";
	const starts: SandboxProcessInput[] = [];
	const replacements: SandboxProcessInput[] = [];
	const adapter: SandboxProviderAdapter = {
		...base,
		supportsFencedProcessReplacement: true,
		inspectProcess: () => Effect.succeed(processState),
		readTextFile: (_id, path) =>
			Effect.sync(() =>
				path === RUNTIME_ACTIVATION_JOURNAL ? JSON.stringify(journal) : "",
			),
		startProcess: (_id, input) =>
			Effect.sync(() => {
				starts.push(input);
			}),
		replaceProcess: (_id, _selector, input) =>
			Effect.gen(function* () {
				replacements.push(input);
				if (loseNextLaunch) {
					loseNextLaunch = false;
					return yield* Effect.fail(
						new SandboxProviderError({ code: "transient" }),
					);
				}
			}),
	};
	const read = Effect.gen(function* () {
		const workspace = yield* store.getWorkspace("workspace");
		if (workspace === null) throw new Error("Workspace disappeared");
		return workspace;
	});
	const save = (changes: Partial<CloudWorkspaceRecord>) =>
		Effect.gen(function* () {
			const workspace = yield* read;
			yield* store.saveWorkspace({
				...workspace,
				...changes,
				revision: workspace.revision + 1,
				updatedAtMs: Date.now(),
			});
		});
	const installOperation = (changes: Partial<RuntimeActivation> = {}) =>
		Effect.gen(function* () {
			const workspace = yield* read;
			const operation: RuntimeActivation = {
				id: "operation",
				phase: "launching",
				startedAtMs: Date.now(),
				attempts: 0,
				generation: 7,
				targetVersion: "candidate",
				...changes,
			};
			const sealedBootToken = yield* sealRuntimeActivationBoot(
				workspace,
				operation,
				"boot-secret",
			);
			yield* save({
				state: "provisioning",
				runtimeBootTokenHash: "boot-hash",
				runtimeBootTokenExpiresAtMs: Date.now() + 60_000,
				requestConfig: {
					...workspace.requestConfig,
					runtimeSessionRecoveryPending: true,
					runtimeActivation: { ...operation, sealedBootToken },
				},
			});
			journal = {
				transactionId: operation.id,
				phase: "activated",
				generation: operation.generation,
				candidate: { version: "candidate" },
				previous: { version: "previous", signed: true },
				confirmedVersion: null,
			};
			return operation;
		});
	return {
		store,
		read,
		save,
		starts,
		replacements,
		installOperation,
		processState: (value: "active" | "inactive" | "unknown") => {
			processState = value;
		},
		journal: (value: unknown) => {
			journal = value;
		},
		loseNextLaunch: () => {
			loseNextLaunch = true;
		},
		startup: reconcileCloudWorkspaceStartup("workspace").pipe(
			Effect.provideService(SandboxProviders, {
				...providers,
				get: () => Effect.succeed(adapter),
			}),
		),
		reconcile: reconcileCloudWorkspace("workspace").pipe(
			Effect.provideService(SandboxProviders, {
				...providers,
				get: () => Effect.succeed(adapter),
			}),
		),
	};
});

const receipt = (acknowledged: boolean): RuntimeBootstrapReceipt => ({
	workspaceId: "workspace",
	bootTokenHash: "boot-hash",
	credentialKeyThumbprint: "encryption-key",
	signingKeyThumbprint: "signing-key",
	signingPublicJwk: "{}",
	runtimeCredentialHash: "new-credential",
	runtimeCredentialExpiresAtMs: Date.now() + 60_000,
	generation: 7,
	gatewayEpoch: 7,
	sealedTranscriptKey: "sealed-transcript",
	enrolledAtMs: Date.now(),
	...(acknowledged ? { acknowledgedAtMs: Date.now() } : {}),
});

describe("workspace runtime activation orchestration", () => {
	test("durable alarms drive slow preparation through actual authenticated confirmation after object recreation", async () => {
		const runtime = ManagedRuntime.make(testLayer);
		try {
			const f = await runtime.runPromise(fixture());
			const initial = await runtime.runPromise(f.read);
			await runtime.runPromise(
				f.save({
					nextActionAtMs: 0,
					requestConfig: {
						...initial.requestConfig,
						runtimeReleaseChangeRequested: true,
						runtimeActivation: {
							id: "slow-download",
							mode: "change-release",
							phase: "preparing",
							startedAtMs: Date.now() - 90_000,
							attempts: 0,
						},
					},
				}),
			);
			const values = new Map<string, unknown>();
			let alarm: number | null = null;
			const storage = {
				get: async (key: string) => values.get(key),
				put: async (key: string, value: unknown) => {
					values.set(key, value);
				},
				delete: async (key: string) => values.delete(key),
				getAlarm: async () => alarm,
				setAlarm: async (value: number) => {
					alarm = value;
				},
				transaction: async <T>(run: (value: unknown) => Promise<T>) =>
					run(storage),
			};
			const state = { storage } as unknown as DurableObjectState;
			const task = () =>
				new WorkspaceStartupTask(state, () => runtime.runPromise(f.startup));
			await task().fetch(
				new Request("https://test/schedule", {
					method: "POST",
					body: JSON.stringify({ workspaceId: "workspace" }),
				}),
			);
			const fire = async () => {
				alarm = null;
				await task().alarm();
			};
			await fire();
			expect(values.has("pending")).toBe(true);
			expect(alarm).toBeGreaterThan(Date.now());
			expect((await runtime.runPromise(f.read)).runtimeCredentialHash).toBe(
				"old-credential",
			);
			f.journal({
				transactionId: "slow-download",
				phase: "prepared",
				generation: null,
				candidate: { version: "candidate" },
				previous: { version: "previous", signed: true },
			});
			await runtime.runPromise(f.save({ nextActionAtMs: 0 }));
			await fire();
			const launching = await runtime.runPromise(f.read);
			expect(runtimeActivation(launching)?.generation).toBe(8);
			expect(values.has("pending")).toBe(true);
			await runtime.runPromise(
				f.save({
					state: "ready",
					runtimeState: "online",
					runtimeCredentialHash: "authenticated",
					runtimeBootTokenHash: undefined,
					runtimeBootTokenExpiresAtMs: undefined,
					nextActionAtMs: 0,
					requestConfig: {
						...launching.requestConfig,
						runtimeSessionRecoveryPending: false,
					},
				}),
			);
			await runtime.runPromise(
				f.store.saveRuntimeSummary({
					workspaceId: "workspace",
					runtimeGeneration: 8,
					summaryRevision: 1,
					title: "Original chat",
					lastActivityAtMs: Date.now(),
					activeSessionId: "original-session",
					sessionHeadVersion: 4,
					updatedAtMs: Date.now(),
				}),
			);
			await fire();
			expect(runtimeActivation(await runtime.runPromise(f.read))?.phase).toBe(
				"confirming",
			);
			expect(values.has("pending")).toBe(true);
			f.journal({
				transactionId: "slow-download",
				phase: "confirmed",
				generation: 8,
				confirmedVersion: "candidate",
				candidate: { version: "candidate" },
				previous: { version: "previous", signed: true },
			});
			await runtime.runPromise(f.save({ nextActionAtMs: 0 }));
			await fire();
			expect(runtimeActivation(await runtime.runPromise(f.read))?.phase).toBe(
				"confirmed",
			);
			expect(values.has("pending")).toBe(false);
			expect(f.replacements).toHaveLength(1);
			expect((await runtime.runPromise(f.read)).chatId).toBe("original-chat");
		} finally {
			await runtime.dispose();
		}
	});

	test("ordinary restart stays on the installed release even with a configured signed channel", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* f.reconcile;
				const workspace = yield* f.read;
				expect(runtimeActivation(workspace)).toMatchObject({
					mode: "restart-installed",
					phase: "launching",
					generation: 8,
				});
				expect(f.starts).toHaveLength(0);
				expect(f.replacements).toHaveLength(1);
				expect(f.replacements[0]?.activation?.generation).toBe(8);
				expect(
					f.replacements[0]?.env?.ZUSE_RUNTIME_ACTIVATION_MODE,
				).toBeUndefined();
				expect(f.replacements[0]?.env?.ZUSE_RUNTIME_EXPECT_EXISTING_DATA).toBe(
					"1",
				);
				expect(workspace.requestConfig.runtimeInstallPending).toBe(false);
				expect(workspace.chatId).toBe("original-chat");
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test.each([
		"online",
		"offline",
	] as const)("bounds confirming with %s evidence without replacing or revoking the owner", async (runtimeState) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* f.installOperation({
					phase: "confirming",
					startedAtMs: Date.now() - RUNTIME_ACTIVATION_TIMEOUT_MS - 1,
				});
				yield* f.save({
					state: "ready",
					runtimeState,
					runtimeCredentialHash: "authenticated-owner",
					runtimeBootTokenHash: undefined,
					runtimeBootTokenExpiresAtMs: undefined,
				});
				yield* f.reconcile;
				const after = yield* f.read;
				expect(runtimeActivation(after)).toMatchObject({
					phase: "verification-needed",
					lastErrorCode: "runtime-update-verification-needed",
				});
				expect(runtimeActivation(after)?.sealedBootToken).toBeUndefined();
				expect(after.runtimeCredentialHash).toBe("authenticated-owner");
				expect(after.requestConfig.runtimeGeneration).toBe(7);
				expect(after.nextActionAtMs).toBe(Number.MAX_SAFE_INTEGER);
				if (runtimeState === "online") expect(after.state).toBe("ready");
				yield* f.reconcile;
				expect(f.replacements).toHaveLength(0);
				expect(f.starts).toHaveLength(0);
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test("startup returns the durable deadline while preparation outlives the former request observer", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const f = yield* fixture();
				const workspace = yield* f.read;
				yield* f.save({
					nextActionAtMs: 0,
					requestConfig: {
						...workspace.requestConfig,
						runtimeActivation: {
							id: "slow-download",
							phase: "preparing",
							mode: "change-release",
							startedAtMs: Date.now() - 90_000,
							attempts: 0,
						},
					},
				});
				const outcome = yield* f.startup;
				const waiting = yield* f.read;
				expect(outcome).toEqual({
					kind: "due",
					dueAtMs: waiting.nextActionAtMs,
				});
				expect(runtimeActivation(waiting)?.phase).toBe("preparing");
				expect(waiting.runtimeCredentialHash).toBe("old-credential");
				expect(waiting.requestConfig.runtimeGeneration).toBe(7);
				expect(f.replacements).toHaveLength(0);
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test("prepares without fencing the old writer, then authorizes only the prepared signed candidate", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const f = yield* fixture();
				const before = yield* f.read;
				yield* f.save({
					state: "ready",
					runtimeState: "online",
					statusCode: "update-queued",
					requestConfig: {
						...before.requestConfig,
						runtimeReleaseChangeRequested: true,
					},
				});
				expect(workspaceStartupOutcome(yield* f.read, Date.now()).kind).toBe(
					"due",
				);
				yield* f.reconcile;
				const preparing = yield* f.read;
				const operation = runtimeActivation(preparing);
				expect(operation?.phase).toBe("preparing");
				expect(preparing.state).toBe("ready");
				expect(preparing.runtimeState).toBe("online");
				expect(preparing.requestConfig.runtimeGeneration).toBe(7);
				expect(preparing.runtimeCredentialHash).toBe("old-credential");
				expect(f.replacements).toHaveLength(0);
				expect(f.starts[0]?.args?.join(" ")).toContain("--prepare");
				expect(f.starts[0]?.env?.ZUSE_RUNTIME_BOOT_TOKEN).toBeUndefined();
				f.journal({
					transactionId: operation?.id,
					phase: "prepared",
					generation: null,
					candidate: { version: "candidate" },
					previous: { version: "previous", signed: true },
				});
				yield* f.reconcile;
				const launching = yield* f.read;
				const active = runtimeActivation(launching);
				if (active === null) throw new Error("Activation missing");
				expect(launching.requestConfig.runtimeGeneration).toBe(8);
				expect(launching.runtimeCredentialHash).toBeUndefined();
				expect(active).toMatchObject({
					id: operation?.id,
					phase: "launching",
					generation: 8,
					targetVersion: "candidate",
				});
				expect(f.replacements).toHaveLength(1);
				const launch = f.replacements[0];
				expect(launch?.activation).toEqual({
					operationId: active.id,
					generation: 8,
				});
				expect(launch?.env).toMatchObject({
					ZUSE_RUNTIME_ACTIVATION_MODE: "activate",
					ZUSE_RUNTIME_SKIP_TOOLCHAIN: "1",
					ZUSE_RUNTIME_UPDATE_GENERATION: "8",
				});
				const token = yield* openRuntimeActivationBoot(launching, active);
				expect(token).toBe(launch?.env?.ZUSE_RUNTIME_BOOT_TOKEN);
				expect(JSON.stringify(launching)).not.toContain(token);
				expect(launching.chatId).toBe("original-chat");
				expect(launching.providerSandboxId).toBe("machine");
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test("explicit restart resumes the retained unconfirmed release transaction without preparing a newer channel", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* f.installOperation({ phase: "verification-needed" });
				yield* f.save({ state: "resuming", statusCode: "restart-queued" });
				yield* f.reconcile;
				const workspace = yield* f.read;
				expect(runtimeActivation(workspace)).toMatchObject({
					id: "operation",
					phase: "launching",
					generation: 8,
					targetVersion: "candidate",
				});
				expect(f.starts).toHaveLength(0);
				expect(f.replacements).toHaveLength(1);
				expect(f.replacements[0]?.env).toMatchObject({
					ZUSE_RUNTIME_UPDATE_TRANSACTION_ID: "operation",
					ZUSE_RUNTIME_EXPECTED_VERSION: "candidate",
					ZUSE_RUNTIME_ACTIVATION_MODE: "activate",
				});
				expect(f.replacements[0]?.env?.ZUSE_RUNTIME_BOOT_TOKEN).not.toBe(
					"boot-secret",
				);
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test("replays the same fenced launch after provider response loss before enrollment", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* f.installOperation();
				f.loseNextLaunch();
				yield* f.reconcile.pipe(Effect.exit);
				yield* f.reconcile;
				expect(f.replacements).toHaveLength(2);
				expect(f.replacements[1]?.activation).toEqual(
					f.replacements[0]?.activation,
				);
				expect(f.replacements[1]?.env?.ZUSE_RUNTIME_BOOT_TOKEN).toBe(
					"boot-secret",
				);
				expect((yield* f.read).requestConfig.runtimeGeneration).toBe(7);
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test.each([
		false,
		true,
	])("never replays an enrolled process token (acknowledged=%s)", async (acknowledged) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* f.installOperation();
				const workspace = yield* f.read;
				yield* f.save({
					runtimeCredentialHash: "new-credential",
					runtimeBootTokenHash: acknowledged ? undefined : "boot-hash",
					runtimeBootTokenExpiresAtMs: acknowledged
						? undefined
						: Date.now() + 60_000,
					requestConfig: {
						...workspace.requestConfig,
						runtimeBootstrapReceipt: receipt(acknowledged),
					},
				});
				yield* f.reconcile;
				const waiting = yield* f.read;
				expect(runtimeActivation(waiting)?.phase).toBe("launching");
				expect(waiting.requestConfig.runtimeGeneration).toBe(7);
				expect(waiting.runtimeCredentialHash).toBe("new-credential");
				expect(f.replacements).toHaveLength(0);
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test.each([
		"active",
		"unknown",
	] as const)("a timed-out candidate with %s process evidence cannot authorize rollback", async (processState) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const f = yield* fixture();
				f.processState(processState);
				yield* f.installOperation({
					startedAtMs: Date.now() - RUNTIME_ACTIVATION_TIMEOUT_MS - 1,
				});
				yield* f.reconcile;
				const after = yield* f.read;
				expect(after.requestConfig.runtimeGeneration).toBe(7);
				expect(after.runtimeCredentialHash).toBe("old-credential");
				expect(runtimeActivation(after)?.phase).toBe("failed");
				expect(f.replacements).toHaveLength(0);
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test("fences a signed rollback freshly and removes the candidate enrollment receipt", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* f.installOperation({
					startedAtMs: Date.now() - RUNTIME_ACTIVATION_TIMEOUT_MS - 1,
				});
				const workspace = yield* f.read;
				yield* f.save({
					runtimeCredentialHash: "new-credential",
					runtimeBootTokenHash: undefined,
					runtimeBootTokenExpiresAtMs: undefined,
					requestConfig: {
						...workspace.requestConfig,
						runtimeBootstrapReceipt: receipt(true),
					},
				});
				yield* f.reconcile;
				const rollback = yield* f.read;
				expect(runtimeActivation(rollback)).toMatchObject({
					id: "operation",
					phase: "rolling-back",
					generation: 8,
					targetVersion: "previous",
				});
				expect(rollback.runtimeCredentialHash).toBeUndefined();
				expect(rollback.runtimeBootTokenHash).toBeDefined();
				expect(rollback.requestConfig.runtimeBootstrapReceipt).toBeUndefined();
				yield* f.reconcile;
				expect(f.replacements[0]?.env).toMatchObject({
					ZUSE_RUNTIME_ACTIVATION_MODE: "rollback",
					ZUSE_RUNTIME_EXPECTED_VERSION: "previous",
					ZUSE_RUNTIME_UPDATE_GENERATION: "8",
				});
				expect(f.replacements[0]?.env?.ZUSE_RUNTIME_BOOT_TOKEN).not.toBe(
					"boot-secret",
				);
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test.each([
		3, 4,
	])("confirms only after authenticated recovery reaches required session head (summary=%i)", async (sessionHeadVersion) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* f.installOperation();
				const workspace = yield* f.read;
				yield* f.save({
					state: "ready",
					runtimeState: "online",
					runtimeBootTokenHash: undefined,
					runtimeBootTokenExpiresAtMs: undefined,
					requestConfig: {
						...workspace.requestConfig,
						runtimeSessionRecoveryPending: false,
						runtimeBootstrapReceipt: receipt(true),
					},
				});
				yield* f.store.saveRuntimeSummary({
					workspaceId: "workspace",
					runtimeGeneration: 7,
					summaryRevision: 1,
					title: "Existing conversation",
					lastActivityAtMs: Date.now(),
					activeSessionId: "original-session",
					sessionHeadVersion,
					updatedAtMs: Date.now(),
				});
				yield* f.reconcile;
				if (sessionHeadVersion === 4) {
					expect(f.starts).toHaveLength(1);
					expect(f.starts[0]?.args?.join(" ")).toContain("--confirm");
					expect(f.starts[0]?.env).toMatchObject({
						ZUSE_RUNTIME_UPDATE_TRANSACTION_ID: "operation",
						ZUSE_RUNTIME_UPDATE_GENERATION: "7",
						ZUSE_RUNTIME_EXPECTED_VERSION: "candidate",
					});
					expect(f.starts[0]?.env?.ZUSE_RUNTIME_BOOT_TOKEN).toBeUndefined();
					expect(runtimeActivation(yield* f.read)?.phase).toBe("confirming");
				} else {
					expect(f.starts).toHaveLength(0);
					expect(runtimeActivation(yield* f.read)?.phase).not.toBe("confirmed");
				}
				expect(f.replacements).toHaveLength(0);
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test("a preparation timeout leaves the existing authenticated owner usable", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const f = yield* fixture();
				const workspace = yield* f.read;
				yield* f.save({
					state: "resuming",
					runtimeState: "online",
					requestConfig: {
						...workspace.requestConfig,
						runtimeActivation: {
							id: "preparation",
							phase: "preparing",
							attempts: 0,
							startedAtMs: Date.now() - RUNTIME_PREPARATION_TIMEOUT_MS - 1,
						},
					},
				});
				yield* f.reconcile;
				const recovered = yield* f.read;
				expect(recovered.state).toBe("ready");
				expect(recovered.runtimeState).toBe("online");
				expect(recovered.runtimeCredentialHash).toBe("old-credential");
				expect(recovered.requestConfig.runtimeGeneration).toBe(7);
				expect(runtimeActivation(recovered)?.phase).toBe("failed");
				expect(f.replacements).toHaveLength(0);
			}).pipe(Effect.provide(testLayer)),
		);
	});

	test.each([
		[6, "candidate", false],
		[7, "other-version", false],
		[7, "candidate", true],
	] as const)("accepts confirmation only for exact generation %i and version %s", async (generation, version, accepted) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* f.installOperation({ phase: "confirming" });
				f.journal({
					transactionId: "operation",
					phase: "confirmed",
					generation,
					candidate: { version: "candidate" },
					previous: { version: "previous", signed: true },
					confirmedVersion: version,
				});
				yield* f.reconcile;
				const workspace = yield* f.read;
				expect(runtimeActivation(workspace)?.phase === "confirmed").toBe(
					accepted,
				);
				if (accepted)
					expect(runtimeActivation(workspace)?.sealedBootToken).toBeUndefined();
			}).pipe(Effect.provide(testLayer)),
		);
	});
});
