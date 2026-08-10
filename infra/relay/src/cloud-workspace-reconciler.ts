import {
	type SandboxProviderAdapter,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { Clock, Effect } from "effect";
import { CloudCredentialVault } from "./cloud-credential-vault.ts";
import {
	CLOUD_WORKSPACE_RETRY_MS,
	cloudWorkspaceAfterProviderFailure,
	cloudWorkspaceAfterSetupFailure,
	cloudWorkspaceEnrollmentNeedsRefresh,
	cloudWorkspaceReconcileDelay,
	cloudWorkspaceStartupTimedOut,
	cloudWorkspaceWithoutProviderSandbox,
} from "./cloud-workspace-failure.ts";
import {
	type CloudProjectBuildRecord,
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
} from "./cloud-workspace-store.ts";
import { RelayConfiguration } from "./config.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { SandboxOfferConfiguration } from "./sandbox-provider-module.ts";
import { RelayStore } from "./store.ts";

const RETRY_MS = CLOUD_WORKSPACE_RETRY_MS;
const RECONCILE_LEASE_MS = 2 * 60 * 1_000;
const PROJECT_BUILD_TIMEOUT_MS = 15 * 60 * 1_000;
const IDLE_PAUSE_MS = 60 * 60 * 1_000;
const WARM_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const WORKSPACE_ENROLLMENT_TTL_MS = 30 * 60 * 1_000;
const WORKSPACE_ENROLLMENT_TOKEN_FILE =
	"/run/zuse-secrets/workspace-enrollment-token";

const providerLabel = (kind: "build" | "workspace", id: string): string =>
	`zuse-cloud-${kind}-${id.replace(/[^A-Za-z0-9-]/gu, "-")}`.slice(0, 63);

const issueWorkspaceEnrollment = Effect.fn("issueWorkspaceEnrollment")(
	function* (
		provider: SandboxProviderAdapter,
		providerSandboxId: string,
		nowMs: number,
	) {
		const token = yield* randomToken("workspace_enroll", 32);
		yield* provider.writeTextFile(
			providerSandboxId,
			WORKSPACE_ENROLLMENT_TOKEN_FILE,
			token,
			"zuse",
		);
		yield* provider.startProcess(providerSandboxId, {
			command: "/usr/bin/chmod",
			args: ["0600", WORKSPACE_ENROLLMENT_TOKEN_FILE],
			user: "zuse",
		});
		return {
			tokenHash: yield* sha256Hex(token),
			expiresAtMs: nowMs + WORKSPACE_ENROLLMENT_TTL_MS,
		};
	},
);

const startWorkspaceRuntime = (
	provider: SandboxProviderAdapter,
	workspace: CloudWorkspaceRecord,
	providerSandboxId: string,
	relayIssuer: string,
) =>
	provider.startProcess(providerSandboxId, {
		command: "/bin/bash",
		args: [
			"-lc",
			'/usr/local/bin/zuse serve --foreground >>/var/lib/zuse/workspace/runtime.log 2>&1; code=$?; if [[ ! -f /var/lib/zuse/workspace/credentials-ready ]]; then touch /var/lib/zuse/workspace/failed; fi; exit "$code"',
		],
		cwd: "/home/zuse/workspace",
		env: {
			ZUSE_RUNTIME_KIND: "cloud-workspace",
			ZUSE_CLOUD_WORKSPACE_ID: workspace.workspaceId,
			ZUSE_HOST: "0.0.0.0",
			ZUSE_PORT: "47837",
			ZUSE_AUTH_POLICY: "protected",
			ZUSE_ENABLE_PAIRING: "0",
			ZUSE_MACHINE_RUNTIME_ROLE: "cloud-environment",
			ZUSE_SERVER_READY_STDOUT: "1",
			ZUSE_USER_DATA: "/home/zuse/.zuse-data",
			ZUSE_ENROLLMENT_TOKEN_FILE: WORKSPACE_ENROLLMENT_TOKEN_FILE,
			ZUSE_RELAY_URL: relayIssuer,
			ZUSE_RELAY_ISSUER: relayIssuer,
		},
		user: "zuse",
	});

const reconcileBuildRecord = Effect.fn("reconcileCloudProjectBuild")(function* (
	build: CloudProjectBuildRecord,
) {
	const store = yield* CloudWorkspaceStore;
	const project = yield* store.getProject(build.projectId);
	if (project === null) return;
	const provider = yield* (yield* SandboxProviders)
		.get(build.provider)
		.pipe(Effect.orDie);
	const config = yield* SandboxOfferConfiguration;
	const nowMs = yield* Clock.currentTimeMillis;
	if (build.state === "queued") {
		const gitCredential =
			project.visibility === "private"
				? yield* store.getCredential(project.accountId, "github")
				: null;
		const gitPayload =
			gitCredential?.state === "connected" &&
			gitCredential.encryptedPayload !== undefined
				? yield* (yield* CloudCredentialVault).decrypt(
						project.accountId,
						"github",
						gitCredential.credentialVersion,
						gitCredential.encryptedPayload,
					)
				: null;
		if (project.visibility === "private" && gitPayload === null) {
			yield* store.saveBuild({
				...build,
				state: "failed",
				lastErrorCode: "git-credential-required",
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: build.revision + 1,
				updatedAtMs: nowMs,
			});
			return;
		}
		const label = providerLabel("build", build.buildId);
		const existing = yield* provider.recoverByLabel(label).pipe(Effect.orDie);
		const sandbox =
			existing ??
			(yield* provider
				.create({
					sandboxId: build.buildId,
					providerLabel: label,
					timeoutSeconds: config.createTimeoutSeconds,
					env: {},
					network: { kind: "open" },
					onTimeout: "terminate",
				})
				.pipe(Effect.orDie));
		if (gitPayload !== null) {
			yield* provider.writeTextFile(
				sandbox.providerSandboxId,
				"/run/zuse-secrets/github-token",
				gitPayload.secret,
				"zuse",
			);
			yield* provider.startProcess(sandbox.providerSandboxId, {
				command: "/usr/bin/chmod",
				args: ["0600", "/run/zuse-secrets/github-token"],
				user: "zuse",
			});
		}
		yield* provider
			.startProcess(sandbox.providerSandboxId, {
				command: "/bin/bash",
				args: [
					"-lc",
					'set +e; /usr/local/bin/zuse-project-builder >/dev/null 2>&1; code=$?; printf \'%s\\n\' "$code" >/tmp/zuse-project-builder-exit-code; touch /tmp/zuse-project-builder-exited; exit "$code"',
				],
				env: {
					...project.cloudEnvironment,
					ZUSE_REPOSITORY_URL: project.repositoryUrl,
					ZUSE_DEFAULT_BRANCH: project.defaultBranch,
					ZUSE_SETUP_COMMAND: project.setupCommand ?? "",
					ZUSE_TEMPLATE_VERSION: build.templateVersion,
					ZUSE_CONFIGURATION_DIGEST: build.configurationDigest,
				},
				user: "zuse",
			})
			.pipe(Effect.orDie);
		yield* store.saveBuild({
			...build,
			providerSandboxId: sandbox.providerSandboxId,
			state: "building",
			nextActionAtMs: nowMs + RETRY_MS,
			revision: build.revision + 1,
			updatedAtMs: nowMs,
		});
		return;
	}
	if (build.state === "building" && build.providerSandboxId !== undefined) {
		const buildTimedOut = nowMs - build.createdAtMs >= PROJECT_BUILD_TIMEOUT_MS;
		const builderExited = yield* provider
			.pathExists(
				build.providerSandboxId,
				"/tmp/zuse-project-builder-exited",
				"zuse",
			)
			.pipe(Effect.orDie);
		const ready = yield* provider
			.pathExists(
				build.providerSandboxId,
				"/var/lib/zuse/project-build/ready",
				"zuse",
			)
			.pipe(Effect.orDie);
		if (
			buildTimedOut ||
			(builderExited && !ready) ||
			(yield* provider
				.pathExists(
					build.providerSandboxId,
					"/var/lib/zuse/project-build/failed",
					"zuse",
				)
				.pipe(Effect.orDie))
		) {
			yield* provider.kill(build.providerSandboxId).pipe(Effect.ignore);
			const previous = yield* store.getActiveBuild(
				build.projectId,
				build.provider,
			);
			yield* store.saveBuild({
				...build,
				providerSandboxId: undefined,
				state: "failed",
				lastErrorCode: buildTimedOut
					? "project-setup-timeout"
					: "project-setup-failed",
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: build.revision + 1,
				updatedAtMs: nowMs,
			});
			yield* store.saveProject({
				...project,
				state: previous === null ? "failed" : "ready",
				lastErrorCode: buildTimedOut
					? "project-setup-timeout"
					: "project-setup-failed",
				updatedAtMs: nowMs,
			});
			return;
		}
		if (!ready) {
			yield* store.saveBuild({
				...build,
				nextActionAtMs: nowMs + RETRY_MS,
				updatedAtMs: nowMs,
			});
			return;
		}
		const forbiddenPaths = [
			"/home/zuse/.config/gh",
			"/home/zuse/.claude",
			"/home/zuse/.codex",
			"/home/zuse/.zuse-data",
			"/home/zuse/.git-credentials",
			"/home/zuse/.netrc",
			"/run/zuse-secrets",
		];
		const forbiddenResults = yield* Effect.forEach(forbiddenPaths, (path) =>
			provider.pathExists(build.providerSandboxId as string, path, "zuse"),
		);
		const sourceCommit = (yield* provider.readTextFile(
			build.providerSandboxId,
			"/var/lib/zuse/project-build/source-commit",
			"zuse",
		)).trim();
		const templateVersion = (yield* provider.readTextFile(
			build.providerSandboxId,
			"/var/lib/zuse/project-build/template-version",
			"zuse",
		)).trim();
		const configurationDigest = (yield* provider.readTextFile(
			build.providerSandboxId,
			"/var/lib/zuse/project-build/configuration-digest",
			"zuse",
		)).trim();
		if (
			forbiddenResults.some(Boolean) ||
			!/^[0-9a-f]{40,64}$/u.test(sourceCommit) ||
			templateVersion !== build.templateVersion ||
			configurationDigest !== build.configurationDigest
		) {
			yield* provider.kill(build.providerSandboxId).pipe(Effect.ignore);
			const previous = yield* store.getActiveBuild(
				build.projectId,
				build.provider,
			);
			yield* store.saveBuild({
				...build,
				providerSandboxId: undefined,
				state: "failed",
				lastErrorCode: "snapshot-sanitization-failed",
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: build.revision + 1,
				updatedAtMs: nowMs,
			});
			yield* store.saveProject({
				...project,
				state: previous === null ? "failed" : "ready",
				lastErrorCode: "snapshot-sanitization-failed",
				updatedAtMs: nowMs,
			});
			return;
		}
		const sanitizing = {
			...build,
			sourceCommit,
			state: "sanitizing" as const,
			nextActionAtMs: nowMs,
			revision: build.revision + 1,
			updatedAtMs: nowMs,
		};
		yield* store.saveBuild(sanitizing);
		const snapshotId = yield* provider
			.snapshot(
				build.providerSandboxId,
				`${project.projectId}-${build.buildId}`,
			)
			.pipe(Effect.orDie);
		yield* provider.kill(build.providerSandboxId).pipe(Effect.ignore);
		yield* store.saveBuild({
			...sanitizing,
			snapshotId,
			providerSandboxId: undefined,
			state: "ready",
			nextActionAtMs: Number.MAX_SAFE_INTEGER,
			revision: sanitizing.revision + 1,
			updatedAtMs: nowMs,
		});
		yield* store.saveProject({
			...project,
			state: "ready",
			lastErrorCode: undefined,
			updatedAtMs: nowMs,
		});
	}
});

const recordLifecycle = (
	workspace: CloudWorkspaceRecord,
	kind: string,
	nowMs: number,
) =>
	Effect.gen(function* () {
		const store = yield* CloudWorkspaceStore;
		yield* store.recordUsage({
			eventId: `${workspace.workspaceId}:${kind}:${workspace.revision}`,
			workspaceId: workspace.workspaceId,
			accountId: workspace.accountId,
			provider: workspace.provider,
			kind,
			quantity:
				kind === "runtime-seconds"
					? Math.max(
							0,
							Math.floor((nowMs - (workspace.runningSinceMs ?? nowMs)) / 1_000),
						)
					: 1,
			occurredAtMs: nowMs,
		});
	});

const pauseWorkspace = (
	workspace: CloudWorkspaceRecord,
	provider: SandboxProviderAdapter,
	nowMs: number,
	archived: boolean,
) =>
	Effect.gen(function* () {
		const store = yield* CloudWorkspaceStore;
		if (workspace.providerSandboxId !== undefined)
			yield* provider.pause(workspace.providerSandboxId);
		yield* recordLifecycle(workspace, "runtime-seconds", nowMs);
		yield* recordLifecycle(workspace, archived ? "archive" : "pause", nowMs);
		yield* store.saveWorkspace({
			...workspace,
			state: archived ? "archived" : "paused",
			desiredState: archived ? "archived" : "paused",
			statusCode: archived ? "archived" : "paused",
			warmRetentionDeadlineMs: archived
				? nowMs + WARM_RETENTION_MS
				: workspace.warmRetentionDeadlineMs,
			nextActionAtMs: archived
				? nowMs + WARM_RETENTION_MS
				: Number.MAX_SAFE_INTEGER,
			runningSinceMs: undefined,
			revision: workspace.revision + 1,
			updatedAtMs: nowMs,
		});
	});

const discardUnsafeWorkspaceSandbox = (
	provider: SandboxProviderAdapter,
	workspace: CloudWorkspaceRecord,
) =>
	Effect.gen(function* () {
		const providerSandboxId =
			workspace.providerSandboxId ??
			(yield* provider.recoverByLabel(
				providerLabel("workspace", workspace.workspaceId),
			))?.providerSandboxId;
		if (providerSandboxId !== undefined)
			yield* provider.kill(providerSandboxId);
	}).pipe(Effect.ignore);

const reconcileWorkspaceRecord = Effect.fn("reconcileCloudWorkspace")(
	function* (workspace: CloudWorkspaceRecord) {
		const store = yield* CloudWorkspaceStore;
		const provider = yield* (yield* SandboxProviders)
			.get(workspace.provider)
			.pipe(Effect.orDie);
		const config = yield* SandboxOfferConfiguration;
		const nowMs = yield* Clock.currentTimeMillis;
		if (workspace.desiredState === "deleted") {
			if (workspace.runningSinceMs !== undefined)
				yield* recordLifecycle(workspace, "runtime-seconds", nowMs);
			if (workspace.providerSandboxId !== undefined)
				yield* provider.kill(workspace.providerSandboxId).pipe(Effect.ignore);
			if (workspace.environmentId !== undefined)
				yield* (yield* RelayStore).deleteEnvironment(
					workspace.environmentId,
					workspace.accountId,
				);
			yield* recordLifecycle(workspace, "delete", nowMs);
			yield* store.saveWorkspace({
				...workspace,
				state: "deleted",
				statusCode: "deleted",
				providerSandboxId: undefined,
				recoveryBundleKey: undefined,
				runningSinceMs: undefined,
				deletedAtMs: nowMs,
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			});
			return;
		}
		if (cloudWorkspaceStartupTimedOut(workspace, nowMs)) {
			yield* discardUnsafeWorkspaceSandbox(provider, workspace);
			if (workspace.environmentId !== undefined)
				yield* (yield* RelayStore).deleteEnvironment(
					workspace.environmentId,
					workspace.accountId,
				);
			yield* store.saveWorkspace(
				cloudWorkspaceWithoutProviderSandbox({
					...workspace,
					state: "failed",
					statusCode: "provider-unavailable",
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				}),
			);
			return;
		}
		if (
			workspace.desiredState === "archived" &&
			workspace.state !== "archived"
		) {
			if (workspace.providerSandboxId === undefined) return;
			if (workspace.state !== "archiving") {
				yield* provider.startProcess(workspace.providerSandboxId, {
					command: "/usr/local/bin/zuse-archive-workspace",
					cwd: "/home/zuse/workspace",
					user: "zuse",
				});
				yield* store.saveWorkspace({
					...workspace,
					state: "archiving",
					statusCode: "archive-hook-running",
					nextActionAtMs: nowMs + RETRY_MS,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				});
				return;
			}
			if (
				yield* provider.pathExists(
					workspace.providerSandboxId,
					"/var/lib/zuse/workspace-archive/failed",
					"zuse",
				)
			) {
				yield* store.saveWorkspace({
					...workspace,
					state: "failed",
					statusCode: "archive-failed",
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				});
				return;
			}
			if (
				!(yield* provider.pathExists(
					workspace.providerSandboxId,
					"/var/lib/zuse/workspace-archive/ready",
					"zuse",
				))
			) {
				yield* store.saveWorkspace({
					...workspace,
					nextActionAtMs: nowMs + RETRY_MS,
					updatedAtMs: nowMs,
				});
				return;
			}
			return yield* pauseWorkspace(workspace, provider, nowMs, true);
		}
		if (workspace.desiredState === "paused" && workspace.state !== "paused")
			return yield* pauseWorkspace(workspace, provider, nowMs, false);
		if (workspace.state === "queued") {
			const build = yield* store.getBuild(workspace.buildId);
			if (build?.snapshotId === undefined) return;
			const project = yield* store.getProject(workspace.projectId);
			if (project === null) return;
			const label = providerLabel("workspace", workspace.workspaceId);
			const existing = yield* provider.recoverByLabel(label);
			const sandbox =
				existing ??
				(yield* provider.fork({
					sandboxId: workspace.workspaceId,
					providerLabel: label,
					snapshotId: build.snapshotId,
					timeoutSeconds: config.keepAliveTimeoutSeconds,
					env: {},
					onTimeout: "pause",
				}));
			const relay = yield* RelayConfiguration;
			const enrollment = yield* issueWorkspaceEnrollment(
				provider,
				sandbox.providerSandboxId,
				nowMs,
			);
			yield* provider.startProcess(sandbox.providerSandboxId, {
				command: "/usr/local/bin/zuse-workspace-bootstrap",
				cwd: "/home/zuse/workspace",
				env: {
					...project.cloudEnvironment,
					ZUSE_CLOUD_WORKSPACE_ID: workspace.workspaceId,
					ZUSE_ENROLLMENT_TOKEN_FILE: WORKSPACE_ENROLLMENT_TOKEN_FILE,
					ZUSE_RELAY_URL: relay.relayIssuer,
					ZUSE_RELAY_ISSUER: relay.relayIssuer,
					ZUSE_BASE_REF: workspace.baseRef,
					ZUSE_BRANCH: workspace.branch,
					ZUSE_INCREMENTAL_SETUP_COMMAND: project.setupCommand ?? "",
				},
				user: "zuse",
			});
			yield* store.saveWorkspace({
				...workspace,
				providerSandboxId: sandbox.providerSandboxId,
				enrollmentTokenHash: enrollment.tokenHash,
				enrollmentExpiresAtMs: enrollment.expiresAtMs,
				state: "provisioning",
				statusCode: "identity-reset",
				nextActionAtMs: nowMs + RETRY_MS,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			});
			return;
		}
		if (
			workspace.state === "provisioning" &&
			workspace.providerSandboxId !== undefined
		) {
			if (workspace.statusCode === "network-release-pending") {
				const released = yield* provider
					.startProcess(workspace.providerSandboxId, {
						command: "/usr/bin/touch",
						args: ["/var/lib/zuse/workspace/network-ready"],
						user: "zuse",
					})
					.pipe(
						Effect.as(true),
						Effect.catchTag("SandboxProviderError", (error) =>
							Effect.gen(function* () {
								const failure = cloudWorkspaceAfterProviderFailure(
									workspace,
									error.code,
									nowMs,
								);
								if (failure.state === "failed")
									yield* discardUnsafeWorkspaceSandbox(provider, workspace);
								yield* store.saveWorkspace(
									failure.state === "failed"
										? cloudWorkspaceWithoutProviderSandbox(failure)
										: failure,
								);
								return false;
							}),
						),
					);
				if (!released) return;
				yield* store.saveWorkspace({
					...workspace,
					state: "setup",
					statusCode: "enrollment-pending",
					nextActionAtMs: nowMs + RETRY_MS,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				});
				return;
			}
			if (
				yield* provider.pathExists(
					workspace.providerSandboxId,
					"/var/lib/zuse/workspace/failed",
					"zuse",
				)
			) {
				yield* discardUnsafeWorkspaceSandbox(provider, workspace);
				yield* store.saveWorkspace(
					cloudWorkspaceWithoutProviderSandbox(
						cloudWorkspaceAfterSetupFailure(workspace, nowMs),
					),
				);
				return;
			}
			if (
				!(yield* provider.pathExists(
					workspace.providerSandboxId,
					"/var/lib/zuse/workspace/rekeyed",
					"zuse",
				))
			) {
				yield* store.saveWorkspace({
					...workspace,
					nextActionAtMs: nowMs + RETRY_MS,
					updatedAtMs: nowMs,
				});
				return;
			}
			const relay = yield* RelayConfiguration;
			const relayHost = new URL(relay.relayIssuer).hostname;
			const networkRestricted = yield* provider
				.setNetwork(workspace.providerSandboxId, {
					kind: "restricted",
					allowOut: [relayHost],
					denyOut: ["0.0.0.0/0", "::/0"],
				})
				.pipe(
					Effect.as(true),
					Effect.catchTag("SandboxProviderError", (error) =>
						Effect.gen(function* () {
							const failure = cloudWorkspaceAfterProviderFailure(
								workspace,
								error.code,
								nowMs,
								"network-policy-rejected",
							);
							if (failure.state === "failed")
								yield* discardUnsafeWorkspaceSandbox(provider, workspace);
							yield* store.saveWorkspace(
								failure.state === "failed"
									? cloudWorkspaceWithoutProviderSandbox(failure)
									: failure,
							);
							return false;
						}),
					),
				);
			if (!networkRestricted) return;
			const endpoint = yield* provider.resolveEndpoint(
				workspace.providerSandboxId,
				config.port,
			);
			const networkReleaseWorkspace: CloudWorkspaceRecord = {
				...workspace,
				providerEndpointHttpBaseUrl: endpoint.httpBaseUrl,
				providerEndpointWsBaseUrl: endpoint.wsBaseUrl,
				statusCode: "network-release-pending",
				nextActionAtMs: nowMs + RETRY_MS,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			};
			yield* store.saveWorkspace(networkReleaseWorkspace);
			return;
		}
		if (
			workspace.state === "setup" &&
			workspace.providerSandboxId !== undefined
		) {
			if (cloudWorkspaceEnrollmentNeedsRefresh(workspace, nowMs)) {
				const enrollment = yield* issueWorkspaceEnrollment(
					provider,
					workspace.providerSandboxId,
					nowMs,
				);
				const relay = yield* RelayConfiguration;
				yield* startWorkspaceRuntime(
					provider,
					workspace,
					workspace.providerSandboxId,
					relay.relayIssuer,
				);
				yield* store.saveWorkspace({
					...workspace,
					enrollmentTokenHash: enrollment.tokenHash,
					enrollmentExpiresAtMs: enrollment.expiresAtMs,
					statusCode: "enrollment-retrying",
					nextActionAtMs: nowMs + RETRY_MS,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				});
				return;
			}
			if (
				workspace.environmentId !== undefined &&
				workspace.statusCode === "setup-running"
			) {
				yield* provider.setNetwork(workspace.providerSandboxId, {
					kind: "open",
				});
				yield* provider.startProcess(workspace.providerSandboxId, {
					command: "/usr/bin/touch",
					args: ["/var/lib/zuse/workspace/network-open"],
					user: "zuse",
				});
				yield* store.saveWorkspace({
					...workspace,
					statusCode: "repository-setup-running",
					nextActionAtMs: nowMs + RETRY_MS,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				});
				return;
			}
			if (
				yield* provider.pathExists(
					workspace.providerSandboxId,
					"/var/lib/zuse/workspace/failed",
					"zuse",
				)
			) {
				yield* store.saveWorkspace(
					cloudWorkspaceAfterSetupFailure(workspace, nowMs),
				);
				return;
			}
			if (
				!(yield* provider.pathExists(
					workspace.providerSandboxId,
					"/var/lib/zuse/workspace/ready",
					"zuse",
				))
			) {
				yield* store.saveWorkspace({
					...workspace,
					nextActionAtMs: nowMs + RETRY_MS,
					updatedAtMs: nowMs,
				});
				return;
			}
			if (workspace.environmentId === undefined) {
				yield* store.saveWorkspace({
					...workspace,
					statusCode: "enrollment-pending",
					nextActionAtMs: nowMs + RETRY_MS,
					updatedAtMs: nowMs,
				});
				return;
			}
			yield* provider.setNetwork(workspace.providerSandboxId, { kind: "open" });
			yield* store.saveWorkspace({
				...workspace,
				state: "ready",
				statusCode: "ready",
				enrollmentTokenHash: undefined,
				enrollmentExpiresAtMs: undefined,
				nextActionAtMs: workspace.lastActivityAtMs + IDLE_PAUSE_MS,
				runningSinceMs: nowMs,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			});
			return;
		}
		if (
			workspace.state === "ready" &&
			nowMs >= workspace.lastActivityAtMs + IDLE_PAUSE_MS
		)
			return yield* pauseWorkspace(workspace, provider, nowMs, false);
		if (workspace.state === "archived" && workspace.desiredState === "ready") {
			// Archiving deliberately removes every credential from the warm sandbox.
			// Do not pretend that a provider resume is a complete restore until the
			// credential reinjection and recovery import flow has completed.
			yield* store.saveWorkspace({
				...workspace,
				desiredState: "archived",
				statusCode: "recovery-restore-required",
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			});
			return;
		}
		if (
			workspace.state === "paused" &&
			workspace.desiredState === "ready" &&
			workspace.providerSandboxId !== undefined
		) {
			const currentCredentialEpoch = yield* store.credentialEpoch(
				workspace.accountId,
			);
			if (currentCredentialEpoch !== workspace.credentialEpoch) {
				yield* store.saveWorkspace({
					...workspace,
					statusCode: "credential-refresh-required",
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				});
				return;
			}
			yield* provider.resume(
				workspace.providerSandboxId,
				config.keepAliveTimeoutSeconds,
				"pause",
			);
			yield* recordLifecycle(workspace, "resume", nowMs);
			yield* store.saveWorkspace({
				...workspace,
				state: "ready",
				desiredState: "ready",
				statusCode: "ready",
				warmRetentionDeadlineMs: undefined,
				nextActionAtMs: nowMs + IDLE_PAUSE_MS,
				lastActivityAtMs: nowMs,
				runningSinceMs: nowMs,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			});
			return;
		}
		if (
			workspace.state === "archived" &&
			workspace.warmRetentionDeadlineMs !== undefined &&
			nowMs >= workspace.warmRetentionDeadlineMs &&
			workspace.providerSandboxId !== undefined
		) {
			// Cold export requires an object-store adapter. Until configured, retain the
			// warm sandbox instead of destroying the only copy of user work.
			yield* store.saveWorkspace({
				...workspace,
				statusCode: "recovery-export-required",
				nextActionAtMs: nowMs + 24 * 60 * 60 * 1_000,
				updatedAtMs: nowMs,
			});
		}
	},
);

export const reconcileCloudResources = Effect.fn("reconcileCloudResources")(
	function* () {
		const store = yield* CloudWorkspaceStore;
		const nowMs = yield* Clock.currentTimeMillis;
		const builds = yield* store.listDueBuilds(nowMs, 10);
		const workspaces = yield* store.listDueWorkspaces(nowMs, 25);
		yield* Effect.forEach(
			builds,
			(build) => reconcileCloudBuild(build.buildId),
			{
				concurrency: 2,
				discard: true,
			},
		);
		yield* Effect.forEach(
			workspaces,
			(workspace) => reconcileCloudWorkspace(workspace.workspaceId),
			{
				concurrency: 5,
				discard: true,
			},
		);
		return { builds: builds.length, workspaces: workspaces.length };
	},
);

export const reconcileCloudBuild = (buildId: string) =>
	Effect.gen(function* () {
		const store = yield* CloudWorkspaceStore;
		const nowMs = yield* Clock.currentTimeMillis;
		const build = yield* store.claimBuild(
			buildId,
			crypto.randomUUID(),
			nowMs,
			nowMs + RECONCILE_LEASE_MS,
		);
		if (build !== null) yield* reconcileBuildRecord(build);
	});
export const reconcileCloudWorkspace = (workspaceId: string) =>
	Effect.gen(function* () {
		const store = yield* CloudWorkspaceStore;
		const leaseOwner = crypto.randomUUID();
		for (let pass = 0; pass < 6; pass++) {
			const nowMs = yield* Clock.currentTimeMillis;
			const workspace = yield* store.claimWorkspace(
				workspaceId,
				leaseOwner,
				nowMs,
				nowMs + RECONCILE_LEASE_MS,
			);
			if (workspace === null) return;
			yield* reconcileWorkspaceRecord(workspace).pipe(
				Effect.catchTag("SandboxProviderError", (error) =>
					Effect.gen(function* () {
						const failureAtMs = yield* Clock.currentTimeMillis;
						const failure = cloudWorkspaceAfterProviderFailure(
							workspace,
							error.code,
							failureAtMs,
						);
						const unsafeStartupFailure =
							failure.state === "failed" &&
							(workspace.state === "queued" ||
								workspace.state === "provisioning");
						if (unsafeStartupFailure) {
							const provider = yield* (yield* SandboxProviders)
								.get(workspace.provider)
								.pipe(Effect.orDie);
							yield* discardUnsafeWorkspaceSandbox(provider, workspace);
						}
						yield* store.saveWorkspace(
							unsafeStartupFailure
								? cloudWorkspaceWithoutProviderSandbox(failure)
								: failure,
						);
					}),
				),
			);
			const current = yield* store.getWorkspace(workspaceId);
			if (current === null) return;
			const afterPassMs = yield* Clock.currentTimeMillis;
			const delayMs = cloudWorkspaceReconcileDelay(current, afterPassMs);
			if (delayMs === null) return;
			if (delayMs > 0) yield* Effect.sleep(delayMs);
		}
	});
