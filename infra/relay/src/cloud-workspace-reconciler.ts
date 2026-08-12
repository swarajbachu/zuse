import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import {
	type SandboxProviderAdapter,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { Clock, Effect } from "effect";
import { CloudCredentialVault } from "./cloud-credential-vault.ts";
import {
	type CloudProjectBuildRecord,
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
} from "./cloud-workspace-store.ts";
import { RelayConfiguration } from "./config.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { SandboxOfferConfiguration } from "./sandbox-provider-module.ts";

const RETRY_MS = 5_000;
const WORKSPACE_START_TIMEOUT_MS = 5 * 60 * 1_000;
const RECONCILE_LEASE_MS = 2 * 60 * 1_000;
const PROJECT_BUILD_TIMEOUT_MS = 15 * 60 * 1_000;
const WARM_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const WORKSPACE_RUNTIME_BOOT_TTL_MS = 30 * 60 * 1_000;
const WORKSPACE_RUNTIME_BOOT_TOKEN_FILE =
	"/run/zuse-secrets/workspace-runtime-boot-token";
export const WORKSPACE_RUNTIME_PROCESS_PATTERN =
	"[z]use serve|[/]opt/zuse/current/bin.mjs serve";
export const WORKSPACE_RUNTIME_RESUME_SCRIPT =
	'set -e; runtime=/opt/zuse/current/bin.mjs; fallback=/usr/local/bin/zuse; pkill -KILL -u zuse -f \'[z]use serve|[/]opt/zuse/current/bin.mjs serve\' 2>/dev/null || true; rm -f /var/lib/zuse/workspace/failed; if [ -f "$runtime" ]; then exec node "$runtime" serve; else exec "$fallback" serve; fi';
const shellSingleQuote = (value: string): string =>
	`'${value.replaceAll("'", `'"'"'`)}'`;
export const WORKSPACE_RUNTIME_RESUME_COMMAND = `nohup /bin/bash -lc ${shellSingleQuote(
	WORKSPACE_RUNTIME_RESUME_SCRIPT,
)} >/var/lib/zuse/workspace/runtime-launch.log 2>&1 </dev/null &`;

const providerLabel = (kind: "build" | "workspace", id: string): string =>
	`zuse-cloud-${kind}-${id.replace(/[^A-Za-z0-9-]/gu, "-")}`.slice(0, 63);

const workspaceStartupTimedOut = (
	workspace: CloudWorkspaceRecord,
	nowMs: number,
): boolean => {
	const timings = workspace.requestConfig.startupTimings as
		| Readonly<Record<string, unknown>>
		| undefined;
	const allocatedAt =
		typeof timings?.allocatedAt === "number"
			? timings.allocatedAt
			: workspace.createdAtMs;
	return (
		(workspace.state === "queued" ||
			workspace.state === "provisioning" ||
			workspace.state === "setup") &&
		nowMs - allocatedAt >= WORKSPACE_START_TIMEOUT_MS
	);
};

const issueWorkspaceRuntimeBoot = Effect.fn("issueWorkspaceRuntimeBoot")(
	function* (
		provider: SandboxProviderAdapter,
		providerSandboxId: string,
		nowMs: number,
	) {
		const token = yield* randomToken("workspace_enroll", 32);
		yield* provider.writeTextFile(
			providerSandboxId,
			WORKSPACE_RUNTIME_BOOT_TOKEN_FILE,
			token,
			"zuse",
		);
		yield* provider.startProcess(providerSandboxId, {
			command: "/usr/bin/chmod",
			args: ["0600", WORKSPACE_RUNTIME_BOOT_TOKEN_FILE],
			user: "zuse",
		});
		return {
			tokenHash: yield* sha256Hex(token),
			expiresAtMs: nowMs + WORKSPACE_RUNTIME_BOOT_TTL_MS,
		};
	},
);

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
	if (
		(build.state === "building" || build.state === "sanitizing") &&
		(build.providerSandboxId === undefined ||
			(yield* provider.inspect(build.providerSandboxId).pipe(Effect.orDie)) ===
				null)
	) {
		const previous = yield* store.getActiveBuild(
			build.projectId,
			build.provider,
		);
		yield* store.saveBuild({
			...build,
			providerSandboxId: undefined,
			state: "failed",
			lastErrorCode: "provider-sandbox-missing",
			nextActionAtMs: Number.MAX_SAFE_INTEGER,
			revision: build.revision + 1,
			updatedAtMs: nowMs,
		});
		yield* store.saveProject({
			...project,
			state: previous === null ? "failed" : "ready",
			lastErrorCode: "provider-sandbox-missing",
			updatedAtMs: nowMs,
		});
		return;
	}
	if (build.state === "queued") {
		const accountBuilds = yield* store.listAccountBuilds(
			build.accountId,
			build.provider,
		);
		const earlierPending = accountBuilds.some(
			(candidate) =>
				candidate.buildId !== build.buildId &&
				candidate.createdAtMs < build.createdAtMs &&
				(candidate.state === "queued" ||
					candidate.state === "building" ||
					candidate.state === "sanitizing"),
		);
		if (earlierPending) {
			yield* store.saveBuild({
				...build,
				nextActionAtMs: nowMs + RETRY_MS,
				updatedAtMs: nowMs,
			});
			return;
		}
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
		const relayConfig = yield* RelayConfiguration;
		const existing = yield* provider.recoverByLabel(label).pipe(Effect.orDie);
		const previousAccountBuild = yield* store.getActiveAccountBuild(
			build.accountId,
			build.provider,
		);
		const sandbox =
			existing ??
			(previousAccountBuild?.snapshotId === undefined
				? yield* provider
						.create({
							sandboxId: build.buildId,
							providerLabel: label,
							timeoutSeconds: config.createTimeoutSeconds,
							env: {},
							network: { kind: "open" },
							onTimeout: "terminate",
						})
						.pipe(Effect.orDie)
				: yield* provider
						.fork({
							sandboxId: build.buildId,
							providerLabel: label,
							snapshotId: previousAccountBuild.snapshotId,
							timeoutSeconds: config.createTimeoutSeconds,
							env: {},
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
					'set +e; /usr/local/bin/zuse-project-builder >/var/lib/zuse/project-build/build.log 2>&1; code=$?; printf \'%s\\n\' "$code" >/tmp/zuse-project-builder-exit-code; touch /tmp/zuse-project-builder-exited; exit "$code"',
				],
				env: {
					ZUSE_REPOSITORY_URL: project.repositoryUrl,
					ZUSE_PROJECT_CACHE_ID: project.projectId,
					ZUSE_DEFAULT_BRANCH: project.defaultBranch,
					ZUSE_TEMPLATE_VERSION: build.templateVersion,
					ZUSE_CONFIGURATION_DIGEST: build.configurationDigest,
					ZUSE_REPOSITORY_CACHE_MAX_BYTES: String(
						relayConfig.cloudRepositoryCacheMaxBytes,
					),
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
			const reportedFailurePhase = buildTimedOut
				? ""
				: yield* provider
						.readTextFile(
							build.providerSandboxId,
							"/var/lib/zuse/project-build/failure-phase",
							"zuse",
						)
						.pipe(
							Effect.map((phase) => phase.trim()),
							Effect.catchTag("SandboxProviderError", () => Effect.succeed("")),
						);
			const failureCode = buildTimedOut
				? "project-setup-timeout"
				: /^[a-z][a-z0-9-]{0,63}$/.test(reportedFailurePhase)
					? `project-${reportedFailurePhase}-failed`
					: "project-setup-failed";
			yield* provider.kill(build.providerSandboxId).pipe(Effect.ignore);
			const previous = yield* store.getActiveBuild(
				build.projectId,
				build.provider,
			);
			yield* store.saveBuild({
				...build,
				providerSandboxId: undefined,
				state: "failed",
				lastErrorCode: failureCode,
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: build.revision + 1,
				updatedAtMs: nowMs,
			});
			yield* store.saveProject({
				...project,
				state: previous === null ? "failed" : "ready",
				lastErrorCode: failureCode,
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
		const promoted = {
			...sanitizing,
			snapshotId,
			providerSandboxId: undefined,
			state: "ready",
			nextActionAtMs: Number.MAX_SAFE_INTEGER,
			revision: sanitizing.revision + 1,
			updatedAtMs: nowMs,
		} as const;
		yield* store.saveBuild(promoted);
		yield* store.saveProject({
			...project,
			state: "ready",
			lastErrorCode: undefined,
			updatedAtMs: nowMs,
		});
		const referencedBuildIds = new Set(
			(yield* store.listWorkspaces(build.accountId))
				.filter((workspace) => workspace.state !== "deleted")
				.map((workspace) => workspace.buildId),
		);
		const superseded = (yield* store.listAccountBuilds(
			build.accountId,
			build.provider,
		)).filter(
			(candidate) =>
				candidate.buildId !== promoted.buildId &&
				candidate.snapshotId !== undefined &&
				!referencedBuildIds.has(candidate.buildId),
		);
		for (const candidate of superseded) {
			if (candidate.snapshotId === undefined) continue;
			yield* provider.deleteSnapshot(candidate.snapshotId).pipe(Effect.ignore);
			yield* store.saveBuild({
				...candidate,
				snapshotId: undefined,
				revision: candidate.revision + 1,
			});
		}
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
			runtimeState: "offline",
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
	}).pipe(
		Effect.as(true),
		Effect.catchTag("SandboxProviderError", () => Effect.succeed(false)),
	);

const restartWorkspaceRuntime = Effect.fn("restartCloudWorkspaceRuntime")(
	function* (
		workspace: CloudWorkspaceRecord,
		providerSandboxId: string,
		provider: SandboxProviderAdapter,
		nowMs: number,
	) {
		const store = yield* CloudWorkspaceStore;
		const config = yield* SandboxOfferConfiguration;
		const relay = yield* RelayConfiguration;
		const project = yield* store.getProject(workspace.projectId);
		if (project === null) return;
		const relayHost = new URL(relay.relayIssuer).hostname;
		const runtimeManifestHost =
			config.runtimeManifestUrl === undefined
				? undefined
				: new URL(config.runtimeManifestUrl).hostname;

		yield* provider.resume(
			providerSandboxId,
			config.keepAliveTimeoutSeconds,
			"pause",
		);
		const [boot] = yield* Effect.all(
			[
				issueWorkspaceRuntimeBoot(provider, providerSandboxId, nowMs),
				provider.setNetwork(providerSandboxId, {
					kind: "restricted",
					allowOut: [
						relayHost,
						...(runtimeManifestHost === undefined
							? []
							: [
									runtimeManifestHost,
									"github.com",
									"release-assets.githubusercontent.com",
									"objects.githubusercontent.com",
								]),
					],
					denyOut: ["0.0.0.0/0", "::/0"],
				}),
				config.runtimeSigningPublicJwk === undefined
					? Effect.void
					: provider.writeTextFile(
							providerSandboxId,
							"/home/zuse/.zuse-runtime-signing-public.jwk",
							config.runtimeSigningPublicJwk,
							"zuse",
						),
			],
			{ concurrency: "unbounded" },
		);
		const timings =
			(workspace.requestConfig.startupTimings as
				| Readonly<Record<string, number>>
				| undefined) ?? {};
		// Keep the reconciliation lease until the token file and detached runtime
		// launch agree. Persisting first releases the lease, allowing a concurrent
		// resume to overwrite either side with a different one-time token.
		yield* provider.startProcess(providerSandboxId, {
			command: "/bin/bash",
			args: ["-lc", WORKSPACE_RUNTIME_RESUME_COMMAND],
			cwd: "/home/zuse/workspace",
			env: {
				...project.cloudEnvironment,
				ZUSE_CLOUD_WORKSPACE_ID: workspace.workspaceId,
				ZUSE_RUNTIME_BOOT_TOKEN_FILE: WORKSPACE_RUNTIME_BOOT_TOKEN_FILE,
				ZUSE_RELAY_URL: relay.relayIssuer,
				ZUSE_RUNTIME_KIND: "cloud-workspace",
				ZUSE_HOST: "127.0.0.1",
				ZUSE_PORT: "47837",
				ZUSE_AUTH_POLICY: "protected",
				ZUSE_ENABLE_PAIRING: "0",
				ZUSE_MACHINE_RUNTIME_ROLE: "cloud-environment",
				ZUSE_SERVER_READY_STDOUT: "1",
				ZUSE_USER_DATA: "/home/zuse/.zuse-data",
				...(config.runtimeManifestUrl === undefined
					? {}
					: {
							ZUSE_RUNTIME_MANIFEST_URL: config.runtimeManifestUrl,
							ZUSE_RUNTIME_PUBLIC_KEY_FILE:
								"/home/zuse/.zuse-runtime-signing-public.jwk",
							ZUSE_RUNTIME_WIRE_PROTOCOL: String(WIRE_PROTOCOL_VERSION),
						}),
			},
			user: "zuse",
		});
		yield* store.saveWorkspace({
			...workspace,
			runtimeBootTokenHash: boot.tokenHash,
			runtimeBootTokenExpiresAtMs: boot.expiresAtMs,
			runtimeCredentialHash: undefined,
			runtimeState: "offline",
			state: "provisioning",
			statusCode: "resume-runtime-restarting",
			warmRetentionDeadlineMs: undefined,
			requestConfig: {
				...workspace.requestConfig,
				startupTimings: { ...timings, allocatedAt: nowMs },
			},
			nextActionAtMs: nowMs + 30_000,
			lastActivityAtMs: nowMs,
			runningSinceMs: nowMs,
			revision: workspace.revision + 1,
			updatedAtMs: nowMs,
		});
	},
);

const reconcileWorkspaceRecord = Effect.fn("reconcileCloudWorkspace")(
	function* (workspace: CloudWorkspaceRecord) {
		const store = yield* CloudWorkspaceStore;
		const provider = yield* (yield* SandboxProviders)
			.get(workspace.provider)
			.pipe(Effect.orDie);
		const config = yield* SandboxOfferConfiguration;
		const relayConfig = yield* RelayConfiguration;
		const nowMs = yield* Clock.currentTimeMillis;

		if (workspace.desiredState === "deleted") {
			if (!(yield* discardUnsafeWorkspaceSandbox(provider, workspace))) {
				yield* store.saveWorkspace({
					...workspace,
					statusCode: "delete-retrying",
					nextActionAtMs: nowMs + RETRY_MS,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				});
				return;
			}
			if (workspace.runningSinceMs !== undefined)
				yield* recordLifecycle(workspace, "runtime-seconds", nowMs);
			yield* recordLifecycle(workspace, "delete", nowMs);
			yield* store.saveWorkspace({
				...workspace,
				state: "deleted",
				statusCode: "deleted",
				runtimeState: "offline",
				providerSandboxId: undefined,
				runtimeBootTokenHash: undefined,
				runtimeBootTokenExpiresAtMs: undefined,
				runtimeCredentialHash: undefined,
				recoveryBundleKey: undefined,
				runningSinceMs: undefined,
				deletedAtMs: nowMs,
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			});
			return;
		}

		if (workspace.desiredState === "paused" && workspace.state !== "paused")
			return yield* pauseWorkspace(workspace, provider, nowMs, false);

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
				const [reportedCode, archivePhase, diagnostic] = yield* Effect.all(
					[
						provider.readTextFile(
							workspace.providerSandboxId,
							"/var/lib/zuse/workspace-archive/error-code",
							"zuse",
						),
						provider.readTextFile(
							workspace.providerSandboxId,
							"/var/lib/zuse/workspace-archive/phase",
							"zuse",
						),
						provider.readTextFile(
							workspace.providerSandboxId,
							"/var/lib/zuse/workspace-archive/diagnostic.log",
							"zuse",
						),
					],
					{ concurrency: "unbounded" },
				).pipe(
					Effect.map((values) => values.map((value) => value.trim())),
					Effect.catchTag("SandboxProviderError", () =>
						Effect.succeed(["", "unknown", ""]),
					),
				);
				const failureCode = /^[a-z][a-z0-9-]{0,63}$/u.test(reportedCode ?? "")
					? (reportedCode as string)
					: "archive-failed";
				yield* store.saveWorkspace({
					...workspace,
					state: "failed",
					statusCode: failureCode,
					requestConfig: {
						...workspace.requestConfig,
						archivePhase,
						archiveErrorCode: failureCode,
						archiveDiagnostic: (diagnostic ?? "").slice(-8_192),
					},
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

		if (workspace.state === "queued") {
			const build = yield* store.getBuild(workspace.buildId);
			const project = yield* store.getProject(workspace.projectId);
			if (build === null || project === null) return;
			const label = providerLabel("workspace", workspace.workspaceId);
			const replacingFailedSandbox =
				workspace.statusCode === "resume-queued" &&
				workspace.providerSandboxId !== undefined;
			if (replacingFailedSandbox && workspace.providerSandboxId !== undefined)
				yield* provider.kill(workspace.providerSandboxId);
			const preparedSnapshotAvailable =
				build.snapshotId !== undefined &&
				build.templateVersion === provider.templateVersion;
			const sandbox =
				(replacingFailedSandbox
					? null
					: yield* provider.recoverByLabel(label)) ??
				(preparedSnapshotAvailable
					? yield* provider.fork({
							sandboxId: workspace.workspaceId,
							providerLabel: label,
							snapshotId: build.snapshotId as string,
							timeoutSeconds: config.keepAliveTimeoutSeconds,
							env: {},
							onTimeout: "pause",
						})
					: yield* provider.create({
							sandboxId: workspace.workspaceId,
							providerLabel: label,
							timeoutSeconds: config.keepAliveTimeoutSeconds,
							env: {},
							network: { kind: "quarantined" },
							onTimeout: "pause",
						}));
			const allocatedAtMs = yield* Clock.currentTimeMillis;
			const relay = yield* RelayConfiguration;
			const relayHost = new URL(relay.relayIssuer).hostname;
			const runtimeManifestHost =
				config.runtimeManifestUrl === undefined
					? undefined
					: new URL(config.runtimeManifestUrl).hostname;
			const [boot] = yield* Effect.all(
				[
					issueWorkspaceRuntimeBoot(
						provider,
						sandbox.providerSandboxId,
						allocatedAtMs,
					),
					provider.setNetwork(sandbox.providerSandboxId, {
						kind: "restricted",
						allowOut: [
							relayHost,
							...(runtimeManifestHost === undefined
								? []
								: [
										runtimeManifestHost,
										"github.com",
										"release-assets.githubusercontent.com",
										"objects.githubusercontent.com",
									]),
						],
						denyOut: ["0.0.0.0/0", "::/0"],
					}),
				],
				{ concurrency: "unbounded" },
			);
			if (
				config.runtimeManifestUrl !== undefined &&
				config.runtimeSigningPublicJwk !== undefined
			)
				yield* provider.writeTextFile(
					sandbox.providerSandboxId,
					"/home/zuse/.zuse-runtime-signing-public.jwk",
					config.runtimeSigningPublicJwk,
					"zuse",
				);
			const timings =
				(workspace.requestConfig.startupTimings as
					| Readonly<Record<string, number>>
					| undefined) ?? {};
			yield* store.saveWorkspace({
				...workspace,
				providerSandboxId: sandbox.providerSandboxId,
				runtimeBootTokenHash: boot.tokenHash,
				runtimeBootTokenExpiresAtMs: boot.expiresAtMs,
				runtimeState: "offline",
				state: "provisioning",
				statusCode: "runtime-starting",
				requestConfig: {
					...workspace.requestConfig,
					startupTimings: { ...timings, allocatedAt: allocatedAtMs },
				},
				nextActionAtMs: allocatedAtMs + 30_000,
				revision: workspace.revision + 1,
				updatedAtMs: allocatedAtMs,
			});
			yield* provider.startProcess(sandbox.providerSandboxId, {
				command: "/usr/local/bin/zuse-workspace-bootstrap",
				cwd: "/home/zuse",
				env: {
					...project.cloudEnvironment,
					ZUSE_CLOUD_WORKSPACE_ID: workspace.workspaceId,
					ZUSE_RUNTIME_BOOT_TOKEN_FILE: WORKSPACE_RUNTIME_BOOT_TOKEN_FILE,
					ZUSE_RELAY_URL: relay.relayIssuer,
					ZUSE_BASE_REF: workspace.baseRef,
					ZUSE_BRANCH: workspace.branch,
					ZUSE_PROJECT_CACHE_ID: project.projectId,
					ZUSE_REPOSITORY_URL: project.repositoryUrl,
					...(config.runtimeManifestUrl === undefined
						? {}
						: {
								ZUSE_RUNTIME_MANIFEST_URL: config.runtimeManifestUrl,
								ZUSE_RUNTIME_PUBLIC_KEY_FILE:
									"/home/zuse/.zuse-runtime-signing-public.jwk",
								ZUSE_RUNTIME_WIRE_PROTOCOL: String(WIRE_PROTOCOL_VERSION),
							}),
				},
				user: "zuse",
			});
			return;
		}

		if (
			workspace.state === "resuming" &&
			workspace.desiredState === "ready" &&
			workspace.providerSandboxId !== undefined
		) {
			return yield* restartWorkspaceRuntime(
				workspace,
				workspace.providerSandboxId,
				provider,
				nowMs,
			);
		}

		if (
			(workspace.state === "provisioning" || workspace.state === "setup") &&
			workspace.providerSandboxId !== undefined
		) {
			if (
				yield* provider.pathExists(
					workspace.providerSandboxId,
					"/var/lib/zuse/workspace/failed",
					"zuse",
				)
			) {
				const reportedFailurePhase = yield* provider
					.readTextFile(
						workspace.providerSandboxId,
						"/var/lib/zuse/workspace/failure-phase",
						"zuse",
					)
					.pipe(
						Effect.map((phase) => phase.trim()),
						Effect.catchTag("SandboxProviderError", () => Effect.succeed("")),
					);
				const failureCode = /^[a-z][a-z0-9-]{0,63}$/.test(reportedFailurePhase)
					? `${reportedFailurePhase}-failed`
					: "setup-failed";
				yield* store.saveWorkspace({
					...workspace,
					state: "failed",
					statusCode: failureCode,
					runtimeState: "offline",
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				});
				return;
			}
			if (workspaceStartupTimedOut(workspace, nowMs)) {
				yield* store.saveWorkspace({
					...workspace,
					state: "failed",
					statusCode: "runtime-connection-timeout",
					runtimeState: "offline",
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				});
				return;
			}
			// Successful startup is advanced only by authenticated runtime callbacks.
			yield* store.saveWorkspace({
				...workspace,
				nextActionAtMs: nowMs + 30_000,
				updatedAtMs: nowMs,
			});
			return;
		}

		if (
			workspace.state === "ready" &&
			nowMs >=
				workspace.lastActivityAtMs + relayConfig.cloudWorkspaceIdleTimeoutMs
		)
			return yield* pauseWorkspace(workspace, provider, nowMs, false);

		if (
			workspace.state === "paused" &&
			workspace.desiredState === "ready" &&
			workspace.providerSandboxId !== undefined
		) {
			const currentCredentialEpoch = yield* store.credentialEpoch(
				workspace.accountId,
			);
			if (currentCredentialEpoch !== workspace.credentialEpoch) {
				const relay = yield* RelayConfiguration;
				const project = yield* store.getProject(workspace.projectId);
				if (project === null) return;
				const invalidated = {
					...workspace,
					runtimeCredentialHash: undefined,
					runtimeState: "offline" as const,
					statusCode: "credential-refreshing",
					nextActionAtMs: nowMs + 30_000,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				};
				yield* store.saveWorkspace(invalidated);
				yield* provider.setNetwork(workspace.providerSandboxId, {
					kind: "restricted",
					allowOut: [
						new URL(relay.relayIssuer).hostname,
						...(config.runtimeManifestUrl === undefined
							? []
							: [
									new URL(config.runtimeManifestUrl).hostname,
									"github.com",
									"release-assets.githubusercontent.com",
									"objects.githubusercontent.com",
								]),
					],
					denyOut: ["0.0.0.0/0", "::/0"],
				});
				yield* provider.resume(
					workspace.providerSandboxId,
					config.keepAliveTimeoutSeconds,
					"pause",
				);
				const boot = yield* issueWorkspaceRuntimeBoot(
					provider,
					workspace.providerSandboxId,
					nowMs,
				);
				if (config.runtimeSigningPublicJwk !== undefined)
					yield* provider.writeTextFile(
						workspace.providerSandboxId,
						"/home/zuse/.zuse-runtime-signing-public.jwk",
						config.runtimeSigningPublicJwk,
						"zuse",
					);
				yield* store.saveWorkspace({
					...invalidated,
					runtimeBootTokenHash: boot.tokenHash,
					runtimeBootTokenExpiresAtMs: boot.expiresAtMs,
					credentialEpoch: currentCredentialEpoch,
					state: "provisioning",
					runningSinceMs: nowMs,
					revision: invalidated.revision + 1,
				});
				yield* provider.startProcess(workspace.providerSandboxId, {
					command: "/bin/bash",
					args: [
						"-lc",
						"pkill -KILL -u zuse -f '[z]use serve' 2>/dev/null || true; exec /usr/local/bin/zuse-workspace-bootstrap",
					],
					cwd: "/home/zuse",
					env: {
						...project.cloudEnvironment,
						ZUSE_CLOUD_WORKSPACE_ID: workspace.workspaceId,
						ZUSE_RUNTIME_BOOT_TOKEN_FILE: WORKSPACE_RUNTIME_BOOT_TOKEN_FILE,
						ZUSE_RELAY_URL: relay.relayIssuer,
						ZUSE_BASE_REF: workspace.baseRef,
						ZUSE_BRANCH: workspace.branch,
						ZUSE_PROJECT_CACHE_ID: project.projectId,
						ZUSE_REPOSITORY_URL: project.repositoryUrl,
						...(config.runtimeManifestUrl === undefined
							? {}
							: {
									ZUSE_RUNTIME_MANIFEST_URL: config.runtimeManifestUrl,
									ZUSE_RUNTIME_PUBLIC_KEY_FILE:
										"/home/zuse/.zuse-runtime-signing-public.jwk",
									ZUSE_RUNTIME_WIRE_PROTOCOL: String(WIRE_PROTOCOL_VERSION),
								}),
					},
					user: "zuse",
				});
				return;
			}
			yield* recordLifecycle(workspace, "resume", nowMs);
			return yield* restartWorkspaceRuntime(
				workspace,
				workspace.providerSandboxId,
				provider,
				nowMs,
			);
		}

		if (
			workspace.state === "archived" &&
			workspace.warmRetentionDeadlineMs !== undefined &&
			nowMs >= workspace.warmRetentionDeadlineMs
		)
			yield* store.saveWorkspace({
				...workspace,
				statusCode: "recovery-export-required",
				nextActionAtMs: nowMs + 24 * 60 * 60 * 1_000,
				updatedAtMs: nowMs,
			});
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
		const nowMs = yield* Clock.currentTimeMillis;
		const workspace = yield* store.claimWorkspace(
			workspaceId,
			crypto.randomUUID(),
			nowMs,
			nowMs + RECONCILE_LEASE_MS,
		);
		if (workspace === null) return;
		yield* reconcileWorkspaceRecord(workspace).pipe(
			Effect.catchTag("SandboxProviderError", (error) =>
				Effect.gen(function* () {
					const failedAtMs = yield* Clock.currentTimeMillis;
					if (error.code === "not-found") {
						yield* store.saveWorkspace({
							...workspace,
							providerSandboxId: undefined,
							runtimeBootTokenHash: undefined,
							runtimeBootTokenExpiresAtMs: undefined,
							runtimeCredentialHash: undefined,
							state: "queued",
							desiredState: "ready",
							statusCode: "provider-sandbox-replacing",
							runtimeState: "offline",
							nextActionAtMs: failedAtMs,
							revision: workspace.revision + 1,
							updatedAtMs: failedAtMs,
						});
						return;
					}
					yield* store.saveWorkspace({
						...workspace,
						state: "failed",
						statusCode: "provider-unavailable",
						runtimeState: "offline",
						nextActionAtMs: Number.MAX_SAFE_INTEGER,
						revision: workspace.revision + 1,
						updatedAtMs: failedAtMs,
					});
				}),
			),
		);
	});
