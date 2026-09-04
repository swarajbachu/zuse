import {
	CLOUD_COMMAND_LEASE_TTL_MS,
	WIRE_PROTOCOL_VERSION,
} from "@zuse/contracts";
import {
	type SandboxProviderAdapter,
	SandboxProviderError,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { Clock, Data, Duration, Effect } from "effect";
import PROJECT_BUILDER_SOURCE from "../../cloud-sandboxes/project-builder.sh";
import WORKSPACE_BOOTSTRAP_SOURCE from "../../cloud-sandboxes/workspace-bootstrap.sh";
import { snapshotCloudAuthAuthority } from "./cloud-auth-authority.ts";
import { allocatedComputeCostMicros } from "./cloud-billing.ts";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import { githubInstallationGrants } from "./cloud-github-app.ts";
import { deleteCloudTranscriptObjects } from "./cloud-transcript.ts";
import { cloudRepositoryWorkspacePath } from "./cloud-workspace-paths.ts";
import {
	type CloudProjectBuildRecord,
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
	deliveredMailboxLifecycle,
	destructiveMailboxLifecycle,
	mailboxLifecycleCovers,
	mailboxLifecycleTombstoneConfig,
	pendingMailboxLifecycle,
	withPendingMailboxLifecycle,
	workspaceDestructionFence,
	workspaceSupportsCloudCommandMailbox,
} from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { SandboxOfferConfiguration } from "./sandbox-provider-module.ts";

const RETRY_MS = 5_000;
const ACCOUNT_POOL_SIZE = 2;
// Provider allocation happens before `allocatedAt`. Once compute exists, the
// baked runtime must enroll promptly; leaving this at minutes turns a broken
// runtime into a permanently spinning composer until the recovery cron runs.
export const RUNTIME_CONNECTION_TIMEOUT_MS = 10_000;
const RECONCILE_LEASE_MS = 2 * 60 * 1_000;
const PROJECT_BUILD_TIMEOUT_MS = 15 * 60 * 1_000;
export const ARCHIVED_WORKSPACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const WORKSPACE_RUNTIME_BOOT_TTL_MS = 30 * 60 * 1_000;
const WARM_RUNTIME_RECONNECT_GRACE_MS = 500;
const MAILBOX_RUNTIME_RESPONSE_GRACE_MS = 2_500;
export const MAILBOX_RUNTIME_STALL_TIMEOUT_MS =
	CLOUD_COMMAND_LEASE_TTL_MS + 5_000;
const ARCHIVE_QUIESCE_GRACE_MS = 1_500;
const BILLING_RESERVATION_REFRESH_MS = 60_000;
const RUNTIME_SIGNING_PUBLIC_JWK_FILE =
	"/home/zuse/.zuse-runtime-signing-public.jwk";
const PROJECT_BUILD_DIAGNOSTIC_MAX_LENGTH = 2_048;
const PROJECT_BUILD_LOG_FILE = "/var/lib/zuse/project-build/build.log";
const PROJECT_BUILD_LOG_MAX_LENGTH = 256 * 1_024;
const PROJECT_BUILDER_FILE = "/var/lib/zuse/project-build/builder.sh";
const WORKSPACE_BOOTSTRAP_FILE =
	"/var/lib/zuse/project-build/workspace-bootstrap.sh";
const WORKSPACE_REPOSITORY_READY_MARKER =
	"/var/lib/zuse/workspace/repository-ready";
const WORKSPACE_CREDENTIALS_READY_MARKER =
	"/var/lib/zuse/workspace/credentials-ready";
const WORKSPACE_START_OBSERVATION_INTERVAL_MS = 250;

// A resume first gives the preserved runtime a warm-reconnect grace period,
// then starts the bounded runtime connection window. Keep the request observer
// alive through both phases and one final poll so it publishes the timeout
// instead of leaving the client on a stale "waking up" state.
export const WORKSPACE_START_OBSERVATION_MS =
	MAILBOX_RUNTIME_RESPONSE_GRACE_MS +
	RUNTIME_CONNECTION_TIMEOUT_MS +
	WORKSPACE_START_OBSERVATION_INTERVAL_MS;

const ensureWorkspaceRepositoryReadyMarker = Effect.fn(
	"ensureWorkspaceRepositoryReadyMarker",
)(function* (
	provider: SandboxProviderAdapter,
	providerSandboxId: string,
	workspaceRoot: string,
) {
	if (
		yield* provider.pathExists(
			providerSandboxId,
			WORKSPACE_REPOSITORY_READY_MARKER,
			"zuse",
		)
	)
		return;
	if (!(yield* provider.pathExists(providerSandboxId, workspaceRoot, "zuse")))
		return;
	yield* provider.writeTextFile(
		providerSandboxId,
		WORKSPACE_REPOSITORY_READY_MARKER,
		"ready\n",
		"zuse",
	);
});

const reserveProviderCost = Effect.fn("reserveProviderCost")(function* (input: {
	readonly accountId: string;
	readonly resourceKind: "workspace" | "build";
	readonly resourceId: string;
	readonly provider: string;
	readonly runningSinceMs: number;
	readonly nowMs: number;
	readonly vcpuCount: number;
	readonly memoryMib: number;
}) {
	const config = yield* ApiConfiguration;
	if (
		!config.cloudBillingEnforcementEnabled &&
		!config.cloudBillingExportEnabled
	)
		return false;
	const billingStore = yield* CloudBillingStore;
	const period = yield* billingStore.currentPeriod(
		input.accountId,
		input.nowMs,
	);
	if (period === null) {
		console.warn(
			"[cloud-billing] provider resource has no reservation period",
			{
				provider: input.provider,
				resourceKind: input.resourceKind,
				resourceId: input.resourceId,
				accountId: input.accountId,
			},
		);
		return config.cloudBillingEnforcementEnabled;
	}
	const startedAtMs = Math.max(
		input.runningSinceMs,
		period.periodStartMs,
		config.cloudBillingCutoverAtMs ?? input.runningSinceMs,
	);
	const endedAtMs = Math.min(
		Math.max(startedAtMs + 60_000, input.nowMs + 60_000),
		period.periodEndMs,
	);
	const prices = yield* billingStore.priceWindows(
		input.provider,
		startedAtMs,
		endedAtMs,
	);
	if (prices.length === 0) {
		console.warn("[cloud-billing] provider reservation price missing", {
			provider: input.provider,
			resourceKind: input.resourceKind,
			resourceId: input.resourceId,
		});
		return config.cloudBillingEnforcementEnabled;
	}
	const reservation = yield* billingStore.reserveCost({
		periodId: period.periodId,
		accountId: input.accountId,
		resourceKind: input.resourceKind,
		resourceId: input.resourceId,
		provider: input.provider,
		providerCostMicros: prices.reduce(
			(total, price) =>
				total +
				allocatedComputeCostMicros({
					durationMs: price.endedAtMs - price.startedAtMs,
					vcpuCount: input.vcpuCount,
					memoryMib: input.memoryMib,
					baseNanoUsdPerSecond: price.baseNanoUsdPerSecond,
					cpuNanoUsdPerSecond: price.cpuNanoUsdPerSecond,
					memoryNanoUsdPerGibSecond: price.memoryNanoUsdPerGibSecond,
				}),
			0,
		),
		startedAtMs,
		vcpuCount: input.vcpuCount,
		memoryMib: input.memoryMib,
		nowMs: input.nowMs,
		expiresAtMs: input.nowMs + 2 * 60_000,
	});
	return config.cloudBillingEnforcementEnabled && !reservation.accepted;
});

const sanitizeProjectBuildOutput = (value: string): string =>
	value
		.replaceAll(/\b(?:https?|ssh):\/\/\S+/giu, "[redacted-url]")
		.replaceAll(/\bBearer\s+\S+/giu, "Bearer [redacted]")
		.replaceAll(
			/\b(?:gh[oprsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
			"[redacted-token]",
		)
		.replaceAll(
			/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|token)\s*[=:]\s*)\S+/giu,
			"$1[redacted]",
		)
		.trim();

export const sanitizeProjectBuildDiagnostic = (value: string): string => {
	const sanitized = sanitizeProjectBuildOutput(value);
	return sanitized.slice(-PROJECT_BUILD_DIAGNOSTIC_MAX_LENGTH);
};

export const sanitizeProjectBuildLog = (value: string): string =>
	sanitizeProjectBuildOutput(value).slice(-PROJECT_BUILD_LOG_MAX_LENGTH);

export const snapshotSanitizationFailures = (input: {
	readonly forbiddenPaths: ReadonlyArray<string>;
	readonly forbiddenResults: ReadonlyArray<boolean>;
	readonly sourceCommit: string;
	readonly templateVersion: string;
	readonly expectedTemplateVersion: string;
	readonly configurationDigest: string;
	readonly expectedConfigurationDigest: string;
	readonly codexAuthDeliveryVersion?: number;
	readonly expectedCodexAuthDeliveryVersion?: number;
}): ReadonlyArray<string> => {
	const failures = input.forbiddenPaths.filter(
		(_path, index) => input.forbiddenResults[index] === true,
	);
	if (!/^[0-9a-f]{40,64}$/u.test(input.sourceCommit))
		failures.push("invalid source manifest digest");
	if (input.templateVersion !== input.expectedTemplateVersion)
		failures.push("runtime version mismatch");
	if (input.configurationDigest !== input.expectedConfigurationDigest)
		failures.push("configuration digest mismatch");
	if (input.codexAuthDeliveryVersion !== input.expectedCodexAuthDeliveryVersion)
		failures.push("Codex auth delivery capability mismatch");
	return failures;
};

const readProjectBuildLog = (
	provider: SandboxProviderAdapter,
	providerSandboxId: string,
): Effect.Effect<string> =>
	provider.readTextFile(providerSandboxId, PROJECT_BUILD_LOG_FILE, "zuse").pipe(
		Effect.map(sanitizeProjectBuildLog),
		Effect.catchTag("SandboxProviderError", () => Effect.succeed("")),
	);

export const reusableAccountBuildSnapshot = (
	build: CloudProjectBuildRecord | null,
	templateVersion: string,
): string | undefined =>
	build?.templateVersion === templateVersion ? build.snapshotId : undefined;

export const cloudWorkspaceStartupNeedsObservation = (
	workspace:
		| (Pick<CloudWorkspaceRecord, "state" | "runtimeState"> &
				Partial<Pick<CloudWorkspaceRecord, "requestConfig">>)
		| null,
): boolean =>
	workspace !== null &&
	((workspace.requestConfig?.cloudMailboxWakePending === true &&
		typeof workspace.requestConfig.cloudMailboxRuntimeSeenAt !== "number") ||
		(workspace.runtimeState === "offline" &&
			(workspace.state === "queued" ||
				workspace.state === "provisioning" ||
				workspace.state === "setup")) ||
		(workspace.state === "resuming" &&
			workspace.runtimeState === "connecting"));

const resetMailboxWakeObservation = (
	requestConfig: Readonly<Record<string, unknown>>,
	nowMs: number,
): Readonly<Record<string, unknown>> => {
	if (requestConfig.cloudMailboxWakePending !== true) return requestConfig;
	const {
		cloudMailboxRuntimeSeenAt: _cloudMailboxRuntimeSeenAt,
		cloudMailboxProgressAt: _cloudMailboxProgressAt,
		cloudMailboxProgressRevision: _cloudMailboxProgressRevision,
		cloudMailboxFenceRequired: _cloudMailboxFenceRequired,
		...pendingConfig
	} = requestConfig;
	return {
		...pendingConfig,
		cloudMailboxWakeRequestedAt: nowMs,
	};
};

class CloudWorkspaceLeaseLostError extends Data.TaggedError(
	"CloudWorkspaceLeaseLostError",
)<{ readonly workspaceId: string }> {}

type SaveClaimedWorkspace = (
	workspace: CloudWorkspaceRecord,
) => Effect.Effect<void, CloudWorkspaceLeaseLostError>;
const WORKSPACE_RUNTIME_PROCESS = {
	tag: "zuse-runtime",
	legacyCommandMarkers: [
		"zuse-workspace-bootstrap",
		"/opt/zuse/current/bin.mjs serve",
		"/usr/local/bin/zuse serve",
	],
} as const;
export const workspaceRuntimeProcessSelector = () => ({
	...WORKSPACE_RUNTIME_PROCESS,
	// E2B preserves processes across a memory pause but does not preserve their
	// envd process tags. Always scan the narrow legacy markers before replacement
	// so a live untagged runtime cannot retain the control port and make resume
	// fail with EADDRINUSE.
	legacyCleanup: "matching-command" as const,
});
export const WORKSPACE_RUNTIME_RESUME_SCRIPT = `set -e; runtime=/opt/zuse/current/bin.mjs; fallback=/usr/local/bin/zuse; log=/var/lib/zuse/workspace/runtime.log; rm -f /var/lib/zuse/workspace/failed /var/lib/zuse/workspace/credentials-ready /var/lib/zuse/workspace/credentials-ready-event; if [ -n "\${ZUSE_RUNTIME_MANIFEST_URL:-}" ] && [ -f "\${ZUSE_RUNTIME_PUBLIC_KEY_FILE:-}" ]; then ZUSE_RUNTIME_INSTALL_ONLY=1 ZUSE_RUNTIME_SKIP_TOOLCHAIN=1 node /usr/local/lib/zuse/runtime-updater.mjs >> "$log" 2>&1; fi; if [ -f "$runtime" ]; then exec node "$runtime" serve >> "$log" 2>&1; else exec "$fallback" serve --foreground >> "$log" 2>&1 </dev/null; fi`;
const providerLabel = (kind: "build" | "workspace", id: string): string =>
	`zuse-cloud-${kind}-${id.replace(/[^A-Za-z0-9-]/gu, "-")}`.slice(0, 63);

const nextRuntimeFence = (
	workspace: CloudWorkspaceRecord,
): { readonly runtimeGeneration: number; readonly gatewayEpoch: number } => ({
	runtimeGeneration:
		(typeof workspace.requestConfig.runtimeGeneration === "number"
			? workspace.requestConfig.runtimeGeneration
			: 0) + 1,
	gatewayEpoch:
		(typeof workspace.requestConfig.gatewayEpoch === "number"
			? workspace.requestConfig.gatewayEpoch
			: 0) + 1,
});

export const withoutRuntimeBootstrapReceipt = (
	config: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
	const {
		runtimeBootstrapReceipt: _receipt,
		startupFailureDiagnostic: _failure,
		...rest
	} = config;
	return rest;
};

const workspaceStartupDeadlineMs = (
	workspace: CloudWorkspaceRecord,
): number => {
	const timings = workspace.requestConfig.startupTimings as
		| Readonly<Record<string, unknown>>
		| undefined;
	const enrolledAt =
		workspace.state === "setup" && typeof timings?.enrolledAt === "number"
			? timings.enrolledAt
			: undefined;
	const allocatedAt =
		typeof timings?.allocatedAt === "number"
			? timings.allocatedAt
			: workspace.createdAtMs;
	return (enrolledAt ?? allocatedAt) + RUNTIME_CONNECTION_TIMEOUT_MS;
};

const workspaceStartupTimedOut = (
	workspace: CloudWorkspaceRecord,
	nowMs: number,
): boolean => {
	return (
		(workspace.state === "queued" ||
			workspace.state === "provisioning" ||
			workspace.state === "setup") &&
		nowMs >= workspaceStartupDeadlineMs(workspace)
	);
};

const readWorkspaceRuntimeDiagnostic = (
	provider: SandboxProviderAdapter,
	providerSandboxId: string,
) =>
	Effect.gen(function* () {
		const [runtimeLogRaw, credentialsReady] = yield* Effect.all([
			provider
				.readTextFile(
					providerSandboxId,
					"/var/lib/zuse/workspace/runtime.log",
					"zuse",
				)
				.pipe(
					Effect.catchTag("SandboxProviderError", () => Effect.succeed("")),
				),
			provider
				.pathExists(providerSandboxId, WORKSPACE_CREDENTIALS_READY_MARKER)
				.pipe(
					Effect.catchTag("SandboxProviderError", () => Effect.succeed(false)),
				),
		]);
		const runtimeStages = sanitizeProjectBuildOutput(runtimeLogRaw)
			.split("\n")
			.filter((line) => line.includes("[cloud-workspace-runtime]"))
			.slice(-8)
			.join("\n");
		return sanitizeProjectBuildDiagnostic(
			[
				sanitizeProjectBuildDiagnostic(runtimeLogRaw),
				runtimeStages,
				`[runtime-check] credentials-ready=${String(credentialsReady)}`,
			]
				.filter(Boolean)
				.join("\n"),
		);
	});

const issueWorkspaceRuntimeBoot = Effect.fn("issueWorkspaceRuntimeBoot")(
	function* (nowMs: number) {
		const token = yield* randomToken("workspace_enroll", 32);
		return {
			token,
			tokenHash: yield* sha256Hex(token),
			expiresAtMs: nowMs + WORKSPACE_RUNTIME_BOOT_TTL_MS,
		};
	},
);

const saveAccountProjectState = Effect.fn("saveAccountProjectState")(function* (
	accountId: string,
	state: "ready" | "failed",
	lastErrorCode: string,
	nowMs: number,
) {
	const store = yield* CloudWorkspaceStore;
	for (const project of yield* store.listProjects(accountId))
		yield* store.saveProject({
			...project,
			state,
			lastErrorCode,
			updatedAtMs: nowMs,
		});
});

const reconcileBuildRecord = Effect.fn("reconcileCloudAccountImageBuild")(
	function* (build: CloudProjectBuildRecord) {
		const store = yield* CloudWorkspaceStore;
		const project = yield* store.getProject(build.projectId);
		if (project === null) return;
		const provider = yield* (yield* SandboxProviders)
			.get(build.provider)
			.pipe(Effect.orDie);
		const config = yield* SandboxOfferConfiguration;
		const nowMs = yield* Clock.currentTimeMillis;
		const buildBillingHold = yield* reserveProviderCost({
			accountId: build.accountId,
			resourceKind: "build",
			resourceId: build.buildId,
			provider: build.provider,
			runningSinceMs: build.state === "queued" ? nowMs : build.updatedAtMs,
			nowMs,
			vcpuCount: config.vcpuCount,
			memoryMib: config.memoryMib,
		});
		if (buildBillingHold) {
			if (build.providerSandboxId !== undefined)
				yield* provider.kill(build.providerSandboxId).pipe(Effect.ignore);
			yield* store.saveBuild({
				...build,
				providerSandboxId: undefined,
				state: "failed",
				lastErrorCode: "billing-hold",
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: build.revision + 1,
				updatedAtMs: nowMs,
			});
			const previous = yield* store.getActiveAccountBuild(
				build.accountId,
				build.provider,
			);
			yield* saveAccountProjectState(
				build.accountId,
				previous === null ? "failed" : "ready",
				"billing-hold",
				nowMs,
			);
			return;
		}
		if (
			(build.state === "building" || build.state === "sanitizing") &&
			(build.providerSandboxId === undefined ||
				(yield* provider
					.inspect(build.providerSandboxId)
					.pipe(Effect.orDie)) === null)
		) {
			const previous = yield* store.getActiveAccountBuild(
				build.accountId,
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
			yield* saveAccountProjectState(
				build.accountId,
				previous === null ? "failed" : "ready",
				"provider-sandbox-missing",
				nowMs,
			);
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
			const label = providerLabel("build", build.buildId);
			const apiConfig = yield* ApiConfiguration;
			const existing = yield* provider.recoverByLabel(label).pipe(Effect.orDie);
			const previousAccountBuild = yield* store.getActiveAccountBuild(
				build.accountId,
				build.provider,
			);
			const cleanRebuild = build.idempotencyKey.startsWith(
				"account-image:rebuild:",
			);
			const authSnapshotId =
				cleanRebuild ||
				previousAccountBuild === null ||
				previousAccountBuild.templateVersion !== build.templateVersion
					? yield* snapshotCloudAuthAuthority(
							build.accountId,
							`account-auth-${build.buildId}`,
						).pipe(Effect.orElseSucceed(() => undefined))
					: undefined;
			const reusableSnapshotId =
				authSnapshotId ??
				(cleanRebuild
					? undefined
					: reusableAccountBuildSnapshot(
							previousAccountBuild,
							build.templateVersion,
						));
			const sandbox =
				existing ??
				(reusableSnapshotId === undefined
					? yield* provider
							.create({
								sandboxId: build.buildId,
								providerLabel: label,
								metadata: {
									"zuse-account-id": build.accountId,
									"zuse-resource-kind": "build",
									"zuse-project-id": build.projectId,
									"zuse-build-id": build.buildId,
								},
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
								metadata: {
									"zuse-account-id": build.accountId,
									"zuse-resource-kind": "build",
									"zuse-project-id": build.projectId,
									"zuse-build-id": build.buildId,
								},
								snapshotId: reusableSnapshotId,
								timeoutSeconds: config.createTimeoutSeconds,
								env: {},
								network: { kind: "open" },
								onTimeout: "terminate",
							})
							.pipe(Effect.orDie));
			if (authSnapshotId !== undefined)
				yield* provider.deleteSnapshot(authSnapshotId).pipe(Effect.ignore);
			yield* provider
				.setNetwork(sandbox.providerSandboxId, { kind: "open" })
				.pipe(Effect.orDie);
			yield* Effect.all(
				[
					provider.writeTextFile(
						sandbox.providerSandboxId,
						PROJECT_BUILDER_FILE,
						PROJECT_BUILDER_SOURCE,
						"zuse",
					),
					provider.writeTextFile(
						sandbox.providerSandboxId,
						WORKSPACE_BOOTSTRAP_FILE,
						WORKSPACE_BOOTSTRAP_SOURCE,
						"zuse",
					),
					config.runtimeSigningPublicJwk === undefined
						? Effect.void
						: provider.writeTextFile(
								sandbox.providerSandboxId,
								RUNTIME_SIGNING_PUBLIC_JWK_FILE,
								config.runtimeSigningPublicJwk,
								"zuse",
							),
				],
				{ concurrency: "unbounded", discard: true },
			).pipe(Effect.orDie);
			yield* provider
				.startProcess(sandbox.providerSandboxId, {
					command: "/usr/bin/chmod",
					args: ["0700", PROJECT_BUILDER_FILE, WORKSPACE_BOOTSTRAP_FILE],
					user: "zuse",
				})
				.pipe(Effect.orDie);
			const accountProjects = yield* store.listProjects(build.accountId);
			const githubGrants = yield* githubInstallationGrants(
				build.accountId,
			).pipe(Effect.orElseSucceed(() => []));
			const tokenFileByRepository = new Map<string, string>();
			yield* Effect.forEach(
				githubGrants,
				(grant) => {
					const tokenFile = `/run/zuse-secrets/github-installation-${grant.installationId}`;
					for (const repository of grant.repositories)
						tokenFileByRepository.set(
							repository.fullName.toLowerCase(),
							tokenFile,
						);
					return provider
						.writeTextFile(
							sandbox.providerSandboxId,
							tokenFile,
							grant.token,
							"zuse",
						)
						.pipe(
							Effect.flatMap(() =>
								provider.startProcess(sandbox.providerSandboxId, {
									command: "/usr/bin/chmod",
									args: ["0600", tokenFile],
									user: "zuse",
								}),
							),
						);
				},
				{ concurrency: 4, discard: true },
			).pipe(Effect.orDie);
			const repositoryManifest = accountProjects
				.map((candidate) => {
					const repositoryName = candidate.repositoryIdentity
						.replace(/^github\.com\//u, "")
						.toLowerCase();
					return `${candidate.projectId}\t${candidate.repositoryUrl}\t${candidate.defaultBranch}\t${candidate.visibility}\t${tokenFileByRepository.get(repositoryName) ?? ""}\t${cloudRepositoryWorkspacePath(candidate.repositoryIdentity)}`;
				})
				.join("\n");
			yield* provider
				.writeTextFile(
					sandbox.providerSandboxId,
					"/var/lib/zuse/project-build/repositories.tsv",
					`${repositoryManifest}\n`,
					"zuse",
				)
				.pipe(Effect.orDie);
			yield* provider
				.startProcess(sandbox.providerSandboxId, {
					command: "/bin/bash",
					args: [
						"-lc",
						`set -e; : >${PROJECT_BUILD_LOG_FILE}; if [ -n "\${ZUSE_RUNTIME_MANIFEST_URL:-}" ] && [ -f "\${ZUSE_RUNTIME_PUBLIC_KEY_FILE:-}" ]; then ZUSE_RUNTIME_INSTALL_ONLY=1 ZUSE_RUNTIME_SKIP_TOOLCHAIN=1 node /usr/local/lib/zuse/runtime-updater.mjs >>${PROJECT_BUILD_LOG_FILE} 2>&1 || { code=$?; printf 'updating-runtime\n' >/var/lib/zuse/project-build/failure-phase; touch /var/lib/zuse/project-build/failed /tmp/zuse-project-builder-exited; exit "$code"; }; fi; set +e; ${PROJECT_BUILDER_FILE} >>${PROJECT_BUILD_LOG_FILE} 2>&1; code=$?; touch /tmp/zuse-project-builder-exited; exit "$code"`,
					],
					env: {
						ZUSE_TEMPLATE_VERSION: build.templateVersion,
						ZUSE_CONFIGURATION_DIGEST: build.configurationDigest,
						...(build.settings?.codexAuthDeliveryVersion === 1
							? { ZUSE_CODEX_AUTH_DELIVERY_VERSION: "1" }
							: {}),
						ZUSE_REPOSITORY_CACHE_MAX_BYTES: String(
							apiConfig.cloudRepositoryCacheMaxBytes,
						),
						...(config.runtimeManifestUrl === undefined
							? {}
							: {
									ZUSE_RUNTIME_MANIFEST_URL: config.runtimeManifestUrl,
									ZUSE_RUNTIME_PUBLIC_KEY_FILE: RUNTIME_SIGNING_PUBLIC_JWK_FILE,
									ZUSE_RUNTIME_WIRE_PROTOCOL: String(WIRE_PROTOCOL_VERSION),
								}),
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
			const logText = yield* readProjectBuildLog(
				provider,
				build.providerSandboxId,
			);
			const buildTimedOut =
				nowMs - build.createdAtMs >= PROJECT_BUILD_TIMEOUT_MS;
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
								Effect.catchTag("SandboxProviderError", () =>
									Effect.succeed(""),
								),
							);
				const failureCode = buildTimedOut
					? "project-setup-timeout"
					: /^[a-z][a-z0-9-]{0,63}$/.test(reportedFailurePhase)
						? `project-${reportedFailurePhase}-failed`
						: "project-setup-failed";
				const diagnostic = buildTimedOut
					? "Project build timed out before completion."
					: sanitizeProjectBuildDiagnostic(logText) ||
						"Project builder exited without a diagnostic.";
				yield* Effect.sync(() =>
					console.warn("[cloud-workspace] project build failed", {
						buildId: build.buildId,
						failureCode,
						diagnostic,
					}),
				);
				yield* provider.kill(build.providerSandboxId).pipe(Effect.ignore);
				const previous = yield* store.getActiveAccountBuild(
					build.accountId,
					build.provider,
				);
				yield* store.saveBuild({
					...build,
					providerSandboxId: undefined,
					state: "failed",
					lastErrorCode: failureCode,
					logText:
						logText.length > 0
							? logText
							: `Build failed during ${reportedFailurePhase || "setup"}.`,
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
					revision: build.revision + 1,
					updatedAtMs: nowMs,
				});
				yield* saveAccountProjectState(
					build.accountId,
					previous === null ? "failed" : "ready",
					failureCode,
					nowMs,
				);
				return;
			}
			if (!ready) {
				yield* store.saveBuild({
					...build,
					logText,
					nextActionAtMs: nowMs + RETRY_MS,
					updatedAtMs: nowMs,
				});
				return;
			}
			const forbiddenPaths = [
				"/home/zuse/.config/gh",
				"/home/zuse/.zuse-data",
				"/home/zuse/.git-credentials",
				"/home/zuse/.netrc",
				...(build.settings?.codexAuthDeliveryVersion === 1
					? ["/home/zuse/.codex/auth.json"]
					: []),
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
			const manifest = yield* provider
				.readTextFile(
					build.providerSandboxId,
					"/var/lib/zuse/account-image/manifest.json",
					"zuse",
				)
				.pipe(
					Effect.map((value) => {
						try {
							return JSON.parse(value) as Record<string, unknown>;
						} catch {
							return {};
						}
					}),
					Effect.orElseSucceed(() => ({}) as Record<string, unknown>),
				);
			const sanitizationFailures = snapshotSanitizationFailures({
				forbiddenPaths,
				forbiddenResults,
				sourceCommit,
				templateVersion,
				expectedTemplateVersion: build.templateVersion,
				configurationDigest,
				expectedConfigurationDigest: build.configurationDigest,
				codexAuthDeliveryVersion:
					typeof manifest.codexAuthDeliveryVersion === "number"
						? manifest.codexAuthDeliveryVersion
						: undefined,
				expectedCodexAuthDeliveryVersion:
					build.settings?.codexAuthDeliveryVersion === 1 ? 1 : undefined,
			});
			if (sanitizationFailures.length > 0) {
				const sanitizationDiagnostic = `Snapshot validation failed: ${sanitizationFailures.join(", ")}.`;
				yield* Effect.sync(() =>
					console.warn("[cloud-workspace] snapshot sanitization failed", {
						buildId: build.buildId,
						failures: sanitizationFailures,
					}),
				);
				yield* provider.kill(build.providerSandboxId).pipe(Effect.ignore);
				const previous = yield* store.getActiveAccountBuild(
					build.accountId,
					build.provider,
				);
				yield* store.saveBuild({
					...build,
					providerSandboxId: undefined,
					state: "failed",
					lastErrorCode: "snapshot-sanitization-failed",
					logText: [logText, sanitizationDiagnostic]
						.filter((line) => line.length > 0)
						.join("\n"),
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
					revision: build.revision + 1,
					updatedAtMs: nowMs,
				});
				yield* saveAccountProjectState(
					build.accountId,
					previous === null ? "failed" : "ready",
					"snapshot-sanitization-failed",
					nowMs,
				);
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
				logText,
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: sanitizing.revision + 1,
				updatedAtMs: nowMs,
			} as const;
			yield* store.saveBuild(promoted);
			for (const accountProject of yield* store.listProjects(build.accountId))
				yield* store.saveProject({
					...accountProject,
					state: "ready",
					lastErrorCode: undefined,
					updatedAtMs: nowMs,
				});
			const superseded = (yield* store.listAccountBuilds(
				build.accountId,
				build.provider,
			)).filter(
				(candidate) =>
					candidate.buildId !== promoted.buildId &&
					candidate.snapshotId !== undefined,
			);
			for (const candidate of superseded) {
				if (candidate.snapshotId === undefined) continue;
				yield* provider
					.deleteSnapshot(candidate.snapshotId)
					.pipe(Effect.ignore);
				yield* store.saveBuild({
					...candidate,
					snapshotId: undefined,
					revision: candidate.revision + 1,
				});
			}
			yield* reconcileCloudPool(build.accountId).pipe(Effect.ignore);
		}
	},
);

/** Keep two unassigned forks of the active account image off the launch path. */
export const reconcileCloudPool = Effect.fn("reconcileCloudPool")(function* (
	accountId: string,
) {
	const store = yield* CloudWorkspaceStore;
	const config = yield* SandboxOfferConfiguration;
	const providers = yield* SandboxProviders;
	const provider = yield* providers.get("e2b").pipe(Effect.orDie);
	const image = yield* store.getActiveAccountBuild(
		accountId,
		provider.providerId,
	);
	if (image?.snapshotId === undefined) return;
	const records = yield* store.listPool(accountId, provider.providerId);
	for (const record of records) {
		if (
			record.state === "available" &&
			record.imageGeneration !== image.buildId
		) {
			yield* provider.kill(record.providerSandboxId).pipe(Effect.ignore);
			yield* store.removePool(record.poolId);
		}
	}
	const current = (yield* store.listPool(
		accountId,
		provider.providerId,
	)).filter(
		(record) =>
			record.imageGeneration === image.buildId && record.state === "available",
	);
	const live = [] as Array<(typeof current)[number]>;
	for (const record of current) {
		const sandbox = yield* provider
			.inspect(record.providerSandboxId)
			.pipe(
				Effect.catchTag("SandboxProviderError", () => Effect.succeed(null)),
			);
		if (sandbox?.state === "running") {
			live.push(record);
			continue;
		}
		if (sandbox !== null)
			yield* provider.kill(record.providerSandboxId).pipe(Effect.ignore);
		yield* store.removePool(record.poolId);
	}
	const missing = Math.max(0, ACCOUNT_POOL_SIZE - live.length);
	const nowMs = yield* Clock.currentTimeMillis;
	yield* Effect.forEach(
		Array.from({ length: missing }),
		() =>
			Effect.gen(function* () {
				const poolId = yield* randomToken("pool", 12);
				const created = yield* provider.fork({
					sandboxId: poolId,
					providerLabel: providerLabel("workspace", poolId),
					metadata: {
						"zuse-account-id": accountId,
						"zuse-resource-kind": "workspace-pool",
						"zuse-image-generation": image.buildId,
					},
					snapshotId: image.snapshotId as string,
					timeoutSeconds: config.keepAliveTimeoutSeconds,
					env: {},
					// Workspace pools are user execution environments, not an identity
					// re-key boundary. They need normal outbound internet from the moment
					// they start so resumed agents cannot inherit a provider-level deny rule.
					network: { kind: "open" },
					onTimeout: "pause",
				});
				yield* store.savePool({
					poolId,
					accountId,
					provider: provider.providerId,
					imageGeneration: image.buildId,
					providerSandboxId: created.providerSandboxId,
					state: "available",
					createdAtMs: nowMs,
					updatedAtMs: nowMs,
				});
			}),
		{ concurrency: "unbounded", discard: true },
	);
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
	saveWorkspace: SaveClaimedWorkspace,
) =>
	Effect.gen(function* () {
		if (workspace.providerSandboxId !== undefined)
			yield* provider.pause(workspace.providerSandboxId);
		yield* recordLifecycle(workspace, "runtime-seconds", nowMs);
		yield* recordLifecycle(workspace, archived ? "archive" : "pause", nowMs);
		yield* saveWorkspace({
			...workspace,
			state: archived ? "archived" : "paused",
			desiredState: archived ? "archived" : "paused",
			runtimeState: "offline",
			statusCode: archived ? "archived" : "paused",
			requestConfig: workspace.requestConfig,
			nextActionAtMs: archived
				? workspace.archiveDeleteAtMs !== undefined
					? workspace.archiveDeleteAtMs
					: nowMs + ARCHIVED_WORKSPACE_RETENTION_MS
				: Number.MAX_SAFE_INTEGER,
			runningSinceMs: undefined,
			revision: workspace.revision + 1,
			updatedAtMs: nowMs,
		});
	});

const wakePreservedWorkspaceRuntime = (
	workspace: CloudWorkspaceRecord,
	providerSandboxId: string,
	provider: SandboxProviderAdapter,
	nowMs: number,
	keepAliveTimeoutSeconds: number,
	saveWorkspace: SaveClaimedWorkspace,
) =>
	Effect.gen(function* () {
		yield* recordLifecycle(workspace, "resume", nowMs);
		// Provider pause preserves memory and processes. Wake the sandbox first
		// and give its existing runtime a brief window to reconnect. If it does
		// not reconnect, the resuming branch performs a fenced hard restart.
		yield* provider.resume(providerSandboxId, keepAliveTimeoutSeconds, "pause");
		yield* saveWorkspace({
			...workspace,
			runtimeState: "connecting",
			state: "resuming",
			statusCode: "resume-runtime-waking",
			requestConfig: resetMailboxWakeObservation(
				workspace.requestConfig,
				nowMs,
			),
			nextActionAtMs: nowMs + WARM_RUNTIME_RECONNECT_GRACE_MS,
			lastActivityAtMs: nowMs,
			runningSinceMs: workspace.runningSinceMs ?? nowMs,
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
		saveWorkspace: SaveClaimedWorkspace,
		providerAlreadyRunning = false,
	) {
		const store = yield* CloudWorkspaceStore;
		const config = yield* SandboxOfferConfiguration;
		const api = yield* ApiConfiguration;
		const project = yield* store.getProject(workspace.projectId);
		if (project === null) return;
		const workspaceRoot = cloudRepositoryWorkspacePath(
			project.repositoryIdentity,
		);

		if (!providerAlreadyRunning)
			yield* provider.resume(
				providerSandboxId,
				config.keepAliveTimeoutSeconds,
				"pause",
			);
		const boot = yield* issueWorkspaceRuntimeBoot(nowMs);
		yield* Effect.all(
			[
				config.runtimeSigningPublicJwk === undefined
					? Effect.void
					: provider.writeTextFile(
							providerSandboxId,
							RUNTIME_SIGNING_PUBLIC_JWK_FILE,
							config.runtimeSigningPublicJwk,
							"zuse",
						),
				ensureWorkspaceRepositoryReadyMarker(
					provider,
					providerSandboxId,
					workspaceRoot,
				),
			],
			{ concurrency: "unbounded", discard: true },
		);
		const timings =
			(workspace.requestConfig.startupTimings as
				| Readonly<Record<string, number>>
				| undefined) ?? {};
		const runtimeFence = nextRuntimeFence(workspace);
		// Authorize the exact token written above before the detached runtime can
		// read it. Repeated resume requests are idempotent, so releasing the lease
		// here cannot replace this token while startup is in flight.
		yield* saveWorkspace({
			...workspace,
			runtimeBootTokenHash: boot.tokenHash,
			runtimeBootTokenExpiresAtMs: boot.expiresAtMs,
			runtimeCredentialHash: undefined,
			runtimeState: "offline",
			state: "provisioning",
			statusCode: "resume-runtime-restarting",
			requestConfig: {
				...resetMailboxWakeObservation(
					withoutRuntimeBootstrapReceipt(workspace.requestConfig),
					nowMs,
				),
				...runtimeFence,
				runtimeSessionRecoveryPending: true,
				startupTimings: { ...timings, allocatedAt: nowMs },
			},
			nextActionAtMs: nowMs + RUNTIME_CONNECTION_TIMEOUT_MS,
			lastActivityAtMs: nowMs,
			runningSinceMs: nowMs,
			revision: workspace.revision + 1,
			updatedAtMs: nowMs,
		});
		// Network policy is part of runtime readiness, not a parallel best-effort
		// side effect. Open egress before the agent process can make its first
		// gateway or model-api request.
		yield* provider.setNetwork(providerSandboxId, { kind: "open" });
		yield* provider.replaceProcess(
			providerSandboxId,
			workspaceRuntimeProcessSelector(),
			{
				command: "/bin/bash",
				args: ["-lc", WORKSPACE_RUNTIME_RESUME_SCRIPT],
				cwd: "/home/zuse",
				env: {
					...project.cloudEnvironment,
					ZUSE_CLOUD_WORKSPACE_ID: workspace.workspaceId,
					ZUSE_RUNTIME_BOOT_TOKEN: boot.token,
					ZUSE_API_URL: api.apiIssuer,
					ZUSE_CLOUD_WORKSPACE_ROOT: workspaceRoot,
					ZUSE_RUNTIME_KIND: "cloud-workspace",
					ZUSE_HOST: "127.0.0.1",
					ZUSE_PORT: "47837",
					ZUSE_AUTH_POLICY: "protected",
					ZUSE_ENABLE_PAIRING: "0",
					ZUSE_MACHINE_RUNTIME_ROLE: "cloud-environment",
					ZUSE_SERVER_READY_STDOUT: "1",
					ZUSE_USER_DATA: "/home/zuse/.zuse-data",
					ZUSE_RUNTIME_GENERATION: String(runtimeFence.runtimeGeneration),
					ZUSE_GATEWAY_EPOCH: String(runtimeFence.gatewayEpoch),
					...(config.runtimeManifestUrl === undefined
						? {}
						: {
								ZUSE_RUNTIME_MANIFEST_URL: config.runtimeManifestUrl,
								ZUSE_RUNTIME_PUBLIC_KEY_FILE: RUNTIME_SIGNING_PUBLIC_JWK_FILE,
								ZUSE_RUNTIME_WIRE_PROTOCOL: String(WIRE_PROTOCOL_VERSION),
							}),
				},
				user: "zuse",
			},
		);
	},
);

const reconcileWorkspaceRecord = Effect.fn("reconcileCloudWorkspace")(
	function* (
		workspace: CloudWorkspaceRecord,
		saveWorkspace: SaveClaimedWorkspace,
	) {
		const store = yield* CloudWorkspaceStore;
		const provider = yield* (yield* SandboxProviders)
			.get(workspace.provider)
			.pipe(Effect.orDie);
		const config = yield* SandboxOfferConfiguration;
		const apiConfig = yield* ApiConfiguration;
		const nowMs = yield* Clock.currentTimeMillis;
		const destructiveLifecycle = destructiveMailboxLifecycle(workspace);
		if (destructiveLifecycle !== null) {
			const destructionFence = workspaceDestructionFence(workspace);
			let lifecyclePrepared = workspace;
			// Delete is irreversible. Repair legacy/stale rows from the durable fence
			// before any provider work can accidentally revive their runtime.
			if (
				destructiveLifecycle === "delete" &&
				workspace.desiredState !== "deleted"
			)
				lifecyclePrepared = {
					...lifecyclePrepared,
					desiredState: "deleted",
					statusCode: "delete-queued",
					nextActionAtMs: nowMs,
				};
			if (
				!mailboxLifecycleCovers(
					pendingMailboxLifecycle(workspace),
					destructiveLifecycle,
					destructionFence,
				) &&
				!mailboxLifecycleCovers(
					deliveredMailboxLifecycle(workspace),
					destructiveLifecycle,
					destructionFence,
				)
			) {
				const nextDestructionFence =
					destructionFence < Number.MAX_SAFE_INTEGER
						? destructionFence + 1
						: destructionFence;
				lifecyclePrepared = {
					...lifecyclePrepared,
					requestConfig: withPendingMailboxLifecycle(
						lifecyclePrepared.requestConfig,
						destructiveLifecycle,
						nextDestructionFence,
					),
					nextActionAtMs: nowMs,
				};
			}
			if (lifecyclePrepared !== workspace) {
				lifecyclePrepared = {
					...lifecyclePrepared,
					revision: workspace.revision + 1,
					updatedAtMs: Math.max(nowMs, workspace.updatedAtMs + 1),
				};
				yield* saveWorkspace(lifecyclePrepared);
				workspace = lifecyclePrepared;
			}
		}
		const archiveDeleteAtMs = workspace.archiveDeleteAtMs;
		const workspaceBillingHold = yield* reserveProviderCost({
			accountId: workspace.accountId,
			resourceKind: "workspace",
			resourceId: workspace.workspaceId,
			provider: workspace.provider,
			runningSinceMs: workspace.runningSinceMs ?? nowMs,
			nowMs,
			vcpuCount: config.vcpuCount,
			memoryMib: config.memoryMib,
		});
		const mailboxWakePending =
			workspace.requestConfig.cloudMailboxWakePending === true;
		if (workspaceBillingHold && mailboxWakePending) {
			if (
				workspace.providerSandboxId !== undefined &&
				workspace.runningSinceMs !== undefined
			)
				yield* provider.pause(workspace.providerSandboxId).pipe(Effect.ignore);
			yield* saveWorkspace({
				...workspace,
				state:
					workspace.providerSandboxId === undefined
						? workspace.state
						: "paused",
				desiredState: "ready",
				runtimeState: "offline",
				statusCode: "billing-hold",
				runningSinceMs: undefined,
				nextActionAtMs: nowMs + RETRY_MS,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			});
			return;
		}
		if (
			workspaceBillingHold &&
			workspace.providerSandboxId !== undefined &&
			workspace.runningSinceMs !== undefined
		) {
			yield* provider.pause(workspace.providerSandboxId).pipe(Effect.ignore);
			yield* saveWorkspace({
				...workspace,
				state: "paused",
				desiredState: "paused",
				runtimeState: "offline",
				statusCode: "billing-hold",
				runningSinceMs: undefined,
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			});
			return;
		}

		if (
			workspace.state === "archived" &&
			archiveDeleteAtMs !== undefined &&
			nowMs >= archiveDeleteAtMs &&
			workspace.desiredState !== "deleted"
		) {
			const destructionFence = workspaceDestructionFence(workspace) + 1;
			yield* saveWorkspace({
				...workspace,
				desiredState: "deleted",
				statusCode: "archive-retention-expired",
				requestConfig: withPendingMailboxLifecycle(
					workspace.requestConfig,
					"delete",
					destructionFence,
				),
				nextActionAtMs: nowMs,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			});
			return;
		}

		if (workspace.desiredState === "deleted") {
			if (!(yield* discardUnsafeWorkspaceSandbox(provider, workspace))) {
				yield* saveWorkspace({
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
			yield* deleteCloudTranscriptObjects(workspace.workspaceId);
			yield* store.deleteTranscriptCheckpoints(workspace.workspaceId);
			yield* store.deleteLaunchIntent(workspace.workspaceId);
			yield* recordLifecycle(workspace, "delete", nowMs);
			yield* saveWorkspace({
				...workspace,
				state: "deleted",
				statusCode: "deleted",
				runtimeState: "offline",
				providerSandboxId: undefined,
				runtimeBootTokenHash: undefined,
				runtimeBootTokenExpiresAtMs: undefined,
				runtimeCredentialHash: undefined,
				wrappedTranscriptKey: undefined,
				requestConfig: mailboxLifecycleTombstoneConfig(workspace),
				deletionTombstoneExpiresAtMs: nowMs + ARCHIVED_WORKSPACE_RETENTION_MS,
				runningSinceMs: undefined,
				deletedAtMs: nowMs,
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			});
			return;
		}

		if (workspace.desiredState === "paused" && workspace.state !== "paused")
			return yield* pauseWorkspace(
				workspace,
				provider,
				nowMs,
				false,
				saveWorkspace,
			);

		if (
			workspace.desiredState === "archived" &&
			workspace.state !== "archived"
		) {
			const archiveRequestedAt =
				workspace.archiveRequestedAtMs ?? workspace.updatedAtMs;
			const quiesceAt = archiveRequestedAt + ARCHIVE_QUIESCE_GRACE_MS;
			if (nowMs < quiesceAt) {
				yield* Effect.sleep(Duration.millis(quiesceAt - nowMs));
			}
			return yield* pauseWorkspace(
				workspace,
				provider,
				nowMs,
				true,
				saveWorkspace,
			);
		}

		if (
			mailboxWakePending &&
			workspace.state === "ready" &&
			workspace.runtimeState === "online" &&
			workspace.desiredState === "ready" &&
			workspace.providerSandboxId !== undefined
		) {
			const sandbox = yield* provider.inspect(workspace.providerSandboxId);
			if (sandbox === null)
				return yield* Effect.fail(
					new SandboxProviderError({ code: "not-found" }),
				);
			if (workspace.requestConfig.cloudMailboxFenceRequired === true)
				return yield* restartWorkspaceRuntime(
					workspace,
					workspace.providerSandboxId,
					provider,
					nowMs,
					saveWorkspace,
					sandbox.state === "running",
				);
			if (sandbox.state === "paused")
				return yield* wakePreservedWorkspaceRuntime(
					workspace,
					workspace.providerSandboxId,
					provider,
					nowMs,
					config.keepAliveTimeoutSeconds,
					saveWorkspace,
				);

			const requestedAt =
				typeof workspace.requestConfig.cloudMailboxWakeRequestedAt === "number"
					? Math.min(nowMs, workspace.requestConfig.cloudMailboxWakeRequestedAt)
					: workspace.updatedAtMs;
			const runtimeSeenAt =
				typeof workspace.requestConfig.cloudMailboxRuntimeSeenAt === "number"
					? Math.min(nowMs, workspace.requestConfig.cloudMailboxRuntimeSeenAt)
					: undefined;
			const progressAt =
				typeof workspace.requestConfig.cloudMailboxProgressAt === "number"
					? Math.min(nowMs, workspace.requestConfig.cloudMailboxProgressAt)
					: undefined;
			const recoveryAt =
				(progressAt ?? runtimeSeenAt ?? requestedAt) +
				(runtimeSeenAt === undefined
					? MAILBOX_RUNTIME_RESPONSE_GRACE_MS
					: MAILBOX_RUNTIME_STALL_TIMEOUT_MS);
			if (nowMs < recoveryAt) {
				yield* provider
					.extendTimeout(
						workspace.providerSandboxId,
						config.keepAliveTimeoutSeconds,
					)
					.pipe(Effect.ignore);
				yield* saveWorkspace({
					...workspace,
					nextActionAtMs: recoveryAt,
					updatedAtMs: nowMs,
				});
				return;
			}
			// An authenticated lease poll records runtime liveness but the marker stays
			// pending until the durable mailbox is empty. An unseen consumer gets the
			// short startup grace; a consumer that was seen gets a full lease window to
			// finish its in-flight apply before a fenced replacement is permitted.
			return yield* restartWorkspaceRuntime(
				workspace,
				workspace.providerSandboxId,
				provider,
				nowMs,
				saveWorkspace,
				true,
			);
		}

		if (workspace.state === "queued") {
			const build = yield* store.getBuild(workspace.buildId);
			const project = yield* store.getProject(workspace.projectId);
			if (build === null || project === null) return;
			const label = providerLabel("workspace", workspace.workspaceId);
			const workspaceRoot = cloudRepositoryWorkspacePath(
				project.repositoryIdentity,
			);
			const replacingFailedSandbox =
				(workspace.statusCode === "resume-queued" ||
					workspace.statusCode === "resume-runtime-recovery-queued") &&
				workspace.providerSandboxId !== undefined;
			if (replacingFailedSandbox && workspace.providerSandboxId !== undefined)
				yield* provider.kill(workspace.providerSandboxId);
			const replacementPool = replacingFailedSandbox
				? yield* store.claimPool(
						workspace.accountId,
						workspace.provider,
						workspace.buildId,
						workspace.workspaceId,
						nowMs,
					)
				: null;
			const assignedSandboxId =
				replacementPool?.providerSandboxId ??
				(replacingFailedSandbox ? undefined : workspace.providerSandboxId);
			const pooled =
				assignedSandboxId !== undefined
					? yield* provider
							.inspect(assignedSandboxId)
							.pipe(
								Effect.catchTag("SandboxProviderError", () =>
									Effect.succeed(null),
								),
							)
					: null;
			// A paused E2B sandbox is not warm: reconnecting its allocation can be
			// substantially slower than forking the account image. Never put that
			// hidden resume on the normal creation path.
			const warmSandbox = pooled?.state === "running" ? pooled : null;
			if (pooled?.state === "paused")
				yield* provider.kill(pooled.providerSandboxId).pipe(Effect.ignore);
			const preparedSnapshotAvailable =
				build.snapshotId !== undefined &&
				build.templateVersion === provider.templateVersion;
			const recovered =
				warmSandbox === null && !replacingFailedSandbox
					? yield* provider.recoverByLabel(label)
					: null;
			const sandbox =
				warmSandbox ??
				recovered ??
				(preparedSnapshotAvailable
					? yield* provider.fork({
							sandboxId: workspace.workspaceId,
							providerLabel: label,
							metadata: {
								"zuse-account-id": workspace.accountId,
								"zuse-resource-kind": "workspace",
								"zuse-project-id": workspace.projectId,
								"zuse-build-id": workspace.buildId,
								"zuse-workspace-id": workspace.workspaceId,
							},
							snapshotId: build.snapshotId as string,
							timeoutSeconds: config.keepAliveTimeoutSeconds,
							env: {},
							network: { kind: "open" },
							onTimeout: "pause",
						})
					: yield* provider.create({
							sandboxId: workspace.workspaceId,
							providerLabel: label,
							metadata: {
								"zuse-account-id": workspace.accountId,
								"zuse-resource-kind": "workspace",
								"zuse-project-id": workspace.projectId,
								"zuse-build-id": workspace.buildId,
								"zuse-workspace-id": workspace.workspaceId,
							},
							timeoutSeconds: config.keepAliveTimeoutSeconds,
							env: {},
							network: { kind: "open" },
							onTimeout: "pause",
						}));
			const allocatedAtMs = yield* Clock.currentTimeMillis;
			const boot = yield* issueWorkspaceRuntimeBoot(allocatedAtMs);
			const api = yield* ApiConfiguration;
			const timings =
				(workspace.requestConfig.startupTimings as
					| Readonly<Record<string, number>>
					| undefined) ?? {};
			const runtimeFence = nextRuntimeFence(workspace);
			yield* saveWorkspace({
				...workspace,
				providerSandboxId: sandbox.providerSandboxId,
				runtimeBootTokenHash: boot.tokenHash,
				runtimeBootTokenExpiresAtMs: boot.expiresAtMs,
				runtimeState: "offline",
				state: "provisioning",
				statusCode: "runtime-starting",
				requestConfig: {
					...resetMailboxWakeObservation(
						withoutRuntimeBootstrapReceipt(workspace.requestConfig),
						allocatedAtMs,
					),
					...runtimeFence,
					...(typeof workspace.requestConfig.sessionHeadVersion === "number"
						? { runtimeSessionRecoveryPending: true }
						: {}),
					...(replacementPool === null ? {} : { poolClaimedAt: allocatedAtMs }),
					startupTimings: {
						...timings,
						...(replacementPool === null
							? {}
							: { poolClaimedAt: allocatedAtMs }),
						allocatedAt: allocatedAtMs,
						...(replacementPool === null && timings.poolClaimedAt === undefined
							? { forkedAt: allocatedAtMs }
							: {}),
					},
				},
				nextActionAtMs: allocatedAtMs + RUNTIME_CONNECTION_TIMEOUT_MS,
				revision: workspace.revision + 1,
				updatedAtMs: allocatedAtMs,
			});
			const startRuntime = provider.startProcess(sandbox.providerSandboxId, {
				command: WORKSPACE_BOOTSTRAP_FILE,
				tag: WORKSPACE_RUNTIME_PROCESS.tag,
				cwd: "/home/zuse",
				env: {
					...project.cloudEnvironment,
					ZUSE_CLOUD_WORKSPACE_ID: workspace.workspaceId,
					ZUSE_RUNTIME_BOOT_TOKEN: boot.token,
					ZUSE_API_URL: api.apiIssuer,
					ZUSE_BASE_REF: workspace.baseRef,
					ZUSE_BRANCH: workspace.branch,
					ZUSE_PROJECT_CACHE_ID: project.projectId,
					ZUSE_REPOSITORY_URL: project.repositoryUrl,
					ZUSE_CLOUD_WORKSPACE_ROOT: workspaceRoot,
					ZUSE_RUNTIME_GENERATION: String(runtimeFence.runtimeGeneration),
					ZUSE_GATEWAY_EPOCH: String(runtimeFence.gatewayEpoch),
				},
				user: "zuse",
			});
			// Assert the workspace invariant on every allocation path before the
			// runtime starts. A recovered or formerly pooled sandbox may retain the
			// policy from its original creation or resume, and starting these in
			// parallel races the agent's first gateway and model-api requests.
			yield* provider.setNetwork(sandbox.providerSandboxId, { kind: "open" });
			yield* startRuntime;
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
				saveWorkspace,
				workspace.statusCode === "resume-runtime-waking" ||
					workspace.statusCode === "restart-queued",
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
				const runtimeDiagnostic = yield* readWorkspaceRuntimeDiagnostic(
					provider,
					workspace.providerSandboxId,
				);
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
				yield* saveWorkspace({
					...workspace,
					state: "failed",
					statusCode: failureCode,
					runtimeState: "offline",
					requestConfig: {
						...workspace.requestConfig,
						...(runtimeDiagnostic.length === 0
							? {}
							: { startupFailureDiagnostic: runtimeDiagnostic }),
					},
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				});
				return;
			}
			if (workspaceStartupTimedOut(workspace, nowMs)) {
				const runtimeDiagnostic = yield* readWorkspaceRuntimeDiagnostic(
					provider,
					workspace.providerSandboxId,
				);
				console.warn("[cloud-workspace] runtime connection timeout", {
					workspaceId: workspace.workspaceId,
					statusCode: workspace.statusCode,
					runtimeDiagnostic,
				});
				yield* saveWorkspace({
					...workspace,
					state: "failed",
					statusCode: "runtime-connection-timeout",
					runtimeState: "offline",
					requestConfig: {
						...workspace.requestConfig,
						...(runtimeDiagnostic.length === 0
							? {}
							: { startupFailureDiagnostic: runtimeDiagnostic }),
					},
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				});
				return;
			}
			// Successful startup is advanced only by authenticated runtime callbacks.
			yield* saveWorkspace({
				...workspace,
				nextActionAtMs: workspaceStartupDeadlineMs(workspace),
				updatedAtMs: nowMs,
			});
			return;
		}

		if (
			(workspace.state === "paused" ||
				(workspace.state === "ready" && workspace.runtimeState !== "online")) &&
			workspace.desiredState === "ready" &&
			workspace.providerSandboxId !== undefined
		) {
			// Mailbox rollout deliberately upgrades retained v2 processes through the
			// existing fenced restart path. A warm E2B resume preserves the old process,
			// so it would otherwise never run the signed runtime updater or advertise v3.
			// The server capability flag keeps production on warm resume until rollout.
			if (
				apiConfig.cloudCommandMailboxEnabled &&
				!workspaceSupportsCloudCommandMailbox(workspace)
			)
				return yield* restartWorkspaceRuntime(
					workspace,
					workspace.providerSandboxId,
					provider,
					nowMs,
					saveWorkspace,
				);
			return yield* wakePreservedWorkspaceRuntime(
				workspace,
				workspace.providerSandboxId,
				provider,
				nowMs,
				config.keepAliveTimeoutSeconds,
				saveWorkspace,
			);
		}

		if (
			workspace.state === "ready" &&
			nowMs >=
				workspace.lastActivityAtMs + apiConfig.cloudWorkspaceIdleTimeoutMs
		)
			return yield* pauseWorkspace(
				workspace,
				provider,
				nowMs,
				false,
				saveWorkspace,
			);

		if (workspace.state === "ready" && workspace.runningSinceMs !== undefined) {
			yield* saveWorkspace({
				...workspace,
				nextActionAtMs: Math.min(
					nowMs + BILLING_RESERVATION_REFRESH_MS,
					workspace.lastActivityAtMs + apiConfig.cloudWorkspaceIdleTimeoutMs,
				),
				updatedAtMs: nowMs,
			});
			return;
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
		const nowMs = yield* Clock.currentTimeMillis;
		const leaseOwner = crypto.randomUUID();
		const workspace = yield* store.claimWorkspace(
			workspaceId,
			leaseOwner,
			nowMs,
			nowMs + RECONCILE_LEASE_MS,
		);
		if (workspace === null) return;
		let expectedRevision = workspace.revision;
		let expectedUpdatedAtMs = workspace.updatedAtMs;
		let currentWorkspace = workspace;
		const saveWorkspace: SaveClaimedWorkspace = (updated) =>
			store
				.saveClaimedWorkspace({
					workspace: updated,
					leaseOwner,
					expectedRevision,
					expectedUpdatedAtMs,
				})
				.pipe(
					Effect.flatMap((saved) =>
						saved
							? Effect.sync(() => {
									expectedRevision = updated.revision;
									expectedUpdatedAtMs = updated.updatedAtMs;
									currentWorkspace = updated;
								})
							: Effect.fail(new CloudWorkspaceLeaseLostError({ workspaceId })),
					),
				);
		yield* reconcileWorkspaceRecord(workspace, saveWorkspace).pipe(
			Effect.catchTag("SandboxProviderError", (error) =>
				Effect.gen(function* () {
					const failedAtMs = yield* Clock.currentTimeMillis;
					const destructiveLifecycle =
						destructiveMailboxLifecycle(currentWorkspace);
					if (destructiveLifecycle !== null) {
						// Provider failures may delay an accepted destructive transition, but
						// must never turn it back into a runnable workspace. A missing sandbox
						// is cleared so the next pass can finish the archive/delete locally.
						yield* saveWorkspace({
							...currentWorkspace,
							...(error.code === "not-found"
								? {
										providerSandboxId: undefined,
										runtimeBootTokenHash: undefined,
										runtimeBootTokenExpiresAtMs: undefined,
										runtimeCredentialHash: undefined,
										runtimeState: "offline" as const,
									}
								: {}),
							statusCode: `${destructiveLifecycle}-retrying`,
							nextActionAtMs:
								error.code === "not-found" ? failedAtMs : failedAtMs + RETRY_MS,
							revision: currentWorkspace.revision + 1,
							updatedAtMs: failedAtMs,
						});
						return;
					}
					if (error.code === "not-found") {
						yield* saveWorkspace({
							...currentWorkspace,
							providerSandboxId: undefined,
							runtimeBootTokenHash: undefined,
							runtimeBootTokenExpiresAtMs: undefined,
							runtimeCredentialHash: undefined,
							state: "queued",
							desiredState: "ready",
							statusCode: "provider-sandbox-replacing",
							runtimeState: "offline",
							nextActionAtMs: failedAtMs,
							revision: currentWorkspace.revision + 1,
							updatedAtMs: failedAtMs,
						});
						return;
					}
					if (error.code === "transient") {
						yield* saveWorkspace({
							...currentWorkspace,
							nextActionAtMs: failedAtMs + RETRY_MS,
							revision: currentWorkspace.revision + 1,
							updatedAtMs: failedAtMs,
						});
						return;
					}
					yield* saveWorkspace({
						...currentWorkspace,
						state: "failed",
						statusCode: "provider-unavailable",
						runtimeState: "offline",
						nextActionAtMs: Number.MAX_SAFE_INTEGER,
						revision: currentWorkspace.revision + 1,
						updatedAtMs: failedAtMs,
					});
				}),
			),
			Effect.catchTag("CloudWorkspaceLeaseLostError", () => Effect.void),
			Effect.ensuring(
				store
					.releaseWorkspaceLease(workspaceId, leaseOwner)
					.pipe(Effect.ignore),
			),
		);
	});

/**
 * Observe only the short pre-enrollment window. Successful runtimes continue
 * through their authenticated callbacks; failed processes are noticed without
 * waiting for the one-minute recovery reconciler.
 */
export const reconcileCloudWorkspaceStartup = Effect.fn(
	"reconcileCloudWorkspaceStartup",
)(function* (workspaceId: string) {
	const store = yield* CloudWorkspaceStore;
	const startedAtMs = yield* Clock.currentTimeMillis;
	while (true) {
		yield* reconcileCloudWorkspace(workspaceId);
		const workspace = yield* store.getWorkspace(workspaceId);
		if (!cloudWorkspaceStartupNeedsObservation(workspace)) return;
		const nowMs = yield* Clock.currentTimeMillis;
		if (nowMs - startedAtMs >= WORKSPACE_START_OBSERVATION_MS) return;
		yield* Effect.sleep(
			Duration.millis(WORKSPACE_START_OBSERVATION_INTERVAL_MS),
		);
	}
});
