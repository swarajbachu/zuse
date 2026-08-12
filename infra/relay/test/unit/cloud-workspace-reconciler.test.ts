import {
	FakeSandboxProviderControlService,
	SandboxProvidersFake,
} from "@zuse/sandbox-providers/testing";
import { Effect, Layer, Redacted, Ref } from "effect";
import { describe, expect, test } from "vitest";
import { CloudCredentialVault } from "../../src/cloud-credential-vault.ts";
import {
	reconcileCloudWorkspace,
	WORKSPACE_RUNTIME_PROCESS_PATTERN,
	WORKSPACE_RUNTIME_RESUME_COMMAND,
	WORKSPACE_RUNTIME_RESUME_SCRIPT,
} from "../../src/cloud-workspace-reconciler.ts";
import {
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

describe("cloud workspace reconciler", () => {
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

	test("marks paused runtimes offline before resuming the same sandbox", async () => {
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
					commandId: "start:workspace-resume",
					workspaceId: workspace.workspaceId,
					accountId: workspace.accountId,
					sequence: 1,
					kind: "start-agent",
					payload: {},
					state: "queued",
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
					workspace: resumed,
					missing: yield* store.getWorkspace(workspace.workspaceId),
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
		expect(result.resumeBeforeMissing).toHaveLength(1);
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
	});
});
