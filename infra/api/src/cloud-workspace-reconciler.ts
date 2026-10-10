import {
	CLOUD_COMMAND_LEASE_TTL_MS,
	WIRE_PROTOCOL_VERSION,
} from "@zuse/contracts";
import {
	resolveSandboxResources,
	type SandboxProviderAdapter,
	SandboxProviderError,
	SandboxProviders,
	WORKSPACE_RUNTIME_PROCESS_SELECTOR,
} from "@zuse/sandbox-providers";
import { cloudTimingEvent, measureCloudStage } from "@zuse/utils/cloud-timing";
import { Cause, Clock, Data, Duration, Effect } from "effect";
import GITHUB_AUTH_SOURCE from "../../cloud-sandboxes/github-auth.sh";
import PROJECT_BUILDER_SOURCE from "../../cloud-sandboxes/project-builder.sh";
import WORKSPACE_BOOTSTRAP_SOURCE from "../../cloud-sandboxes/workspace-bootstrap.sh";
import WORKSPACE_FORK_PREPARE_SOURCE from "../../cloud-sandboxes/workspace-fork-prepare.sh";
import WORKSPACE_REPOSITORY_SOURCE from "../../cloud-sandboxes/workspace-repository.sh";
import WORKSPACE_RUNTIME_SOURCE from "../../cloud-sandboxes/workspace-runtime.sh";
import { snapshotCloudAuthAuthority } from "./cloud-auth-authority.ts";
import { allocatedComputeCostMicros } from "./cloud-billing.ts";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import { githubInstallationGrants } from "./cloud-github-app.ts";
import {
	connectionIdFor,
	resolveResourceProvider,
	resourceProviderConnectionId,
} from "./cloud-provider-connections.ts";
import { importedSnapshot, reconcileSnapshotImport } from "./cloud-snapshot.ts";
import {
	assertSnapshotUsable,
	prepareSnapshotIntent,
	promoteRetainedSnapshot,
	withSnapshotLeaseCheck,
	withSnapshotLifecycleLock,
} from "./cloud-snapshot-storage.ts";
import { deleteCloudTranscriptObjects } from "./cloud-transcript.ts";
import { observeCloudRuntimeUsage } from "./cloud-usage.ts";
import {
	forkCloudWorkspaceMachine,
	machineForkSource,
} from "./cloud-workspace-fork.ts";
import {
	MAX_MEMORY_RESTARTS,
	MEMORY_PRESSURE_WAIT_MS,
	MEMORY_RECHECK_MS,
	MEMORY_RECOVERY_WINDOW_MS,
	readCloudMemory,
} from "./cloud-workspace-memory.ts";
import {
	cloudRepositoryWorkspacePath,
	cloudWorkspaceLayout,
	cloudWorkspaceLayoutEnvironment,
	cloudWorkspaceRepositoryPath,
} from "./cloud-workspace-paths.ts";
import {
	activationProcessInput,
	openRuntimeActivationBoot,
	RUNTIME_ACTIVATION_INSTALLER,
	RUNTIME_ACTIVATION_RETRY_MS,
	RUNTIME_ACTIVATION_TIMEOUT_MS,
	RUNTIME_PREPARATION_TIMEOUT_MS,
	type RuntimeActivation,
	readRuntimeActivationJournal,
	runtimeActivation,
	runtimeActivationRetryAt,
	sealRuntimeActivationBoot,
} from "./cloud-workspace-runtime-activation.ts";
import { nextCloudWorkspaceRuntimeFence } from "./cloud-workspace-runtime-fence.ts";
import { workspaceStartupOutcome } from "./cloud-workspace-runtime-scheduling.ts";
import { WORKSPACE_RUNTIME_UPDATE_SCRIPT } from "./cloud-workspace-runtime-update.ts";
import {
	type CloudProjectBuildRecord,
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
	deliveredMailboxLifecycle,
	destructiveMailboxLifecycle,
	mailboxLifecycleCovers,
	mailboxLifecycleTombstoneConfig,
	pendingMailboxLifecycle,
	runtimeBootstrapReceiptFromConfig,
	withPendingMailboxLifecycle,
	workspaceDestructionFence,
	workspaceSupportsCloudCommandMailbox,
} from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import {
	type SandboxOfferConfig,
	SandboxOfferConfiguration,
} from "./sandbox-provider-module.ts";

const RETRY_MS = 5_000;
// Provider allocation happens before `allocatedAt`. Once compute exists, the
// baked runtime must enroll promptly; leaving this at minutes turns a broken
// runtime into a permanently spinning composer until the recovery cron runs.
export const RUNTIME_CONNECTION_TIMEOUT_MS = 10_000;
export const RUNTIME_INSTALL_TIMEOUT_MS = 120_000;
const RECONCILE_LEASE_MS = 2 * 60 * 1_000;
const PROJECT_BUILD_TIMEOUT_MS = 15 * 60 * 1_000;
export const ARCHIVED_WORKSPACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const WORKSPACE_RUNTIME_BOOT_TTL_MS = 30 * 60 * 1_000;
// A preserved mailbox request may need its 10-second transport timeout,
// followed by the one-second poll interval and authenticated readiness repair.
// Healthy runtimes advance immediately; this bounds only the restart fallback.
export const WARM_RUNTIME_RECONNECT_GRACE_MS = 12_000;
const MAILBOX_RUNTIME_RESPONSE_GRACE_MS = 2_500;
export const MAILBOX_RUNTIME_STALL_TIMEOUT_MS =
	CLOUD_COMMAND_LEASE_TTL_MS + 5_000;
const ARCHIVE_QUIESCE_GRACE_MS = 1_500;
const BILLING_RESERVATION_REFRESH_MS = 60_000;
const runtimeSigningKeyPath = (snapshot = false) =>
	snapshot
		? "/var/lib/zuse/runtime-signing-public.jwk"
		: "/home/zuse/.zuse-runtime-signing-public.jwk";
const runtimeUpdateEnvironment = (
	config: SandboxOfferConfig,
	snapshot = false,
): Readonly<Record<string, string>> =>
	config.runtimeManifestUrl === undefined
		? {}
		: {
				ZUSE_RUNTIME_MANIFEST_URL: config.runtimeManifestUrl,
				ZUSE_RUNTIME_PUBLIC_KEY_FILE: runtimeSigningKeyPath(snapshot),
				ZUSE_RUNTIME_WIRE_PROTOCOL: String(WIRE_PROTOCOL_VERSION),
			};

const writeRuntimeSigningKey = (
	provider: SandboxProviderAdapter,
	providerSandboxId: string,
	config: SandboxOfferConfig,
	user = "zuse",
	snapshot = false,
) =>
	config.runtimeSigningPublicJwk === undefined
		? Effect.void
		: provider.writeTextFile(
				providerSandboxId,
				runtimeSigningKeyPath(snapshot),
				config.runtimeSigningPublicJwk,
				user,
			);

const PROJECT_BUILD_DIAGNOSTIC_MAX_LENGTH = 2_048;
const PROJECT_BUILD_LOG_FILE = "/var/lib/zuse/project-build/build.log";
const PROJECT_BUILD_LOG_MAX_LENGTH = 256 * 1_024;
export const PROJECT_RUNTIME_UPDATE_RETRY_DELAYS_SECONDS = [0, 5, 15] as const;
const PROJECT_BUILDER_FILE = "/var/lib/zuse/project-build/builder.sh";
const WORKSPACE_BOOTSTRAP_FILE =
	"/var/lib/zuse/project-build/workspace-bootstrap.sh";
const WORKSPACE_RUNTIME_FILE =
	"/var/lib/zuse/project-build/workspace-runtime.sh";
// GitHub auth ships with the build for the same reason the bootstrap does:
// base images are republished by hand, so an image older than the `gh` shim
// would otherwise leave every workspace with an unauthenticated `gh`.
const GITHUB_AUTH_FILE = "/var/lib/zuse/project-build/github-auth.sh";
const WORKSPACE_REPOSITORY_FILE =
	"/var/lib/zuse/project-build/workspace-repository.sh";
const WORKSPACE_CREDENTIALS_READY_MARKER =
	"/var/lib/zuse/workspace/credentials-ready";
export const reserveProviderCost = Effect.fn("reserveProviderCost")(
	function* (input: {
		readonly accountId: string;
		readonly resourceKind: "workspace" | "build";
		readonly resourceId: string;
		readonly provider: string;
		readonly providerSandboxId?: string;
		readonly runningSinceMs?: number;
		readonly nowMs: number;
		readonly vcpuCount: number;
		readonly memoryMib: number;
	}) {
		const config = yield* ApiConfiguration;
		yield* observeCloudRuntimeUsage({ ...input, observedAtMs: input.nowMs });
		if (
			(yield* resourceProviderConnectionId(
				input.resourceKind,
				input.resourceId,
			)) !== undefined
		)
			return false;
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
			input.runningSinceMs ?? input.nowMs,
			period.periodStartMs,
			config.cloudBillingCutoverAtMs ?? input.runningSinceMs ?? input.nowMs,
		);
		const endedAtMs = Math.min(
			Math.max(startedAtMs + 60_000, input.nowMs + 60_000),
			period.periodEndMs,
		);
		const adapter = yield* (yield* SandboxProviders)
			.get(input.provider)
			.pipe(Effect.orDie);
		const usage =
			adapter.getUsage !== undefined &&
			input.providerSandboxId !== undefined &&
			input.nowMs > startedAtMs
				? yield* adapter
						.getUsage(input.providerSandboxId, {
							startedAtMs,
							endedAtMs: Math.min(input.nowMs, period.periodEndMs),
						})
						.pipe(
							Effect.catchTag("SandboxProviderError", () =>
								Effect.succeed(null),
							),
						)
				: null;
		let providerCostMicros: number;
		if (usage !== null) {
			// Accrued list-price cost plus the same short forward reservation used by other providers.
			providerCostMicros =
				usage.providerCostMicros +
				(usage.running
					? Math.ceil(
							(Math.max(0, endedAtMs - usage.endedAtMs) / 1_000) *
								usage.costMicrosPerSecond,
						)
					: 0);
		} else {
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
			providerCostMicros = prices.reduce(
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
			);
		}
		const reservation = yield* billingStore.reserveCost({
			periodId: period.periodId,
			accountId: input.accountId,
			resourceKind: input.resourceKind,
			resourceId: input.resourceId,
			provider: input.provider,
			providerCostMicros,
			startedAtMs,
			vcpuCount: input.vcpuCount,
			memoryMib: input.memoryMib,
			nowMs: input.nowMs,
			expiresAtMs: input.nowMs + 2 * 60_000,
		});
		return config.cloudBillingEnforcementEnabled && !reservation.accepted;
	},
);

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
	readonly providerAuthDeliveryVersion?: number;
	readonly expectedProviderAuthDeliveryVersion?: number;
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
	if (
		input.providerAuthDeliveryVersion !==
		input.expectedProviderAuthDeliveryVersion
	)
		failures.push("Provider auth delivery capability mismatch");
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

/** Preserve the current runtime's authority while asking it to reassert readiness.
 * Only the reconciler may replace it if no authenticated response arrives. */
export const workspaceRuntimeReconnectTarget = (
	workspace: CloudWorkspaceRecord,
	nowMs: number,
): CloudWorkspaceRecord => ({
	...workspace,
	desiredState: "ready",
	runtimeState: "connecting",
	state: "resuming",
	statusCode: "resume-runtime-waking",
	requestConfig: resetMailboxWakeObservation(workspace.requestConfig, nowMs),
	nextActionAtMs: nowMs + WARM_RUNTIME_RECONNECT_GRACE_MS,
	lastActivityAtMs: nowMs,
	runningSinceMs: workspace.runningSinceMs ?? nowMs,
	revision: workspace.revision + 1,
	updatedAtMs: nowMs,
});

class CloudWorkspaceLeaseLostError extends Data.TaggedError(
	"CloudWorkspaceLeaseLostError",
)<{ readonly workspaceId: string }> {}

type SaveClaimedWorkspace = (
	workspace: CloudWorkspaceRecord,
) => Effect.Effect<void, CloudWorkspaceLeaseLostError>;
export const workspaceRuntimeProcessSelector = () =>
	WORKSPACE_RUNTIME_PROCESS_SELECTOR;

/** A missing provider sandbox must never be replaced after SQLite became authoritative. */
export const cloudWorkspaceHasRetainedRuntimeData = (
	workspace: Pick<CloudWorkspaceRecord, "requestConfig" | "statusCode">,
): boolean =>
	typeof workspace.requestConfig.sessionHeadVersion === "number" ||
	workspace.requestConfig.runtimeSessionRecoveryPending === true ||
	workspace.statusCode === "agent-starting" ||
	workspace.statusCode === "agent-running";

export const WORKSPACE_RUNTIME_RESUME_SCRIPT = `set -euo pipefail
${WORKSPACE_RUNTIME_SOURCE}
if [ "\${ZUSE_SNAPSHOT_NATIVE:-}" = 1 ]; then source /etc/zuse/snapshot.env; fi
initialize_workspace_runtime_attempt
acquire_workspace_runtime_lock
timing() { echo "[cloud-timing] workspaceId=$ZUSE_CLOUD_WORKSPACE_ID generation=$ZUSE_RUNTIME_GENERATION stage=$1 atMs=$(date +%s%3N)" >> "$status_dir/runtime.log"; }
timing runtime.shell-start
runtime=/opt/zuse/current/bin.mjs
fallback=/usr/local/bin/zuse
log="$status_dir/runtime.log"
rm -f "$status_dir/failed" "$status_dir/credentials-ready" "$status_dir/credentials-ready-event" "$status_dir/failure-phase"
${WORKSPACE_RUNTIME_UPDATE_SCRIPT}
phase=updating-runtime
if [ -n "\${ZUSE_RUNTIME_ACTIVATION_MODE:-}" ]; then
  "\${ZUSE_RUNTIME_NODE:-node}" "$ZUSE_RUNTIME_ACTIVATION_INSTALLER" "--$ZUSE_RUNTIME_ACTIVATION_MODE" >>"$log" 2>&1
fi
phase=runtime-compatibility
ensure_workspace_runtime
phase=syncing-repository
if [ ! -f "$status_dir/repository-ready" ]; then
if bash <<'ZUSE_WORKSPACE_REPOSITORY' >> "$log" 2>&1
${WORKSPACE_REPOSITORY_SOURCE}
ZUSE_WORKSPACE_REPOSITORY
then
touch "$status_dir/repository-ready"
else
exit $?
fi
fi
timing runtime.exec
if [ -f "$runtime" ]; then exec_workspace_runtime "\${ZUSE_RUNTIME_NODE:-node}" "$runtime" serve >> "$log" 2>&1; else exec_workspace_runtime "$fallback" serve --foreground >> "$log" 2>&1 </dev/null; fi`;
const WORKSPACE_RUNTIME_BOOTSTRAP_SCRIPT = `set -euo pipefail
${WORKSPACE_RUNTIME_SOURCE}
if [[ "\${ZUSE_SNAPSHOT_NATIVE:-}" == 1 ]]; then source /etc/zuse/snapshot.env; fi
initialize_workspace_runtime_attempt
acquire_workspace_runtime_lock
${WORKSPACE_RUNTIME_UPDATE_SCRIPT}
phase=runtime-compatibility
ensure_workspace_runtime
exec /bin/bash ${WORKSPACE_BOOTSTRAP_FILE}`;
const providerLabel = (kind: "build" | "workspace", id: string): string =>
	`zuse-cloud-${kind}-${id.replace(/[^A-Za-z0-9-]/gu, "-")}`.slice(0, 63);

const workspaceSizeId = (
	workspace: CloudWorkspaceRecord,
): string | undefined =>
	typeof workspace.requestConfig.sizeId === "string"
		? workspace.requestConfig.sizeId
		: undefined;

export const withoutRuntimeBootstrapReceipt = (
	config: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
	const {
		runtimeBootstrapReceipt: _receipt,
		runtimeInstallPending: _install,
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
	return enrolledAt !== undefined
		? enrolledAt + RUNTIME_CONNECTION_TIMEOUT_MS
		: allocatedAt +
				(workspace.requestConfig.runtimeInstallPending === true
					? RUNTIME_INSTALL_TIMEOUT_MS
					: RUNTIME_CONNECTION_TIMEOUT_MS);
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
	lastErrorCode: string | undefined,
	nowMs: number,
) {
	const store = yield* CloudWorkspaceStore;
	for (const project of yield* store.listProjects(accountId)) {
		// A failed image on one provider must not disable the other ready image.
		if (state === "failed" && project.state === "ready") continue;
		yield* store.saveProject({
			...project,
			state,
			lastErrorCode,
			updatedAtMs: nowMs,
		});
	}
});

const reconcileBuildRecord = Effect.fn("reconcileCloudAccountImageBuild")(
	function* (build: CloudProjectBuildRecord) {
		const store = yield* CloudWorkspaceStore;
		if (importedSnapshot(build)) {
			const provider = yield* resolveResourceProvider(build).pipe(Effect.orDie);
			yield* reserveProviderCost({
				accountId: build.accountId,
				resourceKind: "build",
				resourceId: build.buildId,
				provider: build.provider,
				providerSandboxId: build.providerSandboxId,
				runningSinceMs:
					build.state === "queued" ? undefined : build.createdAtMs,
				nowMs: yield* Clock.currentTimeMillis,
				...provider.resources,
			});
			const now = yield* Clock.currentTimeMillis;
			return yield* reconcileSnapshotImport(build, provider, now).pipe(
				Effect.catchTag("SandboxProviderError", (error) =>
					Effect.gen(function* () {
						const latest = (yield* store.getBuild(build.buildId)) ?? build;
						const terminal =
							error.code === "rejected" || error.code === "not-found";
						if (terminal && latest.providerSandboxId !== undefined) {
							yield* provider
								.kill(latest.providerSandboxId)
								.pipe(
									Effect.catchTag("SandboxProviderError", (cleanupError) =>
										cleanupError.code === "not-found"
											? Effect.void
											: Effect.fail(cleanupError),
									),
								);
							yield* observeCloudRuntimeUsage({
								accountId: latest.accountId,
								resourceKind: "build",
								resourceId: latest.buildId,
								provider: latest.provider,
								providerSandboxId: latest.providerSandboxId,
								observedAtMs: now,
								...provider.resources,
							});
						}
						yield* store.saveBuild({
							...latest,
							state: terminal ? "failed" : latest.state,
							lastErrorCode: `snapshot-provider-${error.code}`,
							nextActionAtMs: terminal ? Number.MAX_SAFE_INTEGER : now + 5_000,
							revision: latest.revision + 1,
							updatedAtMs: now,
						});
					}),
				),
				Effect.orDie,
			);
		}
		if (build.projectId === null) return;
		const project = yield* store.getProject(build.projectId);
		if (project === null) return;
		const provider = yield* resolveResourceProvider(build).pipe(Effect.orDie);
		const config = yield* SandboxOfferConfiguration;
		const nowMs = yield* Clock.currentTimeMillis;
		const buildBillingHold = yield* reserveProviderCost({
			accountId: build.accountId,
			resourceKind: "build",
			resourceId: build.buildId,
			provider: build.provider,
			providerSandboxId: build.providerSandboxId,
			runningSinceMs: build.state === "queued" ? nowMs : build.updatedAtMs,
			nowMs,
			vcpuCount: provider.resources.vcpuCount,
			memoryMib: provider.resources.memoryMib,
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
			build.snapshotId === undefined &&
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
			// A queued build that cannot start must end visibly. Retrying a
			// permanent provider refusal, or retrying forever, leaves the image
			// "in progress" with no output.
			const failQueuedBuild = (failureCode: string, logText: string) =>
				Effect.gen(function* () {
					yield* Effect.sync(() =>
						console.warn("[cloud-workspace] project build failed", {
							buildId: build.buildId,
							failureCode,
						}),
					);
					const previous = yield* store.getActiveAccountBuild(
						build.accountId,
						build.provider,
					);
					yield* store.saveBuild({
						...build,
						state: "failed",
						lastErrorCode: failureCode,
						logText,
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
				});
			const ownKey = connectionIdFor(build) !== undefined;
			const rejectedLog = ownKey
				? `${provider.displayName} refused this request with your provider key (permission denied). Check that the key can read and create machines in its organization and can use the configured template, then rebuild.`
				: `${provider.displayName} refused this request (permission denied). Try again later or choose another provider.`;
			// Only a permanent refusal ends the build; anything else retries.
			const unlessRejected = <A, R>(
				effect: Effect.Effect<A, SandboxProviderError, R>,
			) =>
				effect.pipe(
					Effect.map((value) => ({ rejected: false as const, value })),
					Effect.catchTag("SandboxProviderError", (error) =>
						error.code === "rejected"
							? Effect.succeed({ rejected: true as const })
							: Effect.die(error),
					),
				);
			if (nowMs - build.updatedAtMs >= PROJECT_BUILD_TIMEOUT_MS) {
				yield* failQueuedBuild(
					"project-start-timeout",
					`The build could not start on ${provider.displayName} within 15 minutes. Rebuild to try again.`,
				);
				return;
			}
			const label = providerLabel("build", build.buildId);
			const apiConfig = yield* ApiConfiguration;
			const recovered = yield* unlessRejected(provider.recoverByLabel(label));
			if (recovered.rejected) {
				yield* failQueuedBuild("provider-rejected", rejectedLog);
				return;
			}
			const existing = recovered.value;
			const previousAccountBuild = yield* store.getActiveAccountBuild(
				build.accountId,
				build.provider,
			);
			const cleanRebuild = build.idempotencyKey.startsWith(
				"account-image:rebuild:",
			);
			const authSnapshotId =
				connectionIdFor(build) !== undefined
					? undefined
					: cleanRebuild ||
							previousAccountBuild === null ||
							previousAccountBuild.templateVersion !== build.templateVersion
						? yield* snapshotCloudAuthAuthority(
								build.accountId,
								`account-auth-${build.buildId}`,
								build.provider,
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
			const allocateBuild = Effect.gen(function* () {
				if (
					reusableSnapshotId !== undefined &&
					connectionIdFor(build) === undefined
				)
					yield* assertSnapshotUsable(
						build.accountId,
						build.provider,
						reusableSnapshotId,
					);
				const allocated =
					existing !== null
						? { rejected: false as const, value: existing }
						: yield* unlessRejected(
								reusableSnapshotId === undefined
									? provider
											.create({
												sandboxId: build.buildId,
												providerLabel: label,
												metadata: {
													"zuse-account-id": build.accountId,
													"zuse-resource-kind": "build",
													"zuse-project-id": project.projectId,
													"zuse-build-id": build.buildId,
												},
												timeoutSeconds: config.createTimeoutSeconds,
												env: {},
												network: { kind: "open" },
												onTimeout: "terminate",
											})
											.pipe(withSnapshotLeaseCheck)
									: provider
											.fork({
												sandboxId: build.buildId,
												providerLabel: label,
												metadata: {
													"zuse-account-id": build.accountId,
													"zuse-resource-kind": "build",
													"zuse-project-id": project.projectId,
													"zuse-build-id": build.buildId,
												},
												snapshotId: reusableSnapshotId,
												timeoutSeconds: config.createTimeoutSeconds,
												env: {},
												network: { kind: "open" },
												onTimeout: "terminate",
											})
											.pipe(withSnapshotLeaseCheck),
							);
				return allocated;
			});
			const allocated =
				reusableSnapshotId === undefined || connectionIdFor(build) !== undefined
					? yield* allocateBuild
					: yield* withSnapshotLifecycleLock(
							build.accountId,
							build.provider,
							allocateBuild,
							"shared",
						);
			if (allocated.rejected) {
				if (authSnapshotId !== undefined)
					yield* provider.deleteSnapshot(authSnapshotId).pipe(Effect.ignore);
				yield* failQueuedBuild("provider-rejected", rejectedLog);
				return;
			}
			const sandbox = allocated.value;
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
						WORKSPACE_REPOSITORY_FILE,
						WORKSPACE_REPOSITORY_SOURCE,
						"zuse",
					),
					provider.writeTextFile(
						sandbox.providerSandboxId,
						WORKSPACE_BOOTSTRAP_FILE,
						WORKSPACE_BOOTSTRAP_SOURCE,
						"zuse",
					),
					provider.writeTextFile(
						sandbox.providerSandboxId,
						WORKSPACE_RUNTIME_FILE,
						WORKSPACE_RUNTIME_SOURCE,
						"zuse",
					),
					provider.writeTextFile(
						sandbox.providerSandboxId,
						GITHUB_AUTH_FILE,
						GITHUB_AUTH_SOURCE,
						"zuse",
					),
					writeRuntimeSigningKey(provider, sandbox.providerSandboxId, config),
				],
				{ concurrency: "unbounded", discard: true },
			).pipe(Effect.orDie);
			yield* provider
				.startProcess(sandbox.providerSandboxId, {
					command: "/usr/bin/chmod",
					args: [
						"0700",
						PROJECT_BUILDER_FILE,
						WORKSPACE_BOOTSTRAP_FILE,
						GITHUB_AUTH_FILE,
					],
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
					return JSON.stringify({
						projectId: candidate.projectId,
						repositoryUrl: candidate.repositoryUrl,
						defaultBranch: candidate.defaultBranch,
						visibility: candidate.visibility,
						tokenFile: tokenFileByRepository.get(repositoryName) ?? null,
						workspacePath: cloudRepositoryWorkspacePath(
							candidate.repositoryIdentity,
						),
					});
				})
				.join("\n");
			yield* provider
				.writeTextFile(
					sandbox.providerSandboxId,
					"/var/lib/zuse/project-build/repositories.jsonl",
					`${repositoryManifest}\n`,
					"zuse",
				)
				.pipe(Effect.orDie);
			// Apply the provider network policy before starting the image builder.
			yield* provider
				.setNetwork(sandbox.providerSandboxId, { kind: "open" })
				.pipe(Effect.orDie);
			yield* provider
				.startProcess(sandbox.providerSandboxId, {
					command: "/bin/bash",
					args: [
						"-lc",
						`set -e; : >${PROJECT_BUILD_LOG_FILE}; if [ -n "\${ZUSE_RUNTIME_MANIFEST_URL:-}" ] && [ -f "\${ZUSE_RUNTIME_PUBLIC_KEY_FILE:-}" ]; then code=1; for delay in ${PROJECT_RUNTIME_UPDATE_RETRY_DELAYS_SECONDS.join(" ")}; do if [ "$delay" -gt 0 ]; then sleep "$delay"; fi; if ZUSE_RUNTIME_INSTALL_ONLY=1 ZUSE_RUNTIME_SKIP_TOOLCHAIN=1 node /usr/local/lib/zuse/runtime-updater.mjs >>${PROJECT_BUILD_LOG_FILE} 2>&1; then code=0; break; else code=$?; fi; done; if [ "$code" -ne 0 ]; then printf 'updating-runtime\n' >/var/lib/zuse/project-build/failure-phase; touch /var/lib/zuse/project-build/failed /tmp/zuse-project-builder-exited; exit "$code"; fi; fi; set +e; ${PROJECT_BUILDER_FILE} >>${PROJECT_BUILD_LOG_FILE} 2>&1; code=$?; touch /tmp/zuse-project-builder-exited; exit "$code"`,
					],
					env: {
						ZUSE_TEMPLATE_VERSION: build.templateVersion,
						ZUSE_CONFIGURATION_DIGEST: build.configurationDigest,
						...(build.settings?.codexAuthDeliveryVersion === 1
							? { ZUSE_CODEX_AUTH_DELIVERY_VERSION: "1" }
							: {}),
						...(build.settings?.providerAuthDeliveryVersion === 1
							? {
									ZUSE_PROVIDER_AUTH_DELIVERY_VERSION: "1",
									ZUSE_PROVIDER_STATUS_JSON: JSON.stringify(
										build.settings.providers ?? [],
									),
								}
							: {}),
						ZUSE_REPOSITORY_CACHE_MAX_BYTES: String(
							apiConfig.cloudRepositoryCacheMaxBytes,
						),
						...runtimeUpdateEnvironment(config),
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
				...(build.settings?.providerAuthDeliveryVersion === 1
					? [
							"/home/zuse/.codex/auth.json",
							"/home/zuse/.grok/auth.json",
							"/home/zuse/.zuse-image/provider-secrets.json",
							"/home/zuse/.zuse/cloud-auth",
						]
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
				providerAuthDeliveryVersion:
					typeof manifest.providerAuthDeliveryVersion === "number"
						? manifest.providerAuthDeliveryVersion
						: undefined,
				expectedProviderAuthDeliveryVersion:
					build.settings?.providerAuthDeliveryVersion === 1 ? 1 : undefined,
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
				logText,
				state: "sanitizing" as const,
				nextActionAtMs: nowMs,
				revision: build.revision + 1,
				updatedAtMs: nowMs,
			};
			yield* store.saveBuild(sanitizing);
			build = sanitizing;
		}
		// Snapshot creation is idempotent by build name. A worker can exit after
		// saving this stage; retries must resume the same snapshot, not re-run setup.
		if (build.state === "sanitizing" && build.providerSandboxId !== undefined) {
			const providerSandboxId = build.providerSandboxId;
			yield* prepareSnapshotIntent(
				build,
				`${project.projectId}-${build.buildId}`,
				nowMs,
			);
			const snapshotId =
				build.snapshotId ??
				(yield* provider
					.snapshot(
						build.providerSandboxId,
						`${project.projectId}-${build.buildId}`,
					)
					.pipe(
						Effect.catchTag("SandboxProviderError", (error) =>
							Effect.gen(function* () {
								const retry =
									error.code === "transient" &&
									Date.now() - build.createdAtMs < PROJECT_BUILD_TIMEOUT_MS;
								const diagnostic = `Snapshot publication: ${error.code}. ${retry ? "Retrying automatically." : "Check the sandbox provider configuration and permissions before retrying."}`;
								if (!retry) {
									// Keep the pending build until cleanup succeeds, so failures retry.
									yield* provider.kill(providerSandboxId).pipe(Effect.orDie);
									const previous = yield* store.getActiveAccountBuild(
										build.accountId,
										build.provider,
									);
									yield* saveAccountProjectState(
										build.accountId,
										previous === null ? "failed" : "ready",
										`snapshot-${error.code}`,
										Date.now(),
									);
								}
								yield* store.saveBuild({
									...build,
									providerSandboxId: retry
										? build.providerSandboxId
										: undefined,
									state: retry ? "sanitizing" : "failed",
									lastErrorCode: `snapshot-${error.code}`,
									logText: build.logText?.includes(diagnostic)
										? build.logText
										: [build.logText, diagnostic].filter(Boolean).join("\n"),
									nextActionAtMs: retry
										? Date.now() + RETRY_MS
										: Number.MAX_SAFE_INTEGER,
									updatedAtMs: Date.now(),
									revision: build.revision + 1,
								});
								return undefined;
							}),
						),
					));
			if (snapshotId === undefined) return;
			// Persist the recoverable snapshot before deleting its source sandbox.
			if (build.snapshotId === undefined) {
				build = {
					...build,
					snapshotId,
					revision: build.revision + 1,
					updatedAtMs: nowMs,
				};
				yield* store.saveBuild(build);
			}
			if (
				(yield* provider.inspect(providerSandboxId).pipe(Effect.orDie)) !== null
			)
				yield* provider.kill(providerSandboxId).pipe(Effect.orDie);
			yield* saveAccountProjectState(
				build.accountId,
				"ready",
				undefined,
				nowMs,
			);
			const promotedAtMs = yield* Clock.currentTimeMillis;
			const promoted = {
				...build,
				lastErrorCode: undefined,
				snapshotId,
				providerSandboxId: undefined,
				state: "ready",
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: build.revision + 1,
				updatedAtMs: promotedAtMs,
			} as const;
			yield* promoteRetainedSnapshot(promoted, promotedAtMs);
			const superseded = (yield* store.listAccountBuilds(
				build.accountId,
				build.provider,
			)).filter(
				(candidate) =>
					candidate.buildId !== promoted.buildId &&
					candidate.snapshotId !== undefined,
			);
			for (const candidate of superseded) {
				if (
					candidate.provider === "box" &&
					connectionIdFor(candidate) === undefined
				)
					continue; // Durable inventory owns platform Boat deletion retries.
				if (candidate.snapshotId === undefined || importedSnapshot(candidate))
					continue;
				const cleanup = yield* (yield* resolveResourceProvider(candidate))
					.deleteSnapshot(candidate.snapshotId)
					.pipe(Effect.result);
				if (cleanup._tag === "Failure") continue;
				yield* store.saveBuild({
					...candidate,
					snapshotId: undefined,
					revision: candidate.revision + 1,
				});
			}
		}
	},
);

const recordLifecycle = (
	workspace: CloudWorkspaceRecord,
	kind: string,
	nowMs: number,
) =>
	Effect.gen(function* () {
		const store = yield* CloudWorkspaceStore;
		yield* store.recordUsage({
			// Retain the old receipt key across the classification migration.
			eventId: `${workspace.workspaceId}:${kind === "lifecycle-elapsed-seconds" ? "runtime-seconds" : kind}:${workspace.revision}`,
			workspaceId: workspace.workspaceId,
			accountId: workspace.accountId,
			provider: workspace.provider,
			kind,
			quantity:
				kind === "lifecycle-elapsed-seconds"
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
		// Lifecycle wall time can include provider auto-pause. It is not compute
		// usage; provider settlement and observed runtime use their own ledger.
		yield* recordLifecycle(workspace, "lifecycle-elapsed-seconds", nowMs);
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
		const resumed = yield* provider
			.resume(
				providerSandboxId,
				keepAliveTimeoutSeconds,
				"pause",
				workspaceSizeId(workspace),
			)
			.pipe(
				measureCloudStage(
					{ workspaceId: workspace.workspaceId, provider: provider.providerId },
					"provider.resume",
				),
			);
		const resumedAtMs = yield* Clock.currentTimeMillis;
		if (resumed.processContinuity === "lost") {
			return yield* restartWorkspaceRuntime(
				workspace,
				providerSandboxId,
				provider,
				resumedAtMs,
				saveWorkspace,
				true,
			);
		}
		yield* saveWorkspace({
			...workspaceRuntimeReconnectTarget(workspace, nowMs),
			nextActionAtMs: resumedAtMs + WARM_RUNTIME_RECONNECT_GRACE_MS,
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
		Effect.catchTag("SandboxProviderError", (error) =>
			error.code === "transient"
				? Effect.succeed(false)
				: error.code === "not-found"
					? Effect.succeed(true)
					: Effect.fail(error),
		),
	);

/** Idempotent preparation also repairs a crash between authorization and file delivery. */
const prepareWorkspaceRuntimeLaunch = Effect.fn(
	"prepareWorkspaceRuntimeLaunch",
)(function* (
	workspace: CloudWorkspaceRecord,
	provider: SandboxProviderAdapter,
	sandboxId: string,
) {
	const config = yield* SandboxOfferConfiguration;
	const layout = cloudWorkspaceLayout(workspace);
	yield* Effect.all(
		[
			provider.setNetwork(sandboxId, { kind: "open" }),
			...(
				[
					[WORKSPACE_REPOSITORY_FILE, WORKSPACE_REPOSITORY_SOURCE],
					[GITHUB_AUTH_FILE, GITHUB_AUTH_SOURCE],
					[WORKSPACE_BOOTSTRAP_FILE, WORKSPACE_BOOTSTRAP_SOURCE],
					[WORKSPACE_RUNTIME_FILE, WORKSPACE_RUNTIME_SOURCE],
				] as const
			).map(([path, source]) =>
				provider.writeTextFile(sandboxId, path, source, layout.user),
			),
			writeRuntimeSigningKey(
				provider,
				sandboxId,
				config,
				layout.user,
				layout.snapshot,
			),
		],
		{ concurrency: "unbounded", discard: true },
	);
});

const workspaceRuntimeLaunchInput = Effect.fn("workspaceRuntimeLaunchInput")(
	function* (
		workspace: CloudWorkspaceRecord,
		token: string,
		bootstrap = false,
	) {
		const store = yield* CloudWorkspaceStore;
		const config = yield* SandboxOfferConfiguration;
		const api = yield* ApiConfiguration;
		const project = yield* store.getProject(workspace.projectId);
		if (project === null) return null;
		return {
			command: "/bin/bash",
			args: [
				"-lc",
				bootstrap
					? WORKSPACE_RUNTIME_BOOTSTRAP_SCRIPT
					: WORKSPACE_RUNTIME_RESUME_SCRIPT,
			],
			cwd: cloudWorkspaceLayout(workspace).home,
			user: cloudWorkspaceLayout(workspace).user,
			env: {
				...project.cloudEnvironment,
				...cloudWorkspaceLayoutEnvironment(workspace),
				ZUSE_CLOUD_WORKSPACE_ID: workspace.workspaceId,
				ZUSE_RUNTIME_BOOT_TOKEN: token,
				ZUSE_API_URL: api.apiIssuer,
				ZUSE_CLOUD_WORKSPACE_ROOT: cloudWorkspaceRepositoryPath(
					workspace,
					project.repositoryIdentity,
				),
				ZUSE_BRANCH: workspace.branch,
				ZUSE_PROJECT_CACHE_ID: project.projectId,
				ZUSE_BASE_REF: workspace.baseRef,
				...(machineForkSource(workspace) === undefined
					? {}
					: { ZUSE_FORK_CHECKOUT: "1" }),
				ZUSE_REPOSITORY_URL: project.repositoryUrl,
				ZUSE_RUNTIME_KIND: "cloud-workspace",
				ZUSE_HOST: "127.0.0.1",
				ZUSE_PORT: "47837",
				ZUSE_AUTH_POLICY: "protected",
				ZUSE_ENABLE_PAIRING: "0",
				ZUSE_MACHINE_RUNTIME_ROLE: "cloud-environment",
				ZUSE_SERVER_READY_STDOUT: "1",
				ZUSE_USER_DATA: "/var/lib/zuse/user-data",
				...(typeof workspace.requestConfig.sessionHeadVersion === "number" ||
				typeof workspace.requestConfig.storageIncarnation === "string"
					? { ZUSE_RUNTIME_EXPECT_EXISTING_DATA: "1" }
					: {}),
				ZUSE_RUNTIME_GENERATION: String(
					workspace.requestConfig.runtimeGeneration,
				),
				ZUSE_GATEWAY_EPOCH: String(workspace.requestConfig.gatewayEpoch),
				...runtimeUpdateEnvironment(
					config,
					cloudWorkspaceLayout(workspace).snapshot,
				),
			},
		};
	},
);

/** Recover the recorded launch, rather than inventing another owner after a lost provider response. */
const reconcileRuntimeActivation = Effect.fn("reconcileRuntimeActivation")(
	function* (
		workspace: CloudWorkspaceRecord,
		provider: SandboxProviderAdapter,
		nowMs: number,
		saveWorkspace: SaveClaimedWorkspace,
	) {
		const operation = runtimeActivation(workspace);
		if (
			operation === null ||
			operation.phase === "confirmed" ||
			operation.phase === "failed" ||
			workspace.providerSandboxId === undefined
		)
			return false;
		if (operation.phase === "verification-needed") {
			return (
				workspace.statusCode !== "restart-queued" &&
				workspace.requestConfig.runtimeReleaseChangeRequested !== true
			);
		}
		const activationExpired =
			nowMs - operation.startedAtMs >=
			(operation.phase === "preparing"
				? RUNTIME_PREPARATION_TIMEOUT_MS
				: RUNTIME_ACTIVATION_TIMEOUT_MS);
		const config = yield* SandboxOfferConfiguration;
		const journal =
			operation.mode === "restart-installed"
				? null
				: yield* readRuntimeActivationJournal(provider, workspace).pipe(
						Effect.catchTag("SandboxProviderError", (error) =>
							activationExpired ? Effect.succeed(null) : Effect.fail(error),
						),
					);
		const currentJournal =
			journal?.transactionId === operation.id ? journal : null;
		const save = (
			updated: RuntimeActivation,
			changes: Partial<CloudWorkspaceRecord> = {},
		) =>
			saveWorkspace({
				...workspace,
				...changes,
				requestConfig: {
					...workspace.requestConfig,
					runtimeActivation: updated,
				},
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
				nextActionAtMs:
					changes.nextActionAtMs ??
					Math.min(
						nowMs + RUNTIME_ACTIVATION_RETRY_MS,
						updated.startedAtMs +
							(updated.phase === "preparing"
								? RUNTIME_PREPARATION_TIMEOUT_MS
								: RUNTIME_ACTIVATION_TIMEOUT_MS),
					),
			});
		if (operation.phase === "preparing") {
			if (currentJournal?.phase === "prepared") return false;
			if (nowMs - operation.startedAtMs >= RUNTIME_PREPARATION_TIMEOUT_MS) {
				// Preparation has no execution authority: its failure keeps the old owner valid.
				yield* save(
					{
						...operation,
						phase: "failed",
						lastErrorCode: "runtime-update-prepare-timeout",
					},
					{
						statusCode: "runtime-update-prepare-failed",
						...(workspace.runtimeCredentialHash === undefined
							? {}
							: { state: "ready" as const }),
					},
				);
				return true;
			}
			yield* save(operation);
			return true;
		}
		if (workspace.requestConfig.runtimeGeneration !== operation.generation) {
			const { sealedBootToken: _secret, ...superseded } = operation;
			yield* save({
				...superseded,
				phase: "failed",
				lastErrorCode: "runtime-activation-superseded",
			});
			return true;
		}
		if (
			currentJournal?.phase === "confirmed" &&
			currentJournal.generation === operation.generation &&
			currentJournal.confirmedVersion === operation.targetVersion
		) {
			const { sealedBootToken: _secret, ...confirmed } = operation;
			yield* save({ ...confirmed, phase: "confirmed" });
			return true;
		}
		if (
			activationExpired &&
			(operation.phase === "confirming" || workspace.runtimeState === "online")
		) {
			const { sealedBootToken: _secret, ...unverified } = operation;
			yield* save(
				{
					...unverified,
					phase: "verification-needed",
					lastErrorCode: "runtime-update-verification-needed",
				},
				{
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
					...(workspace.runtimeState === "online"
						? {}
						: {
								state: "failed" as const,
								statusCode: "runtime-update-verification-needed",
							}),
				},
			);
			return true;
		}
		if (
			workspace.runtimeState === "online" &&
			workspace.state === "ready" &&
			workspace.requestConfig.runtimeSessionRecoveryPending !== true &&
			workspace.requestConfig.runtimeGeneration === operation.generation
		) {
			const store = yield* CloudWorkspaceStore;
			const summary = yield* store.getRuntimeSummary(workspace.workspaceId);
			if (
				summary !== null &&
				summary.runtimeGeneration === operation.generation &&
				summary.sessionHeadVersion >=
					Number(workspace.requestConfig.sessionHeadVersion ?? 0)
			) {
				if (operation.mode === "restart-installed") {
					const { sealedBootToken: _secret, ...confirmed } = operation;
					yield* save({ ...confirmed, phase: "confirmed" });
					return true;
				}
				yield* provider.startProcess(workspace.providerSandboxId, {
					command: "/bin/bash",
					args: ["-lc", `node ${RUNTIME_ACTIVATION_INSTALLER} --confirm`],
					user: cloudWorkspaceLayout(workspace).user,
					tag: "zuse-runtime-confirm",
					env: {
						...runtimeUpdateEnvironment(
							config,
							cloudWorkspaceLayout(workspace).snapshot,
						),
						ZUSE_RUNTIME_UPDATE_TRANSACTION_ID: operation.id,
						ZUSE_RUNTIME_UPDATE_GENERATION: String(operation.generation),
						ZUSE_RUNTIME_EXPECTED_VERSION: operation.targetVersion ?? "",
					},
				});
				const updated = {
					...operation,
					phase: "confirming" as const,
					attempts: operation.attempts + 1,
				};
				yield* saveWorkspace({
					...workspace,
					requestConfig: {
						...workspace.requestConfig,
						runtimeActivation: updated,
					},
					nextActionAtMs: runtimeActivationRetryAt(updated, nowMs),
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				});
				return true;
			}
			yield* save(operation);
			return true;
		}
		if (operation.phase === "confirming") {
			yield* save(operation);
			return true;
		}
		if (
			nowMs - operation.startedAtMs >= RUNTIME_ACTIVATION_TIMEOUT_MS ||
			(workspace.runtimeBootTokenExpiresAtMs !== undefined &&
				workspace.runtimeBootTokenExpiresAtMs <= nowMs)
		) {
			// Rollback gets fresh authorization; expired/spent enrollment is never replayed.
			if (
				operation.phase !== "rolling-back" &&
				currentJournal?.previous?.signed === true &&
				currentJournal.previous.version !== null &&
				provider.inspectProcess !== undefined &&
				(yield* provider
					.inspectProcess(
						workspace.providerSandboxId,
						workspaceRuntimeProcessSelector(),
					)
					.pipe(
						Effect.timeout("5 seconds"),
						Effect.catch(() => Effect.succeed("unknown")),
					)) === "inactive"
			) {
				const boot = yield* issueWorkspaceRuntimeBoot(nowMs);
				const fence = nextCloudWorkspaceRuntimeFence(workspace);
				const rollback: RuntimeActivation = {
					...operation,
					phase: "rolling-back",
					generation: fence.runtimeGeneration,
					targetVersion: currentJournal.previous.version,
					startedAtMs: nowMs,
					attempts: 0,
				};
				const sealedBootToken = yield* sealRuntimeActivationBoot(
					workspace,
					rollback,
					boot.token,
				);
				yield* saveWorkspace({
					...workspace,
					state: "provisioning",
					runtimeState: "offline",
					statusCode: "runtime-update-rolling-back",
					runtimeCredentialHash: undefined,
					runtimeBootTokenHash: boot.tokenHash,
					runtimeBootTokenExpiresAtMs: boot.expiresAtMs,
					requestConfig: {
						...withoutRuntimeBootstrapReceipt(workspace.requestConfig),
						...fence,
						runtimeActivation: { ...rollback, sealedBootToken },
						runtimeSessionRecoveryPending: true,
					},
					nextActionAtMs: nowMs,
					updatedAtMs: nowMs,
					revision: workspace.revision + 1,
				});
				return true;
			}
			// A known incompatible or unprovable rollback needs action; keep the disk and the launch diagnosis.
			yield* save(
				{
					...operation,
					phase: "failed",
					lastErrorCode: "runtime-activation-unconfirmed",
				},
				{
					state: "failed",
					runtimeState: "offline",
					statusCode: "runtime-activation-unconfirmed",
				},
			);
			return true;
		}
		// Enrollment binds one process key pair. A consumed boot token cannot restart that process.
		if (
			workspace.runtimeBootTokenHash === undefined ||
			runtimeBootstrapReceiptFromConfig(workspace.requestConfig)?.generation ===
				operation.generation
		) {
			yield* save(operation);
			return true;
		}
		// Inspect the recorded allocation; missing storage never falls through to replacement.
		const sandbox = yield* provider.inspect(workspace.providerSandboxId);
		if (sandbox === null)
			return yield* new SandboxProviderError({ code: "not-found" });
		if (sandbox.state === "paused")
			yield* provider.resume(
				workspace.providerSandboxId,
				config.keepAliveTimeoutSeconds,
				"pause",
				workspaceSizeId(workspace),
			);
		// The adapter's persistent generation guard makes this idempotent after response loss.
		const token = yield* openRuntimeActivationBoot(workspace, operation);
		const input = yield* workspaceRuntimeLaunchInput(
			workspace,
			token,
			operation.bootstrap === true,
		);
		yield* prepareWorkspaceRuntimeLaunch(
			workspace,
			provider,
			workspace.providerSandboxId,
		);
		if (input === null) return true;
		yield* provider.replaceProcess(
			workspace.providerSandboxId,
			workspaceRuntimeProcessSelector(),
			activationProcessInput(
				input,
				operation,
				operation.phase === "rolling-back" ? "rollback" : "activate",
			),
		);
		const updated = { ...operation, attempts: operation.attempts + 1 };
		yield* saveWorkspace({
			...workspace,
			requestConfig: { ...workspace.requestConfig, runtimeActivation: updated },
			nextActionAtMs: runtimeActivationRetryAt(updated, nowMs),
			updatedAtMs: nowMs,
			revision: workspace.revision + 1,
		});
		return true;
	},
);

const restartWorkspaceRuntime = Effect.fn("restartCloudWorkspaceRuntime")(
	function* (
		workspace: CloudWorkspaceRecord,
		providerSandboxId: string,
		provider: SandboxProviderAdapter,
		nowMs: number,
		saveWorkspace: SaveClaimedWorkspace,
		providerAlreadyRunning?: boolean,
	) {
		cloudTimingEvent(
			{
				workspaceId: workspace.workspaceId,
				provider: provider.providerId,
				reason:
					workspace.requestConfig.cloudMailboxFenceRequired === true
						? "mailbox-fence-required"
						: !provider.preservesProcessesOnResume
							? "provider-does-not-preserve-processes"
							: workspace.statusCode === "restart-queued"
								? "explicit-restart"
								: workspace.state === "resuming"
									? "warm-reconnect-not-observed"
									: !workspaceSupportsCloudCommandMailbox(workspace)
										? "runtime-upgrade-or-recovery"
										: "mailbox-stalled-or-runtime-recovery",
			},
			"runtime.restart-decision",
		);
		const store = yield* CloudWorkspaceStore;
		const config = yield* SandboxOfferConfiguration;
		const project = yield* store.getProject(workspace.projectId);
		if (project === null) return;

		const running =
			typeof providerAlreadyRunning === "boolean"
				? providerAlreadyRunning
				: yield* provider
						.inspect(providerSandboxId)
						.pipe(
							Effect.flatMap((sandbox) =>
								sandbox === null
									? Effect.fail(new SandboxProviderError({ code: "not-found" }))
									: Effect.succeed(sandbox.state === "running"),
							),
						);
		if (!running)
			yield* provider
				.resume(
					providerSandboxId,
					config.keepAliveTimeoutSeconds,
					"pause",
					workspaceSizeId(workspace),
				)
				.pipe(
					measureCloudStage(
						{
							workspaceId: workspace.workspaceId,
							provider: provider.providerId,
						},
						"provider.resume",
					),
				);
		// A runtime-only restart does not call resume, so renew its existing
		// machine lease before downloading or authenticating the runtime.
		if (running)
			yield* provider.extendTimeout(
				providerSandboxId,
				config.keepAliveTimeoutSeconds,
			);
		// An "online" row may describe a dead consumer until its heartbeat expires.
		// Probe once recovery has already decided to replace it; never delay a
		// required mailbox fence. Provider and disk state stay untouched.
		if (running && workspace.requestConfig.cloudMailboxFenceRequired !== true) {
			const health = yield* readCloudMemory(
				provider,
				providerSandboxId,
				workspace.requestConfig.runtimeGeneration,
			);
			const previousStart = workspace.requestConfig.memoryRecoveryStartedAt;
			const inWindow =
				typeof previousStart === "number" &&
				nowMs - previousStart < MEMORY_RECOVERY_WINDOW_MS;
			const startedAt = inWindow ? previousStart : nowMs;
			const previousAttempts = workspace.requestConfig.memoryRecoveryAttempts;
			const attempts =
				inWindow && typeof previousAttempts === "number" ? previousAttempts : 0;
			const waiting = workspace.statusCode === "runtime-memory-pressure";
			const underPressure =
				health.memory?.pressure === true || (waiting && health.memory === null);
			const previousPressureSince = workspace.requestConfig.memoryPressureSince;
			const pressureSince =
				waiting && typeof previousPressureSince === "number"
					? previousPressureSince
					: nowMs;
			workspace = {
				...workspace,
				requestConfig: {
					...workspace.requestConfig,
					memoryPressureSince: underPressure ? pressureSince : undefined,
				},
			};
			if (underPressure || health.oom) {
				const exhausted =
					attempts >= MAX_MEMORY_RESTARTS ||
					(underPressure && nowMs - pressureSince >= MEMORY_PRESSURE_WAIT_MS);
				const requestConfig = {
					...workspace.requestConfig,
					...(health.oom
						? {
								memoryRecoveryStartedAt: startedAt,
								memoryRecoveryAttempts:
									attempts + (underPressure || exhausted ? 0 : 1),
							}
						: {}),
				};
				if (underPressure || exhausted) {
					yield* saveWorkspace({
						...workspace,
						requestConfig,
						state: exhausted ? "failed" : "resuming",
						statusCode: exhausted
							? "runtime-memory-recovery-failed"
							: "runtime-memory-pressure",
						nextActionAtMs: exhausted
							? Number.MAX_SAFE_INTEGER
							: nowMs + MEMORY_RECHECK_MS,
						revision: workspace.revision + 1,
						updatedAtMs: nowMs,
					});
					return;
				}
				workspace = {
					...workspace,
					requestConfig,
					statusCode: "runtime-memory-recovering",
				};
			}
		}
		yield* prepareWorkspaceRuntimeLaunch(
			workspace,
			provider,
			providerSandboxId,
		);
		if (provider.supportsFencedProcessReplacement !== true) {
			yield* saveWorkspace({
				...workspace,
				statusCode: "runtime-guard-unavailable",
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			});
			return;
		}
		let operation = runtimeActivation(workspace);
		const existingJournal =
			operation !== null && operation.mode !== "restart-installed"
				? yield* readRuntimeActivationJournal(provider, workspace)
				: null;
		const pendingReleaseRecovery =
			operation !== null &&
			operation.mode !== "restart-installed" &&
			operation.targetVersion !== undefined &&
			(operation.phase === "failed" ||
				operation.phase === "verification-needed") &&
			existingJournal?.transactionId === operation.id &&
			existingJournal.phase !== "confirmed";
		const transactional =
			workspace.requestConfig.runtimeReleaseChangeRequested === true ||
			pendingReleaseRecovery ||
			(operation !== null &&
				operation.mode !== "restart-installed" &&
				(operation.phase === "preparing" ||
					operation.phase === "launching" ||
					operation.phase === "rolling-back"));
		if (
			transactional &&
			(config.runtimeInstallerSource === undefined ||
				config.runtimeManifestUrl === undefined)
		) {
			yield* saveWorkspace({
				...workspace,
				statusCode: "runtime-update-unavailable",
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			});
			return;
		}
		if (transactional) {
			if (
				(operation?.phase === "failed" ||
					operation?.phase === "verification-needed") &&
				existingJournal?.transactionId === operation.id &&
				existingJournal.phase !== "confirmed"
			) {
				const rollingBack =
					existingJournal.phase === "rolling-back" ||
					existingJournal.phase === "rolled-back";
				operation = {
					...operation,
					phase: rollingBack ? "rolling-back" : "launching",
					targetVersion: rollingBack
						? (existingJournal.previous?.version ?? operation.targetVersion)
						: existingJournal.candidate.version,
					startedAtMs: nowMs,
					attempts: 0,
				};
			} else if (
				operation === null ||
				operation.phase === "confirmed" ||
				operation.phase === "failed" ||
				operation.phase === "verification-needed"
			) {
				operation = {
					id: crypto.randomUUID(),
					mode: "change-release",
					phase: "preparing",
					startedAtMs: nowMs,
					attempts: 0,
				};
				yield* provider.writeTextFile(
					providerSandboxId,
					RUNTIME_ACTIVATION_INSTALLER,
					config.runtimeInstallerSource ?? "",
					cloudWorkspaceLayout(workspace).user,
				);
				yield* saveWorkspace({
					...workspace,
					state: workspace.state === "ready" ? "ready" : "resuming",
					statusCode: "runtime-update-preparing",
					requestConfig: {
						...workspace.requestConfig,
						runtimeReleaseChangeRequested: undefined,
						runtimeActivation: operation,
					},
					nextActionAtMs: nowMs + RUNTIME_ACTIVATION_RETRY_MS,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				});
				yield* provider.startProcess(providerSandboxId, {
					command: "/bin/bash",
					args: [
						"-lc",
						`node ${RUNTIME_ACTIVATION_INSTALLER} --prepare >> /var/lib/zuse/workspace/runtime.log 2>&1`,
					],
					cwd: cloudWorkspaceLayout(workspace).home,
					user: cloudWorkspaceLayout(workspace).user,
					tag: `zuse-runtime-prepare-${operation.id}`,
					env: {
						...runtimeUpdateEnvironment(
							config,
							cloudWorkspaceLayout(workspace).snapshot,
						),
						ZUSE_RUNTIME_UPDATE_TRANSACTION_ID: operation.id,
						ZUSE_RUNTIME_SKIP_TOOLCHAIN: "1",
					},
				});
				return;
			}
			if (operation.phase === "preparing") {
				if (
					existingJournal?.transactionId !== operation.id ||
					existingJournal.phase !== "prepared"
				)
					return;
				operation = {
					...operation,
					phase: "launching",
					targetVersion: existingJournal.candidate.version,
					startedAtMs: nowMs,
				};
			}
		}
		if (!transactional) {
			operation = {
				id: crypto.randomUUID(),
				mode: "restart-installed",
				phase: "launching",
				startedAtMs: nowMs,
				attempts: 0,
			};
		}
		const boot = yield* issueWorkspaceRuntimeBoot(nowMs);
		const preparedAtMs = yield* Clock.currentTimeMillis;
		const timings =
			(workspace.requestConfig.startupTimings as
				| Readonly<Record<string, number>>
				| undefined) ?? {};
		const runtimeFence = nextCloudWorkspaceRuntimeFence(workspace);
		if (operation !== null) {
			operation = { ...operation, generation: runtimeFence.runtimeGeneration };
			operation = {
				...operation,
				sealedBootToken: yield* sealRuntimeActivationBoot(
					workspace,
					operation,
					boot.token,
				),
			};
		}
		// Authorize the boot token before starting the detached runtime. Repeated
		// resume requests cannot replace it while startup is in flight.
		const authorizedWorkspace: CloudWorkspaceRecord = {
			...workspace,
			runtimeBootTokenHash: boot.tokenHash,
			runtimeBootTokenExpiresAtMs: boot.expiresAtMs,
			runtimeCredentialHash: undefined,
			runtimeState: "offline",
			state: "provisioning",
			statusCode:
				workspace.statusCode === "runtime-memory-recovering"
					? "runtime-memory-recovering"
					: "resume-runtime-restarting",
			requestConfig: {
				...resetMailboxWakeObservation(
					withoutRuntimeBootstrapReceipt(workspace.requestConfig),
					preparedAtMs,
				),
				...runtimeFence,
				runtimeActivation: operation,
				runtimeReleaseChangeRequested: undefined,
				runtimeSessionRecoveryPending: true,
				runtimeInstallPending: transactional,
				runtimeLaunchRecoveryAttempts:
					workspace.statusCode === "resume-runtime-restarting"
						? (workspace.requestConfig.runtimeLaunchRecoveryAttempts ?? 0)
						: 0,
				startupTimings: { ...timings, allocatedAt: preparedAtMs },
			},
			nextActionAtMs: preparedAtMs + RUNTIME_ACTIVATION_RETRY_MS,
			lastActivityAtMs: preparedAtMs,
			runningSinceMs: nowMs,
			revision: workspace.revision + 1,
			updatedAtMs: preparedAtMs,
		};
		yield* saveWorkspace(authorizedWorkspace);
		const input = yield* workspaceRuntimeLaunchInput(
			authorizedWorkspace,
			boot.token,
		);
		if (input === null) return;
		yield* provider
			.replaceProcess(
				providerSandboxId,
				workspaceRuntimeProcessSelector(),
				operation !== null
					? activationProcessInput(
							input,
							operation,
							operation.phase === "rolling-back" ? "rollback" : "activate",
						)
					: input,
			)
			.pipe(
				measureCloudStage(
					{ workspaceId: workspace.workspaceId, provider: provider.providerId },
					"runtime.replace",
				),
			);
	},
);

const reconcileWorkspaceRecord = Effect.fn("reconcileCloudWorkspace")(
	function* (
		workspace: CloudWorkspaceRecord,
		saveWorkspace: SaveClaimedWorkspace,
	) {
		const store = yield* CloudWorkspaceStore;
		const provider = yield* resolveResourceProvider(workspace);
		const config = yield* SandboxOfferConfiguration;
		const apiConfig = yield* ApiConfiguration;
		const nowMs = yield* Clock.currentTimeMillis;
		const destructiveLifecycle = destructiveMailboxLifecycle(workspace);
		if (
			workspace.requestConfig.forkNetworkRestorePending === true &&
			workspace.providerSandboxId !== undefined
		) {
			yield* provider.setNetwork(workspace.providerSandboxId, { kind: "open" });
			yield* saveWorkspace({
				...workspace,
				requestConfig: {
					...workspace.requestConfig,
					forkNetworkRestorePending: undefined,
				},
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
				nextActionAtMs: nowMs,
			});
			return;
		}
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
			providerSandboxId: workspace.providerSandboxId,
			runningSinceMs: workspace.runningSinceMs,
			nowMs,
			...resolveSandboxResources(provider, workspaceSizeId(workspace)),
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
				yield* recordLifecycle(workspace, "lifecycle-elapsed-seconds", nowMs);
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
			workspace.desiredState === "ready" &&
			runtimeActivation(workspace) !== null
		) {
			if (
				yield* reconcileRuntimeActivation(
					workspace,
					provider,
					nowMs,
					saveWorkspace,
				)
			)
				return;
			if (
				runtimeActivation(workspace)?.phase === "preparing" &&
				workspace.providerSandboxId !== undefined
			)
				return yield* restartWorkspaceRuntime(
					workspace,
					workspace.providerSandboxId,
					provider,
					nowMs,
					saveWorkspace,
				);
		}

		if (
			workspace.desiredState === "ready" &&
			workspace.requestConfig.runtimeReleaseChangeRequested === true &&
			workspace.providerSandboxId !== undefined
		) {
			return yield* restartWorkspaceRuntime(
				workspace,
				workspace.providerSandboxId,
				provider,
				nowMs,
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
			if (sandbox.state === "paused" && !provider.preservesProcessesOnResume)
				return yield* restartWorkspaceRuntime(
					workspace,
					workspace.providerSandboxId,
					provider,
					nowMs,
					saveWorkspace,
					false,
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
			const machineFork = machineForkSource(workspace);
			const build = yield* store.getBuild(workspace.buildId);
			const project = yield* store.getProject(workspace.projectId);
			if (build === null || project === null) return;
			const label = providerLabel("workspace", workspace.workspaceId);

			const replacingFailedSandbox =
				(workspace.statusCode === "resume-queued" ||
					workspace.statusCode === "resume-runtime-recovery-queued") &&
				workspace.providerSandboxId !== undefined;
			const preparedSnapshotAvailable =
				build.snapshotId !== undefined &&
				(importedSnapshot(build) ||
					build.templateVersion === provider.templateVersion);
			const allocate = Effect.gen(function* () {
				if (
					replacingFailedSandbox &&
					workspace.providerSandboxId !== undefined
				) {
					// A deleted account image must not cause recovery to destroy the existing disk.
					if (connectionIdFor(build) === undefined)
						yield* assertSnapshotUsable(
							workspace.accountId,
							build.provider,
							build.snapshotId,
						);
					yield* provider
						.kill(workspace.providerSandboxId)
						.pipe(withSnapshotLeaseCheck);
				}
				const recovered =
					!replacingFailedSandbox && machineFork === undefined
						? yield* provider.recoverByLabel(label).pipe(
								withSnapshotLeaseCheck,
								measureCloudStage(
									{
										workspaceId: workspace.workspaceId,
										provider: provider.providerId,
									},
									"provider.recoverByLabel",
								),
							)
						: null;
				if (
					recovered === null &&
					machineFork === undefined &&
					preparedSnapshotAvailable &&
					build.snapshotId !== undefined
				)
					if (connectionIdFor(build) === undefined)
						yield* assertSnapshotUsable(
							workspace.accountId,
							build.provider,
							build.snapshotId,
						);
				const sandbox =
					recovered ??
					(machineFork !== undefined
						? yield* forkCloudWorkspaceMachine(
								workspace,
								provider,
								label,
								config.keepAliveTimeoutSeconds,
							)
						: preparedSnapshotAvailable
							? yield* provider
									.fork({
										sandboxId: workspace.workspaceId,
										providerLabel: label,
										metadata: {
											"zuse-account-id": workspace.accountId,
											"zuse-resource-kind": "workspace",
											"zuse-project-id": workspace.projectId,
											"zuse-build-id": workspace.buildId,
											"zuse-workspace-id": workspace.workspaceId,
										},
										sizeId: workspaceSizeId(workspace),
										snapshotId: build.snapshotId as string,
										snapshotSource: importedSnapshot(build)
											? "custom-snapshot"
											: undefined,
										snapshotVersion:
											importedSnapshot(build) &&
											typeof build.settings?.snapshotVersion === "number"
												? build.settings.snapshotVersion
												: undefined,
										timeoutSeconds: config.keepAliveTimeoutSeconds,
										env: {},
										network: { kind: "open" },
										onTimeout: "pause",
									})
									.pipe(
										withSnapshotLeaseCheck,
										measureCloudStage(
											{
												workspaceId: workspace.workspaceId,
												provider: provider.providerId,
											},
											"provider.fork",
										),
									)
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
									sizeId: workspaceSizeId(workspace),
									timeoutSeconds: config.keepAliveTimeoutSeconds,
									env: {},
									network: { kind: "open" },
									onTimeout: "pause",
								}));
				return { sandbox, recovered };
			});
			// Fence deletion/promotion through the entire replacement and restore call.
			const { sandbox, recovered } =
				(replacingFailedSandbox || preparedSnapshotAvailable) &&
				connectionIdFor(build) === undefined
					? yield* withSnapshotLifecycleLock(
							workspace.accountId,
							build.provider,
							allocate,
							"shared",
						)
					: yield* allocate;
			// Persist the native child before preparation so failed forks can still be
			// inspected and deleted through the normal workspace lifecycle.
			const allocatedWorkspace =
				machineFork === undefined
					? workspace
					: {
							...workspace,
							providerSandboxId: sandbox.providerSandboxId,
							revision: workspace.revision + 1,
							updatedAtMs: yield* Clock.currentTimeMillis,
						};
			if (machineFork !== undefined) yield* saveWorkspace(allocatedWorkspace);
			// Allocation retries can recover a machine near its original TTL, or
			// one that already paused. Give bootstrap a fresh running window.
			if (sandbox.state === "paused")
				yield* provider.resume(
					sandbox.providerSandboxId,
					config.keepAliveTimeoutSeconds,
					"pause",
					workspaceSizeId(workspace),
				);
			else
				yield* provider.extendTimeout(
					sandbox.providerSandboxId,
					config.keepAliveTimeoutSeconds,
				);
			if (machineFork !== undefined) {
				if (workspace.provider !== "boxd" || provider.forkMachine === undefined)
					return yield* new SandboxProviderError({ code: "rejected" });
				// The native fork inherited host quarantine. Retire copied runtime
				// workers before rekeying; retain VM memory for other processes.
				yield* provider.setNetwork(sandbox.providerSandboxId, {
					kind: "quarantined",
				});
				const marker = `/var/lib/zuse/fork-source/${workspace.workspaceId}/prepared`;
				if (
					!(yield* provider.pathExists(
						sandbox.providerSandboxId,
						marker,
						cloudWorkspaceLayout(workspace).user,
					))
				) {
					yield* provider.replaceProcess(
						sandbox.providerSandboxId,
						workspaceRuntimeProcessSelector(),
						{
							command: "/bin/bash",
							args: [
								"-lc",
								`if [[ "\${ZUSE_SNAPSHOT_NATIVE:-}" == 1 ]]; then source /etc/zuse/snapshot.env; fi
${WORKSPACE_RUNTIME_SOURCE}
${WORKSPACE_FORK_PREPARE_SOURCE}`,
							],
							user: cloudWorkspaceLayout(workspace).user,
							env: {
								ZUSE_CLOUD_WORKSPACE_ID: workspace.workspaceId,
								...cloudWorkspaceLayoutEnvironment(workspace),
								ZUSE_FORK_CHAT_ID: machineFork.chatId,
								ZUSE_FORK_SESSION_ID: machineFork.sessionId,
								ZUSE_FORK_MESSAGE_ID: machineFork.messageId,
							},
						},
					);
					const deadline = (yield* Clock.currentTimeMillis) + 30_000;
					while (
						!(yield* provider.pathExists(
							sandbox.providerSandboxId,
							marker,
							cloudWorkspaceLayout(workspace).user,
						))
					) {
						if (
							yield* provider.pathExists(
								sandbox.providerSandboxId,
								marker.replace(/prepared$/, "failed"),
								cloudWorkspaceLayout(workspace).user,
							)
						)
							return yield* new SandboxProviderError({ code: "rejected" });
						if ((yield* Clock.currentTimeMillis) >= deadline)
							return yield* new SandboxProviderError({ code: "transient" });
						yield* Effect.sleep(Duration.millis(250));
					}
				}
			}
			const allocatedAtMs = yield* Clock.currentTimeMillis;
			const previousOperation = runtimeActivation(workspace);
			const replay =
				recovered !== null &&
				previousOperation?.bootstrap === true &&
				previousOperation.phase === "launching" &&
				previousOperation.generation ===
					workspace.requestConfig.runtimeGeneration
					? previousOperation
					: null;
			if (
				replay !== null &&
				(workspace.runtimeBootTokenHash === undefined ||
					workspace.runtimeBootTokenExpiresAtMs === undefined ||
					workspace.runtimeBootTokenExpiresAtMs <= allocatedAtMs ||
					runtimeBootstrapReceiptFromConfig(workspace.requestConfig)
						?.generation === replay.generation)
			) {
				// Recover allocation identity, never re-enroll an already bound process.
				yield* saveWorkspace({
					...allocatedWorkspace,
					providerSandboxId: sandbox.providerSandboxId,
					state: workspace.runtimeState === "online" ? "ready" : "provisioning",
					nextActionAtMs: allocatedAtMs,
					revision: allocatedWorkspace.revision + 1,
					updatedAtMs: allocatedAtMs,
				});
				return;
			}
			const boot =
				replay !== null &&
				workspace.runtimeBootTokenHash !== undefined &&
				workspace.runtimeBootTokenExpiresAtMs !== undefined
					? {
							token: yield* openRuntimeActivationBoot(workspace, replay),
							tokenHash: workspace.runtimeBootTokenHash,
							expiresAtMs: workspace.runtimeBootTokenExpiresAtMs,
						}
					: yield* issueWorkspaceRuntimeBoot(allocatedAtMs);
			const timings =
				(workspace.requestConfig.startupTimings as
					| Readonly<Record<string, number>>
					| undefined) ?? {};
			const runtimeFence =
				replay === null
					? nextCloudWorkspaceRuntimeFence(workspace)
					: {
							runtimeGeneration: Number(
								workspace.requestConfig.runtimeGeneration,
							),
							gatewayEpoch: Number(workspace.requestConfig.gatewayEpoch),
						};
			const operation: RuntimeActivation = replay ?? {
				id: crypto.randomUUID(),
				mode: "restart-installed",
				bootstrap: true,
				phase: "launching",
				generation: runtimeFence.runtimeGeneration,
				startedAtMs: allocatedAtMs,
				attempts: 0,
			};
			const sealedBootToken = yield* sealRuntimeActivationBoot(
				workspace,
				operation,
				boot.token,
			);

			const authorizedWorkspace: CloudWorkspaceRecord = {
				...allocatedWorkspace,
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
					runtimeActivation: { ...operation, sealedBootToken },
					runtimeInstallPending: false,
					...(typeof workspace.requestConfig.sessionHeadVersion === "number"
						? { runtimeSessionRecoveryPending: true }
						: {}),
					startupTimings: {
						...timings,
						allocatedAt: allocatedAtMs,
						...(recovered === null ? { forkedAt: allocatedAtMs } : {}),
					},
				},
				nextActionAtMs: allocatedAtMs + RUNTIME_ACTIVATION_RETRY_MS,
				revision: allocatedWorkspace.revision + 1,
				updatedAtMs: allocatedAtMs,
			};
			yield* saveWorkspace(authorizedWorkspace);
			yield* prepareWorkspaceRuntimeLaunch(
				authorizedWorkspace,
				provider,
				sandbox.providerSandboxId,
			);
			const runtimeOptions = yield* workspaceRuntimeLaunchInput(
				authorizedWorkspace,
				boot.token,
				true,
			);
			if (runtimeOptions === null) return;
			if (provider.supportsFencedProcessReplacement !== true) {
				return yield* new SandboxProviderError({
					code: "rejected",
					diagnostic: "guarded runtime launch unavailable",
				});
			}
			const startRuntime = provider.replaceProcess(
				sandbox.providerSandboxId,
				workspaceRuntimeProcessSelector(),
				activationProcessInput(runtimeOptions, operation),
			);
			yield* startRuntime;
			return;
		}

		if (
			workspace.state === "resuming" &&
			workspace.desiredState === "ready" &&
			workspace.providerSandboxId !== undefined
		) {
			// Direct maintenance calls also respect the durable warm reconnect deadline.
			if (
				(workspace.statusCode === "resume-runtime-waking" ||
					workspace.statusCode === "runtime-memory-pressure") &&
				nowMs < workspace.nextActionAtMs
			)
				return;
			if (workspace.statusCode === "resume-runtime-waking") {
				const observed =
					provider.inspectProcess === undefined
						? "unknown"
						: yield* provider.inspectProcess(
								workspace.providerSandboxId,
								workspaceRuntimeProcessSelector(),
								cloudWorkspaceLayout(workspace).user,
							);
				if (observed !== "inactive") {
					// An active or unobservable guest keeps its authority. Gateway loss
					// is not permission to stop a possibly healthy database writer.
					yield* saveWorkspace({
						...workspace,
						nextActionAtMs: nowMs + 30_000,
						updatedAtMs: nowMs,
					});
					return;
				}
			}
			return yield* restartWorkspaceRuntime(
				workspace,
				workspace.providerSandboxId,
				provider,
				nowMs,
				saveWorkspace,
			);
		}

		if (
			(workspace.state === "provisioning" || workspace.state === "setup") &&
			workspace.providerSandboxId !== undefined
		) {
			const startupTimedOut = workspaceStartupTimedOut(workspace, nowMs);
			const attempts = workspace.requestConfig.runtimeLaunchRecoveryAttempts;
			const recoveryAttempts =
				typeof attempts === "number" &&
				Number.isInteger(attempts) &&
				attempts >= 0
					? attempts
					: 0;
			const canRecoverLaunch =
				workspace.state === "provisioning" &&
				workspace.desiredState === "ready" &&
				workspace.statusCode === "resume-runtime-restarting" &&
				recoveryAttempts < 2;
			if (
				(!startupTimedOut || canRecoverLaunch) &&
				(yield* provider.pathExists(
					workspace.providerSandboxId,
					"/var/lib/zuse/workspace/failed",
					cloudWorkspaceLayout(workspace).user,
				))
			) {
				const runtimeDiagnostic = yield* readWorkspaceRuntimeDiagnostic(
					provider,
					workspace.providerSandboxId,
				);
				const reportedFailurePhase = yield* provider
					.readTextFile(
						workspace.providerSandboxId,
						"/var/lib/zuse/workspace/failure-phase",
						cloudWorkspaceLayout(workspace).user,
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

			if (startupTimedOut) {
				// Authorizing a new generation and launching its process are separate
				// operations. A failed request or interrupted worker can leave the
				// authorized generation unlaunched. Retry on the same disk, with a
				// fresh fence, rather than permanently stranding the saved session.
				if (canRecoverLaunch) {
					return yield* restartWorkspaceRuntime(
						{
							...workspace,
							requestConfig: {
								...workspace.requestConfig,
								runtimeLaunchRecoveryAttempts: recoveryAttempts + 1,
							},
						},
						workspace.providerSandboxId,
						provider,
						nowMs,
						saveWorkspace,
					);
				}
				// Do not issue provider commands after the deadline: an archiving
				// sandbox rejects them and would otherwise hide this terminal state.
				console.warn("[cloud-workspace] runtime connection timeout", {
					workspaceId: workspace.workspaceId,
					statusCode: workspace.statusCode,
				});
				yield* saveWorkspace({
					...workspace,
					state: "failed",
					statusCode:
						workspace.statusCode === "runtime-memory-recovering"
							? "runtime-memory-recovery-failed"
							: "runtime-connection-timeout",
					runtimeState: "offline",
					runtimeCredentialHash: undefined,
					runtimeBootTokenHash: undefined,
					runtimeBootTokenExpiresAtMs: undefined,
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

		// Enforce the idle deadline before repairing an offline runtime.
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
				!provider.preservesProcessesOnResume ||
				(apiConfig.cloudCommandMailboxEnabled &&
					!workspaceSupportsCloudCommandMailbox(workspace))
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

export const reconcileCloudResourceBatch = <Item, Error, Requirements>(input: {
	readonly resourceKind: "build" | "workspace";
	readonly items: ReadonlyArray<Item>;
	readonly resourceId: (item: Item) => string;
	readonly concurrency: number;
	readonly reconcile: (
		item: Item,
	) => Effect.Effect<unknown, Error, Requirements>;
}): Effect.Effect<void, never, Requirements> =>
	Effect.forEach(
		input.items,
		(item) =>
			input.reconcile(item).pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						console.error("[cloud-workspace] isolated reconciliation failure", {
							resourceKind: input.resourceKind,
							resourceId: input.resourceId(item),
							cause: Cause.pretty(cause),
						});
					}),
				),
			),
		{ concurrency: input.concurrency, discard: true },
	);

export const reconcileCloudResources = Effect.fn("reconcileCloudResources")(
	function* () {
		const store = yield* CloudWorkspaceStore;
		const nowMs = yield* Clock.currentTimeMillis;
		const builds = yield* store.listDueBuilds(nowMs, 10);
		const workspaces = yield* store.listDueWorkspaces(nowMs, 25);
		yield* reconcileCloudResourceBatch({
			resourceKind: "build",
			items: builds,
			resourceId: (build) => build.buildId,
			concurrency: 2,
			reconcile: (build) => reconcileCloudBuild(build.buildId),
		});
		yield* reconcileCloudResourceBatch({
			resourceKind: "workspace",
			items: workspaces,
			resourceId: (workspace) => workspace.workspaceId,
			concurrency: 5,
			reconcile: (workspace) => reconcileCloudWorkspace(workspace.workspaceId),
		});
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
		// Native forks include readiness and a stopped-writer import preparation.
		const pending = yield* store.getWorkspace(workspaceId);
		const leaseMs =
			pending?.requestConfig.machineFork === undefined
				? RECONCILE_LEASE_MS
				: 10 * 60_000;
		const workspace = yield* store.claimWorkspace(
			workspaceId,
			leaseOwner,
			nowMs,
			nowMs + leaseMs,
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
			Effect.catchTag("ApiError", (error) =>
				Effect.gen(function* () {
					const failedAtMs = yield* Clock.currentTimeMillis;
					const unavailable = error.code === "cloud_provider_unavailable";
					yield* saveWorkspace({
						...currentWorkspace,
						...(unavailable
							? { state: "failed" as const, runtimeState: "offline" as const }
							: {}),
						statusCode: unavailable
							? "provider-unavailable"
							: "provider-connection-unavailable",
						nextActionAtMs: unavailable
							? Number.MAX_SAFE_INTEGER
							: failedAtMs + RETRY_MS,
						revision: currentWorkspace.revision + 1,
						updatedAtMs: failedAtMs,
					});
				}),
			),
			Effect.catchTag("ProviderSelectionError", () =>
				Effect.gen(function* () {
					const failedAtMs = yield* Clock.currentTimeMillis;
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
							statusCode: `${destructiveLifecycle}-${error.code === "rejected" ? "rejected" : "retrying"}`,
							nextActionAtMs:
								error.code === "rejected"
									? Number.MAX_SAFE_INTEGER
									: error.code === "not-found"
										? failedAtMs
										: failedAtMs + RETRY_MS,
							revision: currentWorkspace.revision + 1,
							updatedAtMs: failedAtMs,
						});
						return;
					}
					if (error.code === "not-found") {
						if (cloudWorkspaceHasRetainedRuntimeData(currentWorkspace)) {
							yield* saveWorkspace({
								...currentWorkspace,
								providerSandboxId: undefined,
								runtimeBootTokenHash: undefined,
								runtimeBootTokenExpiresAtMs: undefined,
								runtimeCredentialHash: undefined,
								state: "failed",
								desiredState: "ready",
								statusCode: "runtime-storage-replaced",
								runtimeState: "offline",
								requestConfig: {
									...currentWorkspace.requestConfig,
									runtimeSessionRecoveryPending: true,
									launchErrorCode: "runtime-storage-replaced",
								},
								nextActionAtMs: Number.MAX_SAFE_INTEGER,
								revision: currentWorkspace.revision + 1,
								updatedAtMs: failedAtMs,
							});
							return;
						}
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
							...(error.diagnostic === undefined
								? {}
								: {
										requestConfig: {
											...currentWorkspace.requestConfig,
											startupFailureDiagnostic: sanitizeProjectBuildDiagnostic(
												error.diagnostic,
											),
										},
									}),
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

/** Run one durable step and return its authoritative continuation; HTTP only dispatches. */
export const reconcileCloudWorkspaceStartup = Effect.fn(
	"reconcileCloudWorkspaceStartup",
)(function* (
	workspaceId: string,
	scheduleStartup?: (workspaceId: string) => Promise<void>,
) {
	const store = yield* CloudWorkspaceStore;
	if (scheduleStartup) {
		const workspace = yield* store.getWorkspace(workspaceId);
		if (workspace === null) return { kind: "complete" } as const;
		yield* Effect.promise(() => scheduleStartup(workspaceId));
		return { kind: "due", dueAtMs: workspace.nextActionAtMs } as const;
	}
	const before = yield* store.getWorkspace(workspaceId);
	const nowMs = yield* Clock.currentTimeMillis;
	if (before !== null && before.nextActionAtMs <= nowMs) {
		yield* reconcileCloudWorkspace(workspaceId);
	}
	const workspace = yield* store.getWorkspace(workspaceId);
	return workspaceStartupOutcome(workspace, yield* Clock.currentTimeMillis);
});
