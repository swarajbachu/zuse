import type {
	CloudProjectBuildState,
	CloudProjectState,
	CloudWorkspaceDesiredState,
	CloudWorkspaceState,
} from "@zuse/contracts";
import { Context, Effect, Layer, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

export interface CloudProjectRecord {
	readonly projectId: string;
	readonly accountId: string;
	readonly repositoryIdentity: string;
	readonly repositoryUrl: string;
	readonly displayName: string;
	readonly defaultBranch: string;
	readonly visibility: "public" | "private";
	readonly gitConnectionKind: "github-app";
	readonly cloudEnvironment: Readonly<Record<string, string>>;
	readonly secretBindings: ReadonlyArray<string>;
	readonly configurationDigest: string;
	readonly state: CloudProjectState;
	readonly included?: boolean;
	readonly lastErrorCode?: string;
	readonly idempotencyKey: string;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

export interface CloudGithubInstallationRecord {
	readonly accountId: string;
	readonly installationId: number;
	readonly githubAccountId: number;
	readonly accountLogin: string;
	readonly accountType: "User" | "Organization";
	readonly avatarUrl?: string;
	readonly repositorySelection: "all" | "selected";
	readonly suspended: boolean;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

export interface CloudProjectBuildRecord {
	readonly buildId: string;
	readonly projectId: string;
	readonly accountId: string;
	readonly provider: string;
	readonly providerSandboxId?: string;
	readonly snapshotId?: string;
	readonly sourceCommit?: string;
	readonly templateVersion: string;
	readonly configurationDigest: string;
	readonly settings?: Readonly<Record<string, unknown>>;
	readonly logText?: string;
	readonly state: CloudProjectBuildState;
	readonly lastErrorCode?: string;
	readonly idempotencyKey: string;
	readonly nextActionAtMs: number;
	readonly leaseOwner?: string;
	readonly leaseExpiresAtMs?: number;
	readonly revision: number;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

export interface CloudWorkspacePoolRecord {
	readonly poolId: string;
	readonly accountId: string;
	readonly provider: string;
	readonly imageGeneration: string;
	readonly providerSandboxId: string;
	readonly state: "available" | "claimed" | "deleting";
	readonly claimedWorkspaceId?: string;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

export interface CloudWorkspaceRecord {
	readonly workspaceId: string;
	readonly accountId: string;
	readonly projectId: string;
	readonly buildId: string;
	readonly provider: string;
	readonly providerSandboxId?: string;
	readonly runtimeBootTokenHash?: string;
	readonly runtimeBootTokenExpiresAtMs?: number;
	readonly runtimeCredentialHash?: string;
	readonly runtimeState: "offline" | "connecting" | "online";
	readonly chatId: string;
	readonly initialSessionId: string;
	readonly branch: string;
	readonly baseRef: string;
	readonly state: CloudWorkspaceState;
	readonly desiredState: CloudWorkspaceDesiredState;
	readonly statusCode: string;
	readonly wrappedTranscriptKey?: string;
	readonly archiveRequestedAtMs?: number;
	readonly archiveDeleteAtMs?: number;
	readonly deletionTombstoneExpiresAtMs?: number;
	readonly idempotencyKey: string;
	readonly requestConfig: Readonly<Record<string, unknown>>;
	readonly nextActionAtMs: number;
	readonly leaseOwner?: string;
	readonly leaseExpiresAtMs?: number;
	readonly revision: number;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
	readonly lastActivityAtMs: number;
	readonly runningSinceMs?: number;
	readonly deletedAtMs?: number;
}

export interface CloudWorkspaceLaunchIntentRecord {
	readonly workspaceId: string;
	readonly accountId: string;
	readonly chatId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly commandId: string;
	readonly ciphertext: string;
	readonly expiresAtMs: number;
	readonly createdAtMs: number;
}

/**
 * The only session-derived state retained by API after runtime bootstrap.
 * It is metadata-only and fenced independently from workspace lifecycle
 * revisions so reconciler writes cannot regress a newer runtime summary.
 */
export interface CloudWorkspaceRuntimeSummaryRecord {
	readonly workspaceId: string;
	readonly runtimeGeneration: number;
	readonly summaryRevision: number;
	readonly title: string;
	readonly lastActivityAtMs: number;
	readonly sessionHeadVersion: number;
	readonly updatedAtMs: number;
}

export interface CloudTranscriptCheckpointRecord {
	readonly workspaceId: string;
	readonly sessionId: string;
	readonly runtimeGeneration: number;
	readonly streamEpoch: string;
	readonly streamVersion: number;
	readonly objectKey: string;
	readonly ciphertextSha256: string;
	readonly ciphertextBytes: number;
	readonly createdAtMs: number;
}

export type RuntimeSummaryWriteOutcome =
	| {
			readonly kind: "applied";
			readonly summary: CloudWorkspaceRuntimeSummaryRecord;
	  }
	| {
			readonly kind: "stale";
			readonly summary: CloudWorkspaceRuntimeSummaryRecord;
	  }
	| { readonly kind: "rejected-generation" }
	| { readonly kind: "workspace-missing" };

export type CompleteLaunchIntentOutcome =
	| { readonly kind: "completed"; readonly workspace: CloudWorkspaceRecord }
	| { readonly kind: "rejected" }
	| { readonly kind: "workspace-missing" };

export interface CompleteLaunchIntentInput {
	readonly workspaceId: string;
	readonly commandId: string;
	readonly sessionHeadVersion: number;
	readonly nowMs: number;
	readonly nextActionAtMs: number;
}

export interface RuntimeCredentialRenewalReceipt {
	readonly workspaceId: string;
	readonly requestId: string;
	readonly credentialHash: string;
	readonly previousCredentialHash: string;
	readonly expiresAtMs: number;
	readonly generation: number;
	readonly gatewayEpoch: number;
}

const RuntimeBootstrapReceiptSchema = Schema.Struct({
	workspaceId: Schema.String,
	bootTokenHash: Schema.String,
	credentialKeyThumbprint: Schema.String,
	signingKeyThumbprint: Schema.String,
	signingPublicJwk: Schema.String,
	runtimeCredentialHash: Schema.String,
	runtimeCredentialExpiresAtMs: Schema.Number,
	generation: Schema.Number,
	gatewayEpoch: Schema.Number,
	sealedTranscriptKey: Schema.String,
	enrolledAtMs: Schema.Number,
	acknowledgedAtMs: Schema.optional(Schema.Number),
});

export type RuntimeBootstrapReceipt = typeof RuntimeBootstrapReceiptSchema.Type;

export const runtimeBootstrapReceiptFromConfig = (
	config: Readonly<Record<string, unknown>>,
): RuntimeBootstrapReceipt | null => {
	const decoded = Schema.decodeUnknownOption(RuntimeBootstrapReceiptSchema)(
		config.runtimeBootstrapReceipt,
	);
	return decoded._tag === "Some" ? decoded.value : null;
};

export type RuntimeBootstrapEnrollmentOutcome = {
	readonly kind: "created" | "replay";
	readonly workspace: CloudWorkspaceRecord;
	readonly receipt: RuntimeBootstrapReceipt;
	readonly launchIntent: CloudWorkspaceLaunchIntentRecord | null;
};

export interface RuntimeBootstrapEnrollmentInput {
	readonly workspaceId: string;
	readonly bootTokenHash: string;
	readonly credentialKeyThumbprint: string;
	readonly signingKeyThumbprint: string;
	readonly signingPublicJwk: string;
	readonly runtimeCredentialHash: string;
	readonly runtimeCredentialExpiresAtMs: number;
	readonly generation: number;
	readonly gatewayEpoch: number;
	readonly sealedTranscriptKey: string;
	readonly nowMs: number;
}

export interface RuntimeBootstrapAcknowledgementInput {
	readonly workspaceId: string;
	readonly currentCredentialHash: string;
	readonly generation: number;
	readonly gatewayEpoch: number;
	readonly nowMs: number;
}

const renewalReceiptFromConfig = (
	workspaceId: string,
	receipt: Record<string, unknown>,
): RuntimeCredentialRenewalReceipt => ({
	workspaceId,
	requestId: String(receipt.requestId),
	credentialHash: String(receipt.credentialHash),
	previousCredentialHash: String(receipt.previousCredentialHash),
	expiresAtMs: Number(receipt.expiresAtMs),
	generation: Number(receipt.generation),
	gatewayEpoch: Number(receipt.gatewayEpoch),
});

export type CreateCloudWorkspaceOutcome =
	| {
			readonly kind: "created" | "existing";
			readonly workspace: CloudWorkspaceRecord;
	  }
	| {
			readonly kind: "branch-in-use";
			readonly workspace: CloudWorkspaceRecord;
	  };

export interface CloudWorkspaceStoreApi {
	readonly listGithubInstallations: (
		accountId: string,
	) => Effect.Effect<ReadonlyArray<CloudGithubInstallationRecord>>;
	readonly saveGithubInstallation: (
		installation: CloudGithubInstallationRecord,
	) => Effect.Effect<void>;
	readonly removeGithubInstallation: (
		accountId: string,
		installationId: number,
	) => Effect.Effect<void>;
	readonly connectProject: (
		project: CloudProjectRecord,
	) => Effect.Effect<CloudProjectRecord>;
	readonly listProjects: (
		accountId: string,
	) => Effect.Effect<ReadonlyArray<CloudProjectRecord>>;
	readonly getProject: (
		projectId: string,
	) => Effect.Effect<CloudProjectRecord | null>;
	readonly saveProject: (project: CloudProjectRecord) => Effect.Effect<void>;
	readonly removeProject: (
		projectId: string,
		nowMs: number,
	) => Effect.Effect<CloudProjectRecord | null>;
	readonly createBuild: (
		build: CloudProjectBuildRecord,
	) => Effect.Effect<CloudProjectBuildRecord>;
	readonly getActiveBuild: (
		projectId: string,
		provider: string,
	) => Effect.Effect<CloudProjectBuildRecord | null>;
	readonly getActiveAccountBuild: (
		accountId: string,
		provider: string,
	) => Effect.Effect<CloudProjectBuildRecord | null>;
	readonly listAccountBuilds: (
		accountId: string,
		provider: string,
	) => Effect.Effect<ReadonlyArray<CloudProjectBuildRecord>>;
	readonly getBuild: (
		buildId: string,
	) => Effect.Effect<CloudProjectBuildRecord | null>;
	readonly claimBuild: (
		buildId: string,
		leaseOwner: string,
		nowMs: number,
		leaseExpiresAtMs: number,
	) => Effect.Effect<CloudProjectBuildRecord | null>;
	readonly listBuilds: (
		projectId: string,
	) => Effect.Effect<ReadonlyArray<CloudProjectBuildRecord>>;
	readonly saveBuild: (build: CloudProjectBuildRecord) => Effect.Effect<void>;
	readonly listDueBuilds: (
		nowMs: number,
		limit: number,
	) => Effect.Effect<ReadonlyArray<CloudProjectBuildRecord>>;
	readonly listPool: (
		accountId: string,
		provider: string,
	) => Effect.Effect<ReadonlyArray<CloudWorkspacePoolRecord>>;
	readonly savePool: (record: CloudWorkspacePoolRecord) => Effect.Effect<void>;
	readonly claimPool: (
		accountId: string,
		provider: string,
		imageGeneration: string,
		workspaceId: string,
		nowMs: number,
	) => Effect.Effect<CloudWorkspacePoolRecord | null>;
	readonly removePool: (poolId: string) => Effect.Effect<void>;
	readonly createWorkspace: (
		workspace: CloudWorkspaceRecord,
		launchIntent: CloudWorkspaceLaunchIntentRecord,
	) => Effect.Effect<CreateCloudWorkspaceOutcome>;
	readonly listWorkspaces: (
		accountId: string,
		projectId?: string,
	) => Effect.Effect<ReadonlyArray<CloudWorkspaceRecord>>;
	readonly getWorkspace: (
		workspaceId: string,
	) => Effect.Effect<CloudWorkspaceRecord | null>;
	readonly claimWorkspace: (
		workspaceId: string,
		leaseOwner: string,
		nowMs: number,
		leaseExpiresAtMs: number,
	) => Effect.Effect<CloudWorkspaceRecord | null>;
	readonly saveWorkspace: (
		workspace: CloudWorkspaceRecord,
	) => Effect.Effect<void>;
	readonly getWorkspaceLifecycleCommand: (
		workspaceId: string,
		commandId: string,
	) => Effect.Effect<string | null>;
	readonly saveWorkspaceLifecycleCommand: (input: {
		readonly workspace: CloudWorkspaceRecord;
		readonly commandId: string;
		readonly action: string;
		readonly createdAtMs: number;
	}) => Effect.Effect<void>;
	readonly saveClaimedWorkspace: (input: {
		readonly workspace: CloudWorkspaceRecord;
		readonly leaseOwner: string;
		readonly expectedRevision: number;
		readonly expectedUpdatedAtMs: number;
	}) => Effect.Effect<boolean>;
	readonly releaseWorkspaceLease: (
		workspaceId: string,
		leaseOwner: string,
	) => Effect.Effect<boolean>;
	readonly getLaunchIntent: (
		workspaceId: string,
		nowMs: number,
	) => Effect.Effect<CloudWorkspaceLaunchIntentRecord | null>;
	readonly deleteLaunchIntent: (workspaceId: string) => Effect.Effect<void>;
	readonly completeLaunchIntent: (
		input: CompleteLaunchIntentInput,
	) => Effect.Effect<CompleteLaunchIntentOutcome>;
	readonly enrollRuntimeBoot: (
		input: RuntimeBootstrapEnrollmentInput,
	) => Effect.Effect<RuntimeBootstrapEnrollmentOutcome | null>;
	readonly markRuntimeRepositoryReady: (input: {
		readonly workspaceId: string;
		readonly currentCredentialHash: string;
		readonly nowMs: number;
		readonly nextIdleAtMs: number;
	}) => Effect.Effect<CloudWorkspaceRecord | null>;
	readonly acknowledgeRuntimeBoot: (
		input: RuntimeBootstrapAcknowledgementInput,
	) => Effect.Effect<boolean>;
	readonly renewRuntimeCredential: (input: {
		readonly workspaceId: string;
		readonly currentCredentialHash: string;
		readonly requestId: string;
		readonly nextCredentialHash: string;
		readonly expiresAtMs: number;
		readonly generation: number;
		readonly gatewayEpoch: number;
		readonly nowMs: number;
	}) => Effect.Effect<RuntimeCredentialRenewalReceipt | null>;
	readonly listDueWorkspaces: (
		nowMs: number,
		limit: number,
	) => Effect.Effect<ReadonlyArray<CloudWorkspaceRecord>>;
	readonly recordActivity: (
		workspaceId: string,
		accountId: string,
		nowMs: number,
		nextIdleAtMs: number,
	) => Effect.Effect<CloudWorkspaceRecord | null>;
	readonly requestMailboxWake: (
		workspaceId: string,
		accountId: string,
		nowMs: number,
		nextIdleAtMs: number,
	) => Effect.Effect<CloudWorkspaceRecord | null>;
	readonly installWrappedTranscriptKey: (
		workspaceId: string,
		accountId: string,
		wrappedTranscriptKey: string,
		nowMs: number,
	) => Effect.Effect<CloudWorkspaceRecord | null>;
	readonly getRuntimeSummary: (
		workspaceId: string,
	) => Effect.Effect<CloudWorkspaceRuntimeSummaryRecord | null>;
	readonly saveRuntimeSummary: (input: {
		readonly workspaceId: string;
		readonly runtimeGeneration: number;
		readonly summaryRevision: number;
		readonly title: string;
		readonly lastActivityAtMs: number;
		readonly sessionHeadVersion: number;
		readonly updatedAtMs: number;
	}) => Effect.Effect<RuntimeSummaryWriteOutcome>;
	readonly getTranscriptCheckpoint: (
		workspaceId: string,
		sessionId: string,
	) => Effect.Effect<CloudTranscriptCheckpointRecord | null>;
	readonly saveTranscriptCheckpoint: (
		checkpoint: CloudTranscriptCheckpointRecord,
	) => Effect.Effect<boolean>;
	readonly deleteTranscriptCheckpoints: (
		workspaceId: string,
	) => Effect.Effect<void>;
	readonly deleteAccountData: (accountId: string) => Effect.Effect<void>;
	readonly recordUsage: (event: {
		readonly eventId: string;
		readonly workspaceId: string;
		readonly accountId: string;
		readonly provider: string;
		readonly kind: string;
		readonly quantity: number;
		readonly providerEventId?: string;
		readonly occurredAtMs: number;
	}) => Effect.Effect<boolean>;
}

export class CloudWorkspaceStore extends Context.Service<
	CloudWorkspaceStore,
	CloudWorkspaceStoreApi
>()("@zuse/api/CloudWorkspaceStore") {}

interface MemoryState {
	readonly githubInstallations: Map<string, CloudGithubInstallationRecord>;
	readonly projects: Map<string, CloudProjectRecord>;
	readonly builds: Map<string, CloudProjectBuildRecord>;
	readonly pool: Map<string, CloudWorkspacePoolRecord>;
	readonly workspaces: Map<string, CloudWorkspaceRecord>;
	readonly usage: Set<string>;
	readonly launchIntents: Map<string, CloudWorkspaceLaunchIntentRecord>;
	readonly runtimeRenewals: Map<string, RuntimeCredentialRenewalReceipt>;
	readonly runtimeSummaries: Map<string, CloudWorkspaceRuntimeSummaryRecord>;
	readonly transcriptCheckpoints: Map<string, CloudTranscriptCheckpointRecord>;
	readonly lifecycleCommands: Map<string, string>;
}

const activeBranch = (workspace: CloudWorkspaceRecord): boolean =>
	workspace.state !== "deleted";

const workspaceRuntimeGeneration = (workspace: CloudWorkspaceRecord): number =>
	typeof workspace.requestConfig.runtimeGeneration === "number"
		? workspace.requestConfig.runtimeGeneration
		: 1;

const transcriptCheckpointKey = (
	workspaceId: string,
	sessionId: string,
): string => `${workspaceId}\u0000${sessionId}`;

const recordOrEmpty = (value: unknown): Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: {};

const completeLaunchWorkspace = (
	workspace: CloudWorkspaceRecord,
	input: CompleteLaunchIntentInput,
): CloudWorkspaceRecord => {
	const startupTimings = recordOrEmpty(workspace.requestConfig.startupTimings);
	const { runtimeSessionRecoveryPending: _, ...requestConfig } =
		workspace.requestConfig;
	const requestedAt =
		typeof startupTimings.requestedAt === "number"
			? startupTimings.requestedAt
			: undefined;
	return {
		...workspace,
		runtimeState: "online",
		state: "ready",
		statusCode: "agent-running",
		requestConfig: {
			...requestConfig,
			sessionHeadVersion: Math.max(
				typeof workspace.requestConfig.sessionHeadVersion === "number"
					? workspace.requestConfig.sessionHeadVersion
					: 0,
				input.sessionHeadVersion,
			),
			startupTimings: {
				...startupTimings,
				connectedAt: startupTimings.connectedAt ?? input.nowMs,
				repositoryReadyAt: startupTimings.repositoryReadyAt ?? input.nowMs,
				agentStartedAt: startupTimings.agentStartedAt ?? input.nowMs,
				messageAcceptedAt: startupTimings.messageAcceptedAt ?? input.nowMs,
				...(requestedAt === undefined
					? {}
					: {
							launchDurationMs:
								startupTimings.launchDurationMs ?? input.nowMs - requestedAt,
						}),
			},
		},
		nextActionAtMs: input.nextActionAtMs,
		runningSinceMs: workspace.runningSinceMs ?? input.nowMs,
		revision: workspace.revision + 1,
		updatedAtMs: input.nowMs,
		lastActivityAtMs: input.nowMs,
	};
};

const canRecoverMissingLaunchIntent = (
	workspace: CloudWorkspaceRecord,
	input: CompleteLaunchIntentInput,
): boolean =>
	input.commandId === `launch:${workspace.workspaceId}` &&
	(workspace.statusCode === "agent-starting" ||
		typeof workspace.requestConfig.sessionHeadVersion === "number");

export const CloudWorkspaceStoreMemory = Layer.effect(
	CloudWorkspaceStore,
	Effect.gen(function* () {
		const state = yield* Ref.make<MemoryState>({
			githubInstallations: new Map(),
			projects: new Map(),
			builds: new Map(),
			pool: new Map(),
			workspaces: new Map(),
			usage: new Set(),
			launchIntents: new Map(),
			runtimeRenewals: new Map(),
			runtimeSummaries: new Map(),
			transcriptCheckpoints: new Map(),
			lifecycleCommands: new Map(),
		});
		return CloudWorkspaceStore.of({
			listGithubInstallations: (accountId) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.githubInstallations.values()].filter(
							(installation) => installation.accountId === accountId,
						),
					),
				),
			saveGithubInstallation: (installation) =>
				Ref.update(state, (current) => ({
					...current,
					githubInstallations: new Map(current.githubInstallations).set(
						`${installation.accountId}:${installation.installationId}`,
						installation,
					),
				})),
			removeGithubInstallation: (accountId, installationId) =>
				Ref.update(state, (current) => {
					const githubInstallations = new Map(current.githubInstallations);
					githubInstallations.delete(`${accountId}:${installationId}`);
					return { ...current, githubInstallations };
				}),
			connectProject: (project) =>
				Ref.modify(state, (current) => {
					const retry = [...current.projects.values()].find(
						(candidate) =>
							candidate.accountId === project.accountId &&
							candidate.idempotencyKey === project.idempotencyKey &&
							candidate.included !== false,
					);
					if (retry !== undefined) return [retry, current] as const;
					const existing = [...current.projects.values()].find(
						(candidate) =>
							candidate.accountId === project.accountId &&
							candidate.repositoryIdentity === project.repositoryIdentity,
					);
					if (existing !== undefined) {
						const updated = {
							...project,
							projectId: existing.projectId,
							createdAtMs: existing.createdAtMs,
						};
						return [
							updated,
							{
								...current,
								projects: new Map(current.projects).set(
									existing.projectId,
									updated,
								),
							},
						] as const;
					}
					const projects = new Map(current.projects);
					projects.set(project.projectId, project);
					return [project, { ...current, projects }] as const;
				}),
			listProjects: (accountId) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.projects.values()].filter(
							(item) => item.accountId === accountId && item.included !== false,
						),
					),
				),
			getProject: (projectId) =>
				Ref.get(state).pipe(
					Effect.map((current) => current.projects.get(projectId) ?? null),
				),
			saveProject: (project) =>
				Ref.update(state, (current) => ({
					...current,
					projects: new Map(current.projects).set(project.projectId, project),
				})),
			removeProject: (projectId, nowMs) =>
				Ref.modify(state, (current) => {
					const project = current.projects.get(projectId);
					if (project === undefined) return [null, current] as const;
					const removed = { ...project, included: false, updatedAtMs: nowMs };
					return [
						removed,
						{
							...current,
							projects: new Map(current.projects).set(projectId, removed),
						},
					] as const;
				}),
			createBuild: (build) =>
				Ref.modify(state, (current) => {
					const existing = [...current.builds.values()].find(
						(candidate) =>
							candidate.projectId === build.projectId &&
							candidate.provider === build.provider &&
							candidate.idempotencyKey === build.idempotencyKey,
					);
					if (existing !== undefined) return [existing, current] as const;
					return [
						build,
						{
							...current,
							builds: new Map(current.builds).set(build.buildId, build),
						},
					] as const;
				}),
			getActiveBuild: (projectId, provider) =>
				Ref.get(state).pipe(
					Effect.map(
						(current) =>
							[...current.builds.values()]
								.filter(
									(build) =>
										build.projectId === projectId &&
										build.provider === provider &&
										build.state === "ready",
								)
								.sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0] ?? null,
					),
				),
			getActiveAccountBuild: (accountId, provider) =>
				Ref.get(state).pipe(
					Effect.map(
						(current) =>
							[...current.builds.values()]
								.filter(
									(build) =>
										build.accountId === accountId &&
										build.provider === provider &&
										build.state === "ready",
								)
								.sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0] ?? null,
					),
				),
			listAccountBuilds: (accountId, provider) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.builds.values()]
							.filter(
								(build) =>
									build.accountId === accountId && build.provider === provider,
							)
							.sort((a, b) => a.createdAtMs - b.createdAtMs),
					),
				),
			getBuild: (buildId) =>
				Ref.get(state).pipe(
					Effect.map((current) => current.builds.get(buildId) ?? null),
				),
			claimBuild: (buildId, leaseOwner, nowMs, leaseExpiresAtMs) =>
				Ref.modify(state, (current) => {
					const build = current.builds.get(buildId);
					if (
						build === undefined ||
						(build.leaseExpiresAtMs !== undefined &&
							build.leaseExpiresAtMs > nowMs)
					)
						return [null, current] as const;
					const claimed = { ...build, leaseOwner, leaseExpiresAtMs };
					return [
						claimed,
						{
							...current,
							builds: new Map(current.builds).set(buildId, claimed),
						},
					] as const;
				}),
			listBuilds: (projectId) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.builds.values()].filter(
							(build) => build.projectId === projectId,
						),
					),
				),
			saveBuild: (build) =>
				Ref.update(state, (current) => ({
					...current,
					builds: new Map(current.builds).set(build.buildId, {
						...build,
						leaseOwner: undefined,
						leaseExpiresAtMs: undefined,
					}),
				})),
			listDueBuilds: (nowMs, limit) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.builds.values()]
							.filter(
								(build) =>
									build.state !== "ready" &&
									build.state !== "failed" &&
									build.nextActionAtMs <= nowMs,
							)
							.slice(0, limit),
					),
				),
			listPool: (accountId, provider) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.pool.values()].filter(
							(item) =>
								item.accountId === accountId && item.provider === provider,
						),
					),
				),
			savePool: (record) =>
				Ref.update(state, (current) => ({
					...current,
					pool: new Map(current.pool).set(record.poolId, record),
				})),
			claimPool: (accountId, provider, imageGeneration, workspaceId, nowMs) =>
				Ref.modify(state, (current) => {
					const available = [...current.pool.values()].find(
						(item) =>
							item.accountId === accountId &&
							item.provider === provider &&
							item.imageGeneration === imageGeneration &&
							item.state === "available",
					);
					if (available === undefined) return [null, current] as const;
					const claimed: CloudWorkspacePoolRecord = {
						...available,
						state: "claimed",
						claimedWorkspaceId: workspaceId,
						updatedAtMs: nowMs,
					};
					return [
						claimed,
						{
							...current,
							pool: new Map(current.pool).set(claimed.poolId, claimed),
						},
					] as const;
				}),
			removePool: (poolId) =>
				Ref.update(state, (current) => {
					const pool = new Map(current.pool);
					pool.delete(poolId);
					return { ...current, pool };
				}),
			createWorkspace: (workspace, launchIntent) =>
				Ref.modify<MemoryState, CreateCloudWorkspaceOutcome>(
					state,
					(current) => {
						const existing = [...current.workspaces.values()].find(
							(candidate) =>
								candidate.accountId === workspace.accountId &&
								candidate.idempotencyKey === workspace.idempotencyKey,
						);
						if (existing !== undefined)
							return [
								{ kind: "existing", workspace: existing } as const,
								current,
							] as const;
						const conflict = [...current.workspaces.values()].find(
							(candidate) =>
								candidate.projectId === workspace.projectId &&
								candidate.branch === workspace.branch &&
								activeBranch(candidate),
						);
						if (conflict !== undefined)
							return [
								{ kind: "branch-in-use", workspace: conflict } as const,
								current,
							] as const;
						return [
							{ kind: "created", workspace } as const,
							{
								...current,
								workspaces: new Map(current.workspaces).set(
									workspace.workspaceId,
									workspace,
								),
								launchIntents: new Map(current.launchIntents).set(
									launchIntent.workspaceId,
									launchIntent,
								),
							},
						] as const;
					},
				),
			listWorkspaces: (accountId, projectId) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.workspaces.values()].filter(
							(item) =>
								item.accountId === accountId &&
								(projectId === undefined || item.projectId === projectId),
						),
					),
				),
			getWorkspace: (workspaceId) =>
				Ref.get(state).pipe(
					Effect.map((current) => current.workspaces.get(workspaceId) ?? null),
				),
			getLaunchIntent: (workspaceId, nowMs) =>
				Ref.modify(state, (current) => {
					const intent = current.launchIntents.get(workspaceId);
					if (intent === undefined) return [null, current] as const;
					if (intent.expiresAtMs > nowMs) return [intent, current] as const;
					const workspace = current.workspaces.get(workspaceId);
					return [
						null,
						{
							...current,
							workspaces:
								workspace === undefined
									? current.workspaces
									: new Map(current.workspaces).set(workspaceId, {
											...workspace,
											state: "failed",
											statusCode: "launch-intent-expired",
											revision: workspace.revision + 1,
											updatedAtMs: nowMs,
										}),
						},
					] as const;
				}),
			completeLaunchIntent: (input) =>
				Ref.modify<MemoryState, CompleteLaunchIntentOutcome>(
					state,
					(current) => {
						const workspace = current.workspaces.get(input.workspaceId);
						if (workspace === undefined)
							return [{ kind: "workspace-missing" }, current] as const;
						const intent = current.launchIntents.get(input.workspaceId);
						if (
							intent?.commandId !== input.commandId &&
							!(
								intent === undefined &&
								canRecoverMissingLaunchIntent(workspace, input)
							)
						)
							return [{ kind: "rejected" }, current] as const;
						const completed = completeLaunchWorkspace(workspace, input);
						const launchIntents = new Map(current.launchIntents);
						launchIntents.delete(input.workspaceId);
						return [
							{ kind: "completed", workspace: completed },
							{
								...current,
								workspaces: new Map(current.workspaces).set(
									input.workspaceId,
									completed,
								),
								launchIntents,
							},
						] as const;
					},
				),
			deleteLaunchIntent: (workspaceId) =>
				Ref.update(state, (current) => {
					const launchIntents = new Map(current.launchIntents);
					launchIntents.delete(workspaceId);
					return { ...current, launchIntents };
				}),
			claimWorkspace: (workspaceId, leaseOwner, nowMs, leaseExpiresAtMs) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(workspaceId);
					if (
						workspace === undefined ||
						(workspace.leaseExpiresAtMs !== undefined &&
							workspace.leaseExpiresAtMs > nowMs)
					)
						return [null, current] as const;
					const claimed = { ...workspace, leaseOwner, leaseExpiresAtMs };
					return [
						claimed,
						{
							...current,
							workspaces: new Map(current.workspaces).set(workspaceId, claimed),
						},
					] as const;
				}),
			enrollRuntimeBoot: (input) =>
				Ref.modify<MemoryState, RuntimeBootstrapEnrollmentOutcome | null>(
					state,
					(current) => {
						const workspace = current.workspaces.get(input.workspaceId);
						const prior =
							workspace === undefined
								? null
								: runtimeBootstrapReceiptFromConfig(workspace.requestConfig);
						if (
							prior !== null &&
							workspace?.runtimeBootTokenHash === input.bootTokenHash
						) {
							const matches =
								prior.bootTokenHash === input.bootTokenHash &&
								prior.credentialKeyThumbprint ===
									input.credentialKeyThumbprint &&
								prior.signingKeyThumbprint === input.signingKeyThumbprint &&
								prior.generation === input.generation &&
								prior.gatewayEpoch === input.gatewayEpoch;
							return [
								matches &&
								(workspace.runtimeBootTokenExpiresAtMs ?? 0) > input.nowMs &&
								workspace.desiredState === "ready" &&
								workspace.providerSandboxId !== undefined &&
								workspace.state !== "deleted"
									? {
											kind: "replay" as const,
											workspace,
											receipt: prior,
											launchIntent:
												(current.launchIntents.get(input.workspaceId)
													?.expiresAtMs ?? 0) > input.nowMs
													? (current.launchIntents.get(input.workspaceId) ??
														null)
													: null,
										}
									: null,
								current,
							] as const;
						}
						if (
							workspace === undefined ||
							workspace.runtimeBootTokenHash !== input.bootTokenHash ||
							(workspace.runtimeBootTokenExpiresAtMs ?? 0) <= input.nowMs ||
							workspace.desiredState !== "ready" ||
							workspace.providerSandboxId === undefined ||
							workspace.state === "deleted"
						)
							return [null, current] as const;
						const currentGeneration = workspaceRuntimeGeneration(workspace);
						const currentGatewayEpoch =
							typeof workspace.requestConfig.gatewayEpoch === "number"
								? workspace.requestConfig.gatewayEpoch
								: currentGeneration;
						if (
							input.generation !== currentGeneration ||
							input.gatewayEpoch !== currentGatewayEpoch
						)
							return [null, current] as const;
						const timings =
							(workspace.requestConfig.startupTimings as
								| Readonly<Record<string, number>>
								| undefined) ?? {};
						const receipt: RuntimeBootstrapReceipt = {
							workspaceId: input.workspaceId,
							bootTokenHash: input.bootTokenHash,
							credentialKeyThumbprint: input.credentialKeyThumbprint,
							signingKeyThumbprint: input.signingKeyThumbprint,
							signingPublicJwk: input.signingPublicJwk,
							runtimeCredentialHash: input.runtimeCredentialHash,
							runtimeCredentialExpiresAtMs: input.runtimeCredentialExpiresAtMs,
							generation: input.generation,
							gatewayEpoch: input.gatewayEpoch,
							sealedTranscriptKey: input.sealedTranscriptKey,
							enrolledAtMs: input.nowMs,
						};
						const updated: CloudWorkspaceRecord = {
							...workspace,
							runtimeCredentialHash: input.runtimeCredentialHash,
							runtimeState: "connecting",
							state: "setup",
							statusCode: "runtime-authenticating",
							requestConfig: {
								...workspace.requestConfig,
								runtimeSigningPublicJwk: input.signingPublicJwk,
								runtimeSigningKeyThumbprint: input.signingKeyThumbprint,
								runtimeCredentialKeyThumbprint: input.credentialKeyThumbprint,
								runtimeGeneration: input.generation,
								gatewayEpoch: input.gatewayEpoch,
								runtimeCredentialExpiresAtMs:
									input.runtimeCredentialExpiresAtMs,
								runtimeBootstrapReceipt: receipt,
								startupTimings: {
									...timings,
									enrolledAt: input.nowMs,
									runtimeReadyAt: input.nowMs,
									enrollmentDurationMs:
										timings.allocatedAt === undefined
											? undefined
											: input.nowMs - timings.allocatedAt,
								},
							},
							nextActionAtMs: input.nowMs + 30_000,
							revision: workspace.revision + 1,
							updatedAtMs: input.nowMs,
						};
						return [
							{
								kind: "created" as const,
								workspace: updated,
								receipt,
								launchIntent:
									(current.launchIntents.get(input.workspaceId)?.expiresAtMs ??
										0) > input.nowMs
										? (current.launchIntents.get(input.workspaceId) ?? null)
										: null,
							},
							{
								...current,
								workspaces: new Map(current.workspaces).set(
									workspace.workspaceId,
									updated,
								),
							},
						] as const;
					},
				),
			markRuntimeRepositoryReady: (input) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(input.workspaceId);
					if (
						workspace === undefined ||
						workspace.runtimeCredentialHash !== input.currentCredentialHash ||
						typeof workspace.requestConfig.runtimeCredentialExpiresAtMs !==
							"number" ||
						workspace.requestConfig.runtimeCredentialExpiresAtMs <=
							input.nowMs ||
						workspace.state === "deleted"
					)
						return [null, current] as const;
					const timings =
						(workspace.requestConfig.startupTimings as
							| Readonly<Record<string, number>>
							| undefined) ?? {};
					const launchPending =
						typeof workspace.requestConfig.sessionHeadVersion !== "number" ||
						workspace.requestConfig.runtimeSessionRecoveryPending === true;
					const updated: CloudWorkspaceRecord = {
						...workspace,
						runtimeState: "online",
						state: launchPending ? "setup" : "ready",
						statusCode: launchPending ? "agent-starting" : "agent-running",
						requestConfig: {
							...workspace.requestConfig,
							runtimeProcessManaged: true,
							startupTimings: {
								...timings,
								connectedAt: timings.connectedAt ?? input.nowMs,
								repositoryReadyAt: timings.repositoryReadyAt ?? input.nowMs,
							},
						},
						nextActionAtMs: launchPending
							? input.nowMs + 30_000
							: input.nextIdleAtMs,
						runningSinceMs: workspace.runningSinceMs ?? input.nowMs,
						revision: workspace.revision + 1,
						updatedAtMs: input.nowMs,
						lastActivityAtMs: input.nowMs,
					};
					return [
						updated,
						{
							...current,
							workspaces: new Map(current.workspaces).set(
								input.workspaceId,
								updated,
							),
						},
					] as const;
				}),
			acknowledgeRuntimeBoot: (input) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(input.workspaceId);
					if (workspace === undefined) return [false, current] as const;
					const receipt = runtimeBootstrapReceiptFromConfig(
						workspace.requestConfig,
					);
					if (
						workspace.runtimeCredentialHash !== input.currentCredentialHash ||
						receipt === null ||
						receipt.runtimeCredentialHash !== input.currentCredentialHash ||
						receipt.generation !== input.generation ||
						receipt.gatewayEpoch !== input.gatewayEpoch ||
						workspaceRuntimeGeneration(workspace) !== input.generation ||
						workspace.requestConfig.gatewayEpoch !== input.gatewayEpoch ||
						workspace.state === "deleted"
					)
						return [false, current] as const;
					if (receipt.acknowledgedAtMs !== undefined)
						return [true, current] as const;
					const acknowledged: RuntimeBootstrapReceipt = {
						...receipt,
						acknowledgedAtMs: input.nowMs,
					};
					const updated: CloudWorkspaceRecord = {
						...workspace,
						runtimeBootTokenHash: undefined,
						runtimeBootTokenExpiresAtMs: undefined,
						requestConfig: {
							...workspace.requestConfig,
							runtimeBootstrapReceipt: acknowledged,
						},
						revision: workspace.revision + 1,
						updatedAtMs: Math.max(input.nowMs, workspace.updatedAtMs + 1),
					};
					return [
						true,
						{
							...current,
							workspaces: new Map(current.workspaces).set(
								input.workspaceId,
								updated,
							),
						},
					] as const;
				}),
			renewRuntimeCredential: (input) =>
				Ref.modify(state, (current) => {
					const receiptKey = `${input.workspaceId}:${input.requestId}`;
					const existing = current.runtimeRenewals.get(receiptKey);
					if (existing !== undefined)
						return [
							existing.expiresAtMs > input.nowMs &&
							existing.previousCredentialHash === input.currentCredentialHash
								? existing
								: null,
							current,
						] as const;
					const workspace = current.workspaces.get(input.workspaceId);
					if (
						workspace === undefined ||
						workspace.runtimeCredentialHash !== input.currentCredentialHash ||
						typeof workspace.requestConfig.runtimeCredentialExpiresAtMs !==
							"number" ||
						workspace.requestConfig.runtimeCredentialExpiresAtMs <=
							input.nowMs ||
						workspace.state === "deleted"
					)
						return [null, current] as const;
					const receipt: RuntimeCredentialRenewalReceipt = {
						workspaceId: input.workspaceId,
						requestId: input.requestId,
						credentialHash: input.nextCredentialHash,
						previousCredentialHash: input.currentCredentialHash,
						expiresAtMs: input.expiresAtMs,
						generation: input.generation,
						gatewayEpoch: input.gatewayEpoch,
					};
					const updated: CloudWorkspaceRecord = {
						...workspace,
						runtimeCredentialHash: input.nextCredentialHash,
						requestConfig: {
							...workspace.requestConfig,
							runtimeCredentialExpiresAtMs: input.expiresAtMs,
						},
					};
					return [
						receipt,
						{
							...current,
							workspaces: new Map(current.workspaces).set(
								input.workspaceId,
								updated,
							),
							runtimeRenewals: new Map(current.runtimeRenewals).set(
								receiptKey,
								receipt,
							),
						},
					] as const;
				}),
			saveWorkspace: (workspace) =>
				Ref.update(state, (current) => {
					const saved = current.workspaces.get(workspace.workspaceId);
					if (
						saved !== undefined &&
						(saved.revision > workspace.revision ||
							(saved.revision === workspace.revision &&
								saved.updatedAtMs >= workspace.updatedAtMs))
					)
						return current;
					return {
						...current,
						workspaces: new Map(current.workspaces).set(workspace.workspaceId, {
							...workspace,
							leaseOwner: saved?.leaseOwner,
							leaseExpiresAtMs: saved?.leaseExpiresAtMs,
						}),
					};
				}),
			getWorkspaceLifecycleCommand: (workspaceId, commandId) =>
				Ref.get(state).pipe(
					Effect.map(
						(current) =>
							current.lifecycleCommands.get(`${workspaceId}:${commandId}`) ??
							null,
					),
				),
			saveWorkspaceLifecycleCommand: ({ workspace, commandId, action }) =>
				Ref.update(state, (current) => ({
					...current,
					workspaces: new Map(current.workspaces).set(workspace.workspaceId, {
						...workspace,
						leaseOwner: current.workspaces.get(workspace.workspaceId)
							?.leaseOwner,
						leaseExpiresAtMs: current.workspaces.get(workspace.workspaceId)
							?.leaseExpiresAtMs,
					}),
					lifecycleCommands: new Map(current.lifecycleCommands).set(
						`${workspace.workspaceId}:${commandId}`,
						action,
					),
				})),
			saveClaimedWorkspace: ({
				workspace,
				leaseOwner,
				expectedRevision,
				expectedUpdatedAtMs,
			}) =>
				Ref.modify(state, (current) => {
					const saved = current.workspaces.get(workspace.workspaceId);
					if (
						saved?.leaseOwner !== leaseOwner ||
						saved.revision !== expectedRevision ||
						saved.updatedAtMs !== expectedUpdatedAtMs
					)
						return [false, current] as const;
					return [
						true,
						{
							...current,
							workspaces: new Map(current.workspaces).set(
								workspace.workspaceId,
								{
									...workspace,
									leaseOwner,
									leaseExpiresAtMs: saved.leaseExpiresAtMs,
								},
							),
						},
					] as const;
				}),
			releaseWorkspaceLease: (workspaceId, leaseOwner) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(workspaceId);
					if (workspace?.leaseOwner !== leaseOwner)
						return [false, current] as const;
					return [
						true,
						{
							...current,
							workspaces: new Map(current.workspaces).set(workspaceId, {
								...workspace,
								leaseOwner: undefined,
								leaseExpiresAtMs: undefined,
							}),
						},
					] as const;
				}),
			listDueWorkspaces: (nowMs, limit) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.workspaces.values()]
							.filter(
								(workspace) =>
									workspace.state !== "deleted" &&
									workspace.nextActionAtMs <= nowMs,
							)
							.slice(0, limit),
					),
				),
			recordActivity: (workspaceId, accountId, nowMs, nextIdleAtMs) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(workspaceId);
					if (workspace?.accountId !== accountId)
						return [null, current] as const;
					const updated: CloudWorkspaceRecord = {
						...workspace,
						desiredState:
							workspace.state === "paused" ? "ready" : workspace.desiredState,
						statusCode:
							workspace.state === "paused"
								? "resume-queued"
								: workspace.statusCode,
						requestConfig:
							workspace.state === "paused"
								? {
										...workspace.requestConfig,
										startupTimings: {
											requestedAt: nowMs,
											resumeRequestedAt: nowMs,
										},
									}
								: workspace.requestConfig,
						nextActionAtMs: workspace.state === "paused" ? nowMs : nextIdleAtMs,
						lastActivityAtMs: nowMs,
						revision: workspace.revision + 1,
						updatedAtMs: nowMs,
					};
					return [
						updated,
						{
							...current,
							workspaces: new Map(current.workspaces).set(
								workspace.workspaceId,
								updated,
							),
						},
					] as const;
				}),
			requestMailboxWake: (workspaceId, accountId, nowMs, nextIdleAtMs) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(workspaceId);
					if (
						workspace?.accountId !== accountId ||
						workspace.state === "archived" ||
						workspace.state === "archiving" ||
						workspace.state === "deleted" ||
						workspace.state === "deleting" ||
						workspace.desiredState === "archived" ||
						workspace.desiredState === "deleted"
					)
						return [null, current] as const;
					const alreadyReady = workspace.state === "ready";
					const resuming =
						workspace.state === "paused" || workspace.state === "pausing";
					const updated: CloudWorkspaceRecord = {
						...workspace,
						desiredState: "ready",
						statusCode: resuming ? "resume-queued" : workspace.statusCode,
						requestConfig: resuming
							? {
									...workspace.requestConfig,
									startupTimings: {
										requestedAt: nowMs,
										resumeRequestedAt: nowMs,
									},
								}
							: workspace.requestConfig,
						nextActionAtMs: alreadyReady ? nextIdleAtMs : nowMs,
						lastActivityAtMs: nowMs,
						revision: workspace.revision + 1,
						updatedAtMs: nowMs,
					};
					return [
						updated,
						{
							...current,
							workspaces: new Map(current.workspaces).set(workspaceId, updated),
						},
					] as const;
				}),
			installWrappedTranscriptKey: (
				workspaceId,
				accountId,
				wrappedTranscriptKey,
				nowMs,
			) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(workspaceId);
					if (workspace?.accountId !== accountId)
						return [null, current] as const;
					if (workspace.wrappedTranscriptKey !== undefined)
						return [workspace, current] as const;
					const updated: CloudWorkspaceRecord = {
						...workspace,
						wrappedTranscriptKey,
						revision: workspace.revision + 1,
						updatedAtMs: Math.max(nowMs, workspace.updatedAtMs + 1),
					};
					return [
						updated,
						{
							...current,
							workspaces: new Map(current.workspaces).set(workspaceId, updated),
						},
					] as const;
				}),
			getRuntimeSummary: (workspaceId) =>
				Ref.get(state).pipe(
					Effect.map(
						(current) => current.runtimeSummaries.get(workspaceId) ?? null,
					),
				),
			saveRuntimeSummary: (input) =>
				Ref.modify(
					state,
					(current): readonly [RuntimeSummaryWriteOutcome, MemoryState] => {
						const workspace = current.workspaces.get(input.workspaceId);
						if (workspace === undefined)
							return [{ kind: "workspace-missing" as const }, current] as const;
						if (
							workspaceRuntimeGeneration(workspace) !== input.runtimeGeneration
						)
							return [
								{ kind: "rejected-generation" as const },
								current,
							] as const;
						const previous = current.runtimeSummaries.get(input.workspaceId);
						if (
							previous !== undefined &&
							previous.runtimeGeneration === input.runtimeGeneration &&
							previous.summaryRevision >= input.summaryRevision
						)
							return [
								{ kind: "stale" as const, summary: previous },
								current,
							] as const;
						const sameGeneration =
							previous?.runtimeGeneration === input.runtimeGeneration;
						const summary: CloudWorkspaceRuntimeSummaryRecord = {
							...input,
							lastActivityAtMs: sameGeneration
								? Math.max(previous.lastActivityAtMs, input.lastActivityAtMs)
								: input.lastActivityAtMs,
							sessionHeadVersion: sameGeneration
								? Math.max(
										previous.sessionHeadVersion,
										input.sessionHeadVersion,
									)
								: input.sessionHeadVersion,
						};
						return [
							{ kind: "applied" as const, summary },
							{
								...current,
								runtimeSummaries: new Map(current.runtimeSummaries).set(
									input.workspaceId,
									summary,
								),
							},
						] as const;
					},
				),
			getTranscriptCheckpoint: (workspaceId, sessionId) =>
				Ref.get(state).pipe(
					Effect.map(
						(current) =>
							current.transcriptCheckpoints.get(
								transcriptCheckpointKey(workspaceId, sessionId),
							) ?? null,
					),
				),
			saveTranscriptCheckpoint: (checkpoint) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(checkpoint.workspaceId);
					if (
						workspace === undefined ||
						workspaceRuntimeGeneration(workspace) !==
							checkpoint.runtimeGeneration
					)
						return [false, current] as const;
					const key = transcriptCheckpointKey(
						checkpoint.workspaceId,
						checkpoint.sessionId,
					);
					const previous = current.transcriptCheckpoints.get(key);
					if (
						previous !== undefined &&
						(previous.runtimeGeneration > checkpoint.runtimeGeneration ||
							previous.streamVersion > checkpoint.streamVersion ||
							(previous.runtimeGeneration === checkpoint.runtimeGeneration &&
								(previous.streamEpoch !== checkpoint.streamEpoch ||
									previous.streamVersion >= checkpoint.streamVersion)))
					)
						return [false, current] as const;
					return [
						true,
						{
							...current,
							transcriptCheckpoints: new Map(current.transcriptCheckpoints).set(
								key,
								checkpoint,
							),
						},
					] as const;
				}),
			deleteTranscriptCheckpoints: (workspaceId) =>
				Ref.update(state, (current) => ({
					...current,
					transcriptCheckpoints: new Map(
						[...current.transcriptCheckpoints].filter(
							([, checkpoint]) => checkpoint.workspaceId !== workspaceId,
						),
					),
				})),
			deleteAccountData: (accountId) =>
				Ref.update(state, (current) => {
					const githubInstallations = new Map(
						[...current.githubInstallations].filter(
							([, installation]) => installation.accountId !== accountId,
						),
					);
					const projects = new Map(
						[...current.projects].filter(
							([, project]) => project.accountId !== accountId,
						),
					);
					const builds = new Map(
						[...current.builds].filter(
							([, item]) => item.accountId !== accountId,
						),
					);
					const workspaces = new Map(
						[...current.workspaces].filter(
							([, item]) => item.accountId !== accountId,
						),
					);
					const launchIntents = new Map(
						[...current.launchIntents].filter(
							([, item]) => item.accountId !== accountId,
						),
					);
					const runtimeSummaries = new Map(
						[...current.runtimeSummaries].filter(([workspaceId]) =>
							workspaces.has(workspaceId),
						),
					);
					const transcriptCheckpoints = new Map(
						[...current.transcriptCheckpoints].filter(([, checkpoint]) =>
							workspaces.has(checkpoint.workspaceId),
						),
					);
					return {
						...current,
						githubInstallations,
						projects,
						builds,
						workspaces,
						launchIntents,
						runtimeSummaries,
						transcriptCheckpoints,
					};
				}),
			recordUsage: (event) =>
				Ref.modify(state, (current) => {
					if (current.usage.has(event.eventId))
						return [false, current] as const;
					const usage = new Set(current.usage);
					usage.add(event.eventId);
					return [true, { ...current, usage }] as const;
				}),
		});
	}),
);

type Row = Record<string, unknown>;
const numberValue = (value: unknown): number =>
	typeof value === "number" ? value : Number(value);
const optionalNumber = (value: unknown): number | undefined =>
	value == null ? undefined : numberValue(value);
const optionalString = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;
const githubInstallationFromRow = (
	row: Row,
): CloudGithubInstallationRecord => ({
	accountId: String(row.account_id),
	installationId: numberValue(row.installation_id),
	githubAccountId: numberValue(row.github_account_id),
	accountLogin: String(row.account_login),
	accountType: row.account_type as "User" | "Organization",
	avatarUrl: optionalString(row.avatar_url),
	repositorySelection: row.repository_selection as "all" | "selected",
	suspended: row.suspended === true,
	createdAtMs: numberValue(row.created_at),
	updatedAtMs: numberValue(row.updated_at),
});
const projectFromRow = (row: Row): CloudProjectRecord => ({
	projectId: String(row.project_id),
	accountId: String(row.account_id),
	repositoryIdentity: String(row.repository_identity),
	repositoryUrl: String(row.repository_url),
	displayName: String(row.display_name),
	defaultBranch: String(row.default_branch),
	visibility: row.visibility as "public" | "private",
	gitConnectionKind: "github-app",
	cloudEnvironment: (row.cloud_environment ?? {}) as Record<string, string>,
	secretBindings: (row.secret_bindings ?? []) as string[],
	configurationDigest: String(row.configuration_digest),
	state: row.state as CloudProjectState,
	included: row.included !== false,
	lastErrorCode: optionalString(row.last_error_code),
	idempotencyKey: String(row.idempotency_key),
	createdAtMs: numberValue(row.created_at),
	updatedAtMs: numberValue(row.updated_at),
});
const buildFromRow = (row: Row): CloudProjectBuildRecord => ({
	buildId: String(row.build_id),
	projectId: String(row.project_id),
	accountId: String(row.account_id),
	provider: String(row.provider),
	providerSandboxId: optionalString(row.provider_sandbox_id),
	snapshotId: optionalString(row.snapshot_id),
	sourceCommit: optionalString(row.source_commit),
	templateVersion: String(row.template_version),
	configurationDigest: String(row.configuration_digest),
	settings: (row.settings ?? {}) as Record<string, unknown>,
	logText: optionalString(row.log_text),
	state: row.state as CloudProjectBuildState,
	lastErrorCode: optionalString(row.last_error_code),
	idempotencyKey: String(row.idempotency_key),
	nextActionAtMs: numberValue(row.next_action_at),
	leaseOwner: optionalString(row.lease_owner),
	leaseExpiresAtMs: optionalNumber(row.lease_expires_at),
	revision: numberValue(row.revision),
	createdAtMs: numberValue(row.created_at),
	updatedAtMs: numberValue(row.updated_at),
});
const poolFromRow = (row: Row): CloudWorkspacePoolRecord => ({
	poolId: String(row.pool_id),
	accountId: String(row.account_id),
	provider: String(row.provider),
	imageGeneration: String(row.image_generation),
	providerSandboxId: String(row.provider_sandbox_id),
	state: row.state as CloudWorkspacePoolRecord["state"],
	claimedWorkspaceId: optionalString(row.claimed_workspace_id),
	createdAtMs: numberValue(row.created_at),
	updatedAtMs: numberValue(row.updated_at),
});
const workspaceFromRow = (row: Row): CloudWorkspaceRecord => ({
	workspaceId: String(row.workspace_id),
	accountId: String(row.account_id),
	projectId: String(row.project_id),
	buildId: String(row.build_id),
	provider: String(row.provider),
	providerSandboxId: optionalString(row.provider_sandbox_id),
	runtimeBootTokenHash: optionalString(row.runtime_boot_token_hash),
	runtimeBootTokenExpiresAtMs: optionalNumber(
		row.runtime_boot_token_expires_at,
	),
	runtimeCredentialHash: optionalString(row.runtime_credential_hash),
	runtimeState: row.runtime_state as CloudWorkspaceRecord["runtimeState"],
	chatId: String(row.chat_id),
	initialSessionId: String(row.initial_session_id),
	branch: String(row.branch),
	baseRef: String(row.base_ref),
	state: row.state as CloudWorkspaceState,
	desiredState: row.desired_state as CloudWorkspaceDesiredState,
	statusCode: String(row.status_code),
	wrappedTranscriptKey: optionalString(row.wrapped_transcript_key),
	archiveRequestedAtMs: optionalNumber(row.archive_requested_at),
	archiveDeleteAtMs: optionalNumber(row.archive_delete_at),
	deletionTombstoneExpiresAtMs: optionalNumber(
		row.deletion_tombstone_expires_at,
	),
	idempotencyKey: String(row.idempotency_key),
	requestConfig: (row.request_config ?? {}) as Record<string, unknown>,
	nextActionAtMs: numberValue(row.next_action_at),
	leaseOwner: optionalString(row.lease_owner),
	leaseExpiresAtMs: optionalNumber(row.lease_expires_at),
	revision: numberValue(row.revision),
	createdAtMs: numberValue(row.created_at),
	updatedAtMs: numberValue(row.updated_at),
	lastActivityAtMs: numberValue(row.last_activity_at),
	runningSinceMs: optionalNumber(row.running_since),
	deletedAtMs: optionalNumber(row.deleted_at),
});
const launchIntentFromRow = (
	row: Row | null | undefined,
): CloudWorkspaceLaunchIntentRecord | null =>
	row === null || row === undefined
		? null
		: {
				workspaceId: String(row.workspace_id),
				accountId: String(row.account_id),
				chatId: String(row.chat_id),
				sessionId: String(row.session_id),
				turnId: String(row.turn_id),
				commandId: String(row.command_id),
				ciphertext: String(row.ciphertext),
				expiresAtMs: numberValue(row.expires_at),
				createdAtMs: numberValue(row.created_at),
			};

const runtimeSummaryFromRow = (
	row: Row,
): CloudWorkspaceRuntimeSummaryRecord => ({
	workspaceId: String(row.workspace_id),
	runtimeGeneration: numberValue(row.runtime_generation),
	summaryRevision: numberValue(row.summary_revision),
	title: String(row.title),
	lastActivityAtMs: numberValue(row.last_activity_at),
	sessionHeadVersion: numberValue(row.session_head_version),
	updatedAtMs: numberValue(row.updated_at),
});

const transcriptCheckpointFromRow = (
	row: Row,
): CloudTranscriptCheckpointRecord => ({
	workspaceId: String(row.workspace_id),
	sessionId: String(row.session_id),
	runtimeGeneration: numberValue(row.runtime_generation),
	streamEpoch: String(row.stream_epoch),
	streamVersion: numberValue(row.stream_version),
	objectKey: String(row.object_key),
	ciphertextSha256: String(row.ciphertext_sha256),
	ciphertextBytes: numberValue(row.ciphertext_bytes),
	createdAtMs: numberValue(row.created_at),
});

export const CloudWorkspaceStorePg: Layer.Layer<
	CloudWorkspaceStore,
	never,
	SqlClient.SqlClient
> = Layer.effect(
	CloudWorkspaceStore,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const orDie = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A> =>
			effect.pipe(Effect.orDie);
		const saveProject = (p: CloudProjectRecord) =>
			orDie(
				sql`UPDATE api_cloud_projects SET repository_url=${p.repositoryUrl}, display_name=${p.displayName}, default_branch=${p.defaultBranch}, visibility=${p.visibility}, cloud_environment=${JSON.stringify(p.cloudEnvironment)}::jsonb, secret_bindings=${JSON.stringify(p.secretBindings)}::jsonb, configuration_digest=${p.configurationDigest}, state=${p.state}, included=${p.included !== false}, last_error_code=${p.lastErrorCode ?? null}, updated_at=${p.updatedAtMs} WHERE project_id=${p.projectId}`.pipe(
					Effect.asVoid,
				),
			);
		const saveBuild = (b: CloudProjectBuildRecord) =>
			orDie(
				sql`UPDATE api_cloud_project_builds SET provider_sandbox_id=${b.providerSandboxId ?? null}, snapshot_id=${b.snapshotId ?? null}, source_commit=${b.sourceCommit ?? null}, settings=${JSON.stringify(b.settings ?? {})}::jsonb, log_text=${b.logText ?? null}, state=${b.state}, last_error_code=${b.lastErrorCode ?? null}, next_action_at=${b.nextActionAtMs}, lease_owner=NULL, lease_expires_at=NULL, revision=${b.revision}, updated_at=${b.updatedAtMs} WHERE build_id=${b.buildId}`.pipe(
					Effect.asVoid,
				),
			);
		const saveWorkspace = (w: CloudWorkspaceRecord) =>
			orDie(
				sql`UPDATE api_cloud_workspaces SET provider_sandbox_id=${w.providerSandboxId ?? null}, runtime_boot_token_hash=${w.runtimeBootTokenHash ?? null}, runtime_boot_token_expires_at=${w.runtimeBootTokenExpiresAtMs ?? null}, runtime_credential_hash=${w.runtimeCredentialHash ?? null}, runtime_state=${w.runtimeState}, state=${w.state}, desired_state=${w.desiredState}, status_code=${w.statusCode}, wrapped_transcript_key=${w.wrappedTranscriptKey ?? null}, archive_requested_at=${w.archiveRequestedAtMs ?? null}, archive_delete_at=${w.archiveDeleteAtMs ?? null}, deletion_tombstone_expires_at=${w.deletionTombstoneExpiresAtMs ?? null}, request_config=${JSON.stringify(w.requestConfig)}::jsonb, next_action_at=${w.nextActionAtMs}, revision=${w.revision}, updated_at=${w.updatedAtMs}, last_activity_at=${w.lastActivityAtMs}, running_since=${w.runningSinceMs ?? null}, deleted_at=${w.deletedAtMs ?? null} WHERE workspace_id=${w.workspaceId} AND (revision < ${w.revision} OR (revision = ${w.revision} AND updated_at < ${w.updatedAtMs}))`.pipe(
					Effect.asVoid,
				),
			);
		const saveClaimedWorkspace = (input: {
			readonly workspace: CloudWorkspaceRecord;
			readonly leaseOwner: string;
			readonly expectedRevision: number;
			readonly expectedUpdatedAtMs: number;
		}) => {
			const w = input.workspace;
			return orDie(
				sql`UPDATE api_cloud_workspaces SET provider_sandbox_id=${w.providerSandboxId ?? null}, runtime_boot_token_hash=${w.runtimeBootTokenHash ?? null}, runtime_boot_token_expires_at=${w.runtimeBootTokenExpiresAtMs ?? null}, runtime_credential_hash=${w.runtimeCredentialHash ?? null}, runtime_state=${w.runtimeState}, state=${w.state}, desired_state=${w.desiredState}, status_code=${w.statusCode}, wrapped_transcript_key=${w.wrappedTranscriptKey ?? null}, archive_requested_at=${w.archiveRequestedAtMs ?? null}, archive_delete_at=${w.archiveDeleteAtMs ?? null}, deletion_tombstone_expires_at=${w.deletionTombstoneExpiresAtMs ?? null}, request_config=${JSON.stringify(w.requestConfig)}::jsonb, next_action_at=${w.nextActionAtMs}, revision=${w.revision}, updated_at=${w.updatedAtMs}, last_activity_at=${w.lastActivityAtMs}, running_since=${w.runningSinceMs ?? null}, deleted_at=${w.deletedAtMs ?? null} WHERE workspace_id=${w.workspaceId} AND lease_owner=${input.leaseOwner} AND revision=${input.expectedRevision} AND updated_at=${input.expectedUpdatedAtMs} RETURNING workspace_id`.pipe(
					Effect.map((rows) => rows.length === 1),
				),
			);
		};
		return CloudWorkspaceStore.of({
			listGithubInstallations: (accountId) =>
				orDie(
					sql`SELECT * FROM api_cloud_github_installations WHERE account_id=${accountId} ORDER BY created_at`.pipe(
						Effect.map((rows) =>
							rows.map((row) => githubInstallationFromRow(row as Row)),
						),
					),
				),
			saveGithubInstallation: (installation) =>
				orDie(
					sql`INSERT INTO api_cloud_github_installations (account_id, installation_id, github_account_id, account_login, account_type, avatar_url, repository_selection, suspended, created_at, updated_at) VALUES (${installation.accountId}, ${installation.installationId}, ${installation.githubAccountId}, ${installation.accountLogin}, ${installation.accountType}, ${installation.avatarUrl ?? null}, ${installation.repositorySelection}, ${installation.suspended}, ${installation.createdAtMs}, ${installation.updatedAtMs}) ON CONFLICT (account_id, installation_id) DO UPDATE SET github_account_id=EXCLUDED.github_account_id, account_login=EXCLUDED.account_login, account_type=EXCLUDED.account_type, avatar_url=EXCLUDED.avatar_url, repository_selection=EXCLUDED.repository_selection, suspended=EXCLUDED.suspended, updated_at=EXCLUDED.updated_at`.pipe(
						Effect.asVoid,
					),
				),
			removeGithubInstallation: (accountId, installationId) =>
				orDie(
					sql`DELETE FROM api_cloud_github_installations WHERE account_id=${accountId} AND installation_id=${installationId}`.pipe(
						Effect.asVoid,
					),
				),
			connectProject: (p) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${p.accountId}:${p.repositoryIdentity}`}, 0))`;
						const retry =
							yield* sql`SELECT * FROM api_cloud_projects WHERE account_id=${p.accountId} AND idempotency_key=${p.idempotencyKey} AND included=true LIMIT 1`;
						if (retry[0]) return projectFromRow(retry[0] as Row);
						const rows =
							yield* sql`INSERT INTO api_cloud_projects (project_id, account_id, repository_identity, repository_url, display_name, default_branch, visibility, git_connection_kind, cloud_environment, secret_bindings, configuration_digest, state, included, last_error_code, idempotency_key, created_at, updated_at) VALUES (${p.projectId}, ${p.accountId}, ${p.repositoryIdentity}, ${p.repositoryUrl}, ${p.displayName}, ${p.defaultBranch}, ${p.visibility}, ${p.gitConnectionKind}, ${JSON.stringify(p.cloudEnvironment)}::jsonb, ${JSON.stringify(p.secretBindings)}::jsonb, ${p.configurationDigest}, ${p.state}, true, ${p.lastErrorCode ?? null}, ${p.idempotencyKey}, ${p.createdAtMs}, ${p.updatedAtMs}) ON CONFLICT (account_id, repository_identity) DO UPDATE SET repository_url=EXCLUDED.repository_url, display_name=EXCLUDED.display_name, default_branch=EXCLUDED.default_branch, visibility=EXCLUDED.visibility, cloud_environment=EXCLUDED.cloud_environment, secret_bindings=EXCLUDED.secret_bindings, configuration_digest=EXCLUDED.configuration_digest, state='connected', included=true, last_error_code=NULL, idempotency_key=EXCLUDED.idempotency_key, updated_at=EXCLUDED.updated_at RETURNING *`;
						return projectFromRow(rows[0] as Row);
					}).pipe(sql.withTransaction),
				),
			listProjects: (accountId) =>
				orDie(
					sql`SELECT * FROM api_cloud_projects WHERE account_id=${accountId} AND included=true ORDER BY created_at`.pipe(
						Effect.map((rows) => rows.map((row) => projectFromRow(row as Row))),
					),
				),
			getProject: (id) =>
				orDie(
					sql`SELECT * FROM api_cloud_projects WHERE project_id=${id}`.pipe(
						Effect.map((rows) =>
							rows[0] ? projectFromRow(rows[0] as Row) : null,
						),
					),
				),
			removeProject: (id, nowMs) =>
				orDie(
					sql`UPDATE api_cloud_projects SET included=false, updated_at=${nowMs} WHERE project_id=${id} RETURNING *`.pipe(
						Effect.map((rows) =>
							rows[0] ? projectFromRow(rows[0] as Row) : null,
						),
					),
				),
			saveProject,
			createBuild: (b) =>
				orDie(
					sql`INSERT INTO api_cloud_project_builds (build_id, project_id, account_id, provider, provider_sandbox_id, snapshot_id, source_commit, template_version, configuration_digest, settings, log_text, state, last_error_code, idempotency_key, next_action_at, revision, created_at, updated_at) VALUES (${b.buildId}, ${b.projectId}, ${b.accountId}, ${b.provider}, ${b.providerSandboxId ?? null}, ${b.snapshotId ?? null}, ${b.sourceCommit ?? null}, ${b.templateVersion}, ${b.configurationDigest}, ${JSON.stringify(b.settings ?? {})}::jsonb, ${b.logText ?? null}, ${b.state}, ${b.lastErrorCode ?? null}, ${b.idempotencyKey}, ${b.nextActionAtMs}, ${b.revision}, ${b.createdAtMs}, ${b.updatedAtMs}) ON CONFLICT DO NOTHING RETURNING *`.pipe(
						Effect.flatMap((rows) =>
							rows.length > 0
								? Effect.succeed(buildFromRow(rows[0] as Row))
								: sql`SELECT * FROM api_cloud_project_builds WHERE project_id=${b.projectId} AND provider=${b.provider} AND idempotency_key=${b.idempotencyKey}`.pipe(
										Effect.map((found) => buildFromRow(found[0] as Row)),
									),
						),
					),
				),
			getActiveBuild: (projectId, provider) =>
				orDie(
					sql`SELECT * FROM api_cloud_project_builds WHERE project_id=${projectId} AND provider=${provider} AND state='ready' ORDER BY updated_at DESC LIMIT 1`.pipe(
						Effect.map((rows) =>
							rows[0] ? buildFromRow(rows[0] as Row) : null,
						),
					),
				),
			getActiveAccountBuild: (accountId, provider) =>
				orDie(
					sql`SELECT * FROM api_cloud_project_builds WHERE account_id=${accountId} AND provider=${provider} AND state='ready' ORDER BY updated_at DESC LIMIT 1`.pipe(
						Effect.map((rows) =>
							rows[0] ? buildFromRow(rows[0] as Row) : null,
						),
					),
				),
			listAccountBuilds: (accountId, provider) =>
				orDie(
					sql`SELECT * FROM api_cloud_project_builds WHERE account_id=${accountId} AND provider=${provider} ORDER BY created_at`.pipe(
						Effect.map((rows) => rows.map((row) => buildFromRow(row as Row))),
					),
				),
			getBuild: (id) =>
				orDie(
					sql`SELECT * FROM api_cloud_project_builds WHERE build_id=${id}`.pipe(
						Effect.map((rows) =>
							rows[0] ? buildFromRow(rows[0] as Row) : null,
						),
					),
				),
			claimBuild: (id, leaseOwner, nowMs, leaseExpiresAtMs) =>
				orDie(
					sql`UPDATE api_cloud_project_builds SET lease_owner=${leaseOwner}, lease_expires_at=${leaseExpiresAtMs} WHERE build_id=${id} AND (lease_expires_at IS NULL OR lease_expires_at <= ${nowMs}) RETURNING *`.pipe(
						Effect.map((rows) =>
							rows[0] ? buildFromRow(rows[0] as Row) : null,
						),
					),
				),
			listBuilds: (projectId) =>
				orDie(
					sql`SELECT * FROM api_cloud_project_builds WHERE project_id=${projectId} ORDER BY created_at`.pipe(
						Effect.map((rows) => rows.map((row) => buildFromRow(row as Row))),
					),
				),
			saveBuild,
			listDueBuilds: (nowMs, limit) =>
				orDie(
					sql`SELECT * FROM api_cloud_project_builds WHERE state NOT IN ('ready','failed') AND next_action_at <= ${nowMs} ORDER BY next_action_at LIMIT ${limit}`.pipe(
						Effect.map((rows) => rows.map((row) => buildFromRow(row as Row))),
					),
				),
			listPool: (accountId, provider) =>
				orDie(
					sql`SELECT * FROM api_cloud_workspace_pool WHERE account_id=${accountId} AND provider=${provider} ORDER BY created_at`.pipe(
						Effect.map((rows) => rows.map((row) => poolFromRow(row as Row))),
					),
				),
			savePool: (record) =>
				orDie(
					sql`INSERT INTO api_cloud_workspace_pool (pool_id, account_id, provider, image_generation, provider_sandbox_id, state, claimed_workspace_id, created_at, updated_at) VALUES (${record.poolId}, ${record.accountId}, ${record.provider}, ${record.imageGeneration}, ${record.providerSandboxId}, ${record.state}, ${record.claimedWorkspaceId ?? null}, ${record.createdAtMs}, ${record.updatedAtMs}) ON CONFLICT (pool_id) DO UPDATE SET state=EXCLUDED.state, claimed_workspace_id=EXCLUDED.claimed_workspace_id, updated_at=EXCLUDED.updated_at`.pipe(
						Effect.asVoid,
					),
				),
			claimPool: (accountId, provider, imageGeneration, workspaceId, nowMs) =>
				orDie(
					sql`WITH candidate AS (SELECT pool_id FROM api_cloud_workspace_pool WHERE account_id=${accountId} AND provider=${provider} AND image_generation=${imageGeneration} AND state='available' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE api_cloud_workspace_pool AS pool SET state='claimed', claimed_workspace_id=${workspaceId}, updated_at=${nowMs} FROM candidate WHERE pool.pool_id=candidate.pool_id RETURNING pool.*`.pipe(
						Effect.map((rows) =>
							rows[0] ? poolFromRow(rows[0] as Row) : null,
						),
					),
				),
			removePool: (poolId) =>
				orDie(
					sql`DELETE FROM api_cloud_workspace_pool WHERE pool_id=${poolId}`.pipe(
						Effect.asVoid,
					),
				),
			createWorkspace: (w, launchIntent) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${w.projectId}:${w.branch}`}, 0))`;
						const existing =
							yield* sql`SELECT * FROM api_cloud_workspaces WHERE account_id=${w.accountId} AND idempotency_key=${w.idempotencyKey}`;
						if (existing[0]) {
							return {
								kind: "existing",
								workspace: workspaceFromRow(existing[0] as Row),
							} satisfies CreateCloudWorkspaceOutcome;
						}
						const conflicts =
							yield* sql`SELECT * FROM api_cloud_workspaces WHERE project_id=${w.projectId} AND branch=${w.branch} AND state <> 'deleted' LIMIT 1`;
						if (conflicts[0]) {
							return {
								kind: "branch-in-use",
								workspace: workspaceFromRow(conflicts[0] as Row),
							} satisfies CreateCloudWorkspaceOutcome;
						}
						const created =
							yield* sql`INSERT INTO api_cloud_workspaces (workspace_id, account_id, project_id, build_id, provider, runtime_state, chat_id, initial_session_id, branch, base_ref, state, desired_state, status_code, wrapped_transcript_key, idempotency_key, request_config, next_action_at, revision, created_at, updated_at, last_activity_at) VALUES (${w.workspaceId}, ${w.accountId}, ${w.projectId}, ${w.buildId}, ${w.provider}, ${w.runtimeState}, ${w.chatId}, ${w.initialSessionId}, ${w.branch}, ${w.baseRef}, ${w.state}, ${w.desiredState}, ${w.statusCode}, ${w.wrappedTranscriptKey ?? null}, ${w.idempotencyKey}, ${JSON.stringify(w.requestConfig)}::jsonb, ${w.nextActionAtMs}, ${w.revision}, ${w.createdAtMs}, ${w.updatedAtMs}, ${w.lastActivityAtMs}) RETURNING *`;
						yield* sql`INSERT INTO api_cloud_workspace_launch_intents (workspace_id, account_id, chat_id, session_id, turn_id, command_id, ciphertext, expires_at, created_at) VALUES (${launchIntent.workspaceId}, ${launchIntent.accountId}, ${launchIntent.chatId}, ${launchIntent.sessionId}, ${launchIntent.turnId}, ${launchIntent.commandId}, ${launchIntent.ciphertext}, ${launchIntent.expiresAtMs}, ${launchIntent.createdAtMs})`;
						return {
							kind: "created",
							workspace: workspaceFromRow(created[0] as Row),
						} satisfies CreateCloudWorkspaceOutcome;
					}).pipe(sql.withTransaction),
				),
			listWorkspaces: (accountId, projectId) =>
				orDie(
					(projectId === undefined
						? sql`SELECT * FROM api_cloud_workspaces WHERE account_id=${accountId} ORDER BY created_at`
						: sql`SELECT * FROM api_cloud_workspaces WHERE account_id=${accountId} AND project_id=${projectId} ORDER BY created_at`
					).pipe(
						Effect.map((rows) =>
							rows.map((row) => workspaceFromRow(row as Row)),
						),
					),
				),
			getWorkspace: (id) =>
				orDie(
					sql`SELECT * FROM api_cloud_workspaces WHERE workspace_id=${id}`.pipe(
						Effect.map((rows) =>
							rows[0] ? workspaceFromRow(rows[0] as Row) : null,
						),
					),
				),
			claimWorkspace: (id, leaseOwner, nowMs, leaseExpiresAtMs) =>
				orDie(
					sql`UPDATE api_cloud_workspaces SET lease_owner=${leaseOwner}, lease_expires_at=${leaseExpiresAtMs} WHERE workspace_id=${id} AND (lease_expires_at IS NULL OR lease_expires_at <= ${nowMs}) RETURNING *`.pipe(
						Effect.map((rows) =>
							rows[0] ? workspaceFromRow(rows[0] as Row) : null,
						),
					),
				),
			saveWorkspace,
			getWorkspaceLifecycleCommand: (workspaceId, commandId) =>
				orDie(
					sql`SELECT action FROM api_cloud_workspace_command_receipts WHERE workspace_id=${workspaceId} AND command_id=${commandId}`.pipe(
						Effect.map((rows) =>
							rows[0] === undefined ? null : String(rows[0].action),
						),
					),
				),
			saveWorkspaceLifecycleCommand: (input) =>
				orDie(
					Effect.gen(function* () {
						yield* saveWorkspace(input.workspace);
						yield* sql`INSERT INTO api_cloud_workspace_command_receipts (workspace_id, command_id, action, workspace_revision, created_at) VALUES (${input.workspace.workspaceId}, ${input.commandId}, ${input.action}, ${input.workspace.revision}, ${input.createdAtMs}) ON CONFLICT (workspace_id, command_id) DO NOTHING`;
					}).pipe(sql.withTransaction),
				),
			saveClaimedWorkspace,
			releaseWorkspaceLease: (workspaceId, leaseOwner) =>
				orDie(
					sql`UPDATE api_cloud_workspaces SET lease_owner=NULL, lease_expires_at=NULL WHERE workspace_id=${workspaceId} AND lease_owner=${leaseOwner} RETURNING workspace_id`.pipe(
						Effect.map((rows) => rows.length === 1),
					),
				),
			getLaunchIntent: (workspaceId, nowMs) =>
				orDie(
					sql`WITH expired AS (
						DELETE FROM api_cloud_workspace_launch_intents
						WHERE workspace_id=${workspaceId} AND expires_at <= ${nowMs}
						RETURNING workspace_id
					), mark_expired AS (
						UPDATE api_cloud_workspaces
						SET state='failed', status_code='launch-intent-expired', revision=revision+1, updated_at=${nowMs}
						WHERE workspace_id IN (SELECT workspace_id FROM expired) AND state <> 'deleted'
					)
					SELECT * FROM api_cloud_workspace_launch_intents
					WHERE workspace_id=${workspaceId} AND expires_at > ${nowMs}`.pipe(
						Effect.map((rows) => {
							const row = rows[0];
							return row === undefined
								? null
								: {
										workspaceId: String(row.workspace_id),
										accountId: String(row.account_id),
										chatId: String(row.chat_id),
										sessionId: String(row.session_id),
										turnId: String(row.turn_id),
										commandId: String(row.command_id),
										ciphertext: String(row.ciphertext),
										expiresAtMs: numberValue(row.expires_at),
										createdAtMs: numberValue(row.created_at),
									};
						}),
					),
				),
			deleteLaunchIntent: (workspaceId) =>
				orDie(
					sql`DELETE FROM api_cloud_workspace_launch_intents WHERE workspace_id=${workspaceId}`.pipe(
						Effect.asVoid,
					),
				),
			completeLaunchIntent: (input) =>
				orDie(
					Effect.gen(function* () {
						const rows =
							yield* sql`SELECT * FROM api_cloud_workspaces WHERE workspace_id=${input.workspaceId} FOR UPDATE`;
						const row = rows[0];
						if (row === undefined)
							return { kind: "workspace-missing" as const };
						const workspace = workspaceFromRow(row as Row);
						const intents =
							yield* sql`SELECT command_id FROM api_cloud_workspace_launch_intents WHERE workspace_id=${input.workspaceId} FOR UPDATE`;
						const intentCommandId = intents[0]?.command_id;
						if (
							intentCommandId !== input.commandId &&
							!(
								intentCommandId === undefined &&
								canRecoverMissingLaunchIntent(workspace, input)
							)
						)
							return { kind: "rejected" as const };
						const completed = completeLaunchWorkspace(workspace, input);
						yield* sql`UPDATE api_cloud_workspaces SET runtime_state=${completed.runtimeState}, state=${completed.state}, status_code=${completed.statusCode}, request_config=${JSON.stringify(completed.requestConfig)}::jsonb, next_action_at=${completed.nextActionAtMs}, running_since=${completed.runningSinceMs ?? null}, revision=${completed.revision}, updated_at=${completed.updatedAtMs}, last_activity_at=${completed.lastActivityAtMs} WHERE workspace_id=${input.workspaceId}`;
						yield* sql`DELETE FROM api_cloud_workspace_launch_intents WHERE workspace_id=${input.workspaceId}`;
						return { kind: "completed" as const, workspace: completed };
					}).pipe(sql.withTransaction),
				),
			enrollRuntimeBoot: (input) =>
				orDie(
					Effect.gen(function* () {
						const receipt: RuntimeBootstrapReceipt = {
							workspaceId: input.workspaceId,
							bootTokenHash: input.bootTokenHash,
							credentialKeyThumbprint: input.credentialKeyThumbprint,
							signingKeyThumbprint: input.signingKeyThumbprint,
							signingPublicJwk: input.signingPublicJwk,
							runtimeCredentialHash: input.runtimeCredentialHash,
							runtimeCredentialExpiresAtMs: input.runtimeCredentialExpiresAtMs,
							generation: input.generation,
							gatewayEpoch: input.gatewayEpoch,
							sealedTranscriptKey: input.sealedTranscriptKey,
							enrolledAtMs: input.nowMs,
						};
						const configPatch = {
							runtimeSigningPublicJwk: input.signingPublicJwk,
							runtimeSigningKeyThumbprint: input.signingKeyThumbprint,
							runtimeCredentialKeyThumbprint: input.credentialKeyThumbprint,
							runtimeGeneration: input.generation,
							gatewayEpoch: input.gatewayEpoch,
							runtimeCredentialExpiresAtMs: input.runtimeCredentialExpiresAtMs,
							runtimeBootstrapReceipt: receipt,
						};
						const rows = yield* sql`WITH current AS MATERIALIZED (
							SELECT * FROM api_cloud_workspaces
							WHERE workspace_id=${input.workspaceId}
							FOR UPDATE
						), updated AS (
							UPDATE api_cloud_workspaces AS target
							SET runtime_credential_hash=${input.runtimeCredentialHash},
								runtime_state='connecting',
								state='setup',
								status_code='runtime-authenticating',
								request_config=current.request_config || ${JSON.stringify(configPatch)}::jsonb || jsonb_build_object(
									'startupTimings',
									COALESCE(current.request_config->'startupTimings', '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
										'enrolledAt', ${input.nowMs}::bigint,
										'runtimeReadyAt', ${input.nowMs}::bigint,
										'enrollmentDurationMs', CASE
											WHEN jsonb_typeof(current.request_config #> '{startupTimings,allocatedAt}') = 'number'
											THEN ${input.nowMs}::bigint - (current.request_config #>> '{startupTimings,allocatedAt}')::bigint
											ELSE NULL
										END
									))
								),
								next_action_at=${input.nowMs + 30_000},
								revision=current.revision+1,
								updated_at=${input.nowMs}
							FROM current
							WHERE target.workspace_id=current.workspace_id
								AND current.runtime_boot_token_hash=${input.bootTokenHash}
								AND current.runtime_boot_token_expires_at > ${input.nowMs}
								AND current.desired_state='ready'
								AND current.provider_sandbox_id IS NOT NULL
								AND current.state <> 'deleted'
								AND COALESCE((current.request_config->>'runtimeGeneration')::bigint, 0)=${input.generation}
								AND COALESCE((current.request_config->>'gatewayEpoch')::bigint, COALESCE((current.request_config->>'runtimeGeneration')::bigint, 0))=${input.gatewayEpoch}
								AND current.request_config->'runtimeBootstrapReceipt' IS NULL
							RETURNING target.*, 'created'::text AS enrollment_kind
						), replayed AS (
							SELECT current.*, 'replay'::text AS enrollment_kind
							FROM current
							WHERE NOT EXISTS (SELECT 1 FROM updated)
								AND current.runtime_boot_token_hash=${input.bootTokenHash}
								AND current.runtime_boot_token_expires_at > ${input.nowMs}
								AND current.desired_state='ready'
								AND current.provider_sandbox_id IS NOT NULL
								AND current.state <> 'deleted'
								AND current.request_config #>> '{runtimeBootstrapReceipt,bootTokenHash}'=${input.bootTokenHash}
								AND current.request_config #>> '{runtimeBootstrapReceipt,credentialKeyThumbprint}'=${input.credentialKeyThumbprint}
								AND current.request_config #>> '{runtimeBootstrapReceipt,signingKeyThumbprint}'=${input.signingKeyThumbprint}
								AND (current.request_config #>> '{runtimeBootstrapReceipt,generation}')::bigint=${input.generation}
								AND (current.request_config #>> '{runtimeBootstrapReceipt,gatewayEpoch}')::bigint=${input.gatewayEpoch}
								AND current.request_config #>> '{runtimeBootstrapReceipt,runtimeCredentialHash}'=${input.runtimeCredentialHash}
						)
						SELECT enrollment.*, to_jsonb(intent) AS launch_intent
						FROM (
							SELECT * FROM updated
							UNION ALL
							SELECT * FROM replayed
						) AS enrollment
						LEFT JOIN api_cloud_workspace_launch_intents AS intent
							ON intent.workspace_id=enrollment.workspace_id AND intent.expires_at > ${input.nowMs}`;
						const row = rows[0];
						if (row === undefined) return null;
						const enrolled = workspaceFromRow(row as Row);
						const enrolledReceipt = runtimeBootstrapReceiptFromConfig(
							enrolled.requestConfig,
						);
						if (enrolledReceipt === null) return null;
						return {
							kind:
								row.enrollment_kind === "replay"
									? ("replay" as const)
									: ("created" as const),
							workspace: enrolled,
							receipt: enrolledReceipt,
							launchIntent: launchIntentFromRow(
								(row.launch_intent as Row | null | undefined) ?? null,
							),
						};
					}),
				),
			markRuntimeRepositoryReady: (input) =>
				orDie(
					sql`UPDATE api_cloud_workspaces
					SET runtime_state='online',
						state=CASE WHEN jsonb_typeof(request_config->'sessionHeadVersion')='number' AND COALESCE((request_config->>'runtimeSessionRecoveryPending')::boolean, false)=false THEN 'ready' ELSE 'setup' END,
						status_code=CASE WHEN jsonb_typeof(request_config->'sessionHeadVersion')='number' AND COALESCE((request_config->>'runtimeSessionRecoveryPending')::boolean, false)=false THEN 'agent-running' ELSE 'agent-starting' END,
						request_config=request_config || jsonb_build_object(
							'runtimeProcessManaged', true,
							'startupTimings', COALESCE(request_config->'startupTimings', '{}'::jsonb) || jsonb_build_object(
								'connectedAt', COALESCE(request_config #> '{startupTimings,connectedAt}', to_jsonb(${input.nowMs}::bigint)),
								'repositoryReadyAt', COALESCE(request_config #> '{startupTimings,repositoryReadyAt}', to_jsonb(${input.nowMs}::bigint))
							)
						),
						next_action_at=CASE WHEN jsonb_typeof(request_config->'sessionHeadVersion')='number' AND COALESCE((request_config->>'runtimeSessionRecoveryPending')::boolean, false)=false THEN ${input.nextIdleAtMs}::bigint ELSE ${input.nowMs + 30_000}::bigint END,
						running_since=COALESCE(running_since, ${input.nowMs}),
						revision=revision+1,
						updated_at=${input.nowMs},
						last_activity_at=${input.nowMs}
					WHERE workspace_id=${input.workspaceId}
						AND runtime_credential_hash=${input.currentCredentialHash}
						AND (request_config->>'runtimeCredentialExpiresAtMs')::bigint > ${input.nowMs}
						AND state <> 'deleted'
					RETURNING *`.pipe(
						Effect.map((rows) =>
							rows[0] === undefined ? null : workspaceFromRow(rows[0] as Row),
						),
					),
				),
			acknowledgeRuntimeBoot: (input) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`runtime-bootstrap:${input.workspaceId}`}, 0))`;
						const rows =
							yield* sql`SELECT * FROM api_cloud_workspaces WHERE workspace_id=${input.workspaceId} FOR UPDATE`;
						const row = rows[0];
						if (row === undefined) return false;
						const workspace = workspaceFromRow(row as Row);
						const receipt = runtimeBootstrapReceiptFromConfig(
							workspace.requestConfig,
						);
						if (
							workspace.runtimeCredentialHash !== input.currentCredentialHash ||
							receipt === null ||
							receipt.runtimeCredentialHash !== input.currentCredentialHash ||
							receipt.generation !== input.generation ||
							receipt.gatewayEpoch !== input.gatewayEpoch ||
							workspaceRuntimeGeneration(workspace) !== input.generation ||
							workspace.requestConfig.gatewayEpoch !== input.gatewayEpoch ||
							workspace.state === "deleted"
						)
							return false;
						if (receipt.acknowledgedAtMs !== undefined) return true;
						const nextConfig = {
							...workspace.requestConfig,
							runtimeBootstrapReceipt: {
								...receipt,
								acknowledgedAtMs: input.nowMs,
							},
						};
						const updated =
							yield* sql`UPDATE api_cloud_workspaces SET runtime_boot_token_hash=NULL, runtime_boot_token_expires_at=NULL, request_config=${JSON.stringify(nextConfig)}::jsonb, revision=revision+1, updated_at=${Math.max(input.nowMs, workspace.updatedAtMs + 1)} WHERE workspace_id=${input.workspaceId} AND runtime_credential_hash=${input.currentCredentialHash} RETURNING workspace_id`;
						return updated.length === 1;
					}).pipe(sql.withTransaction),
				),
			renewRuntimeCredential: (input) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`runtime-renew:${input.workspaceId}`}, 0))`;
						const rows =
							yield* sql`SELECT request_config, runtime_credential_hash, state FROM api_cloud_workspaces WHERE workspace_id=${input.workspaceId} FOR UPDATE`;
						const row = rows[0] as
							| {
									readonly request_config?: Record<string, unknown>;
									readonly runtime_credential_hash?: string | null;
									readonly state?: string;
							  }
							| undefined;
						const config = row?.request_config;
						const prior = config?.runtimeCredentialRenewal as
							| Record<string, unknown>
							| undefined;
						if (
							prior?.requestId === input.requestId &&
							Number(prior.expiresAtMs) > input.nowMs &&
							prior.previousCredentialHash === input.currentCredentialHash
						)
							return renewalReceiptFromConfig(input.workspaceId, prior);
						if (
							row === undefined ||
							row.runtime_credential_hash !== input.currentCredentialHash ||
							row.state === "deleted" ||
							Number(config?.runtimeCredentialExpiresAtMs) <= input.nowMs
						)
							return null;
						const updated =
							yield* sql`UPDATE api_cloud_workspaces SET runtime_credential_hash=${input.nextCredentialHash}, request_config=jsonb_set(jsonb_set(request_config, '{runtimeCredentialExpiresAtMs}', to_jsonb(${input.expiresAtMs}::bigint), true), '{runtimeCredentialRenewal}', jsonb_build_object('requestId', ${input.requestId}::text, 'credentialHash', ${input.nextCredentialHash}::text, 'previousCredentialHash', ${input.currentCredentialHash}::text, 'expiresAtMs', ${input.expiresAtMs}::bigint, 'generation', ${input.generation}::bigint, 'gatewayEpoch', ${input.gatewayEpoch}::bigint), true) WHERE workspace_id=${input.workspaceId} RETURNING request_config`;
						const updatedConfig = updated[0]?.request_config as
							| Record<string, unknown>
							| undefined;
						const receipt = updatedConfig?.runtimeCredentialRenewal as
							| Record<string, unknown>
							| undefined;
						return receipt === undefined
							? null
							: renewalReceiptFromConfig(input.workspaceId, receipt);
					}).pipe(sql.withTransaction),
				),
			listDueWorkspaces: (nowMs, limit) =>
				orDie(
					sql`SELECT * FROM api_cloud_workspaces WHERE state <> 'deleted' AND next_action_at <= ${nowMs} ORDER BY next_action_at LIMIT ${limit}`.pipe(
						Effect.map((rows) =>
							rows.map((row) => workspaceFromRow(row as Row)),
						),
					),
				),
			recordActivity: (workspaceId, accountId, nowMs, nextIdleAtMs) =>
				orDie(
					sql`UPDATE api_cloud_workspaces SET desired_state=CASE WHEN state='paused' THEN 'ready' ELSE desired_state END, status_code=CASE WHEN state='paused' THEN 'resume-queued' ELSE status_code END, request_config=CASE WHEN state='paused' THEN jsonb_set(request_config, '{startupTimings}', jsonb_build_object('requestedAt', ${nowMs}::bigint, 'resumeRequestedAt', ${nowMs}::bigint), true) ELSE request_config END, next_action_at=CASE WHEN state='paused' THEN ${nowMs} WHEN state='ready' THEN ${nextIdleAtMs} ELSE next_action_at END, last_activity_at=${nowMs}, revision=revision+1, updated_at=${nowMs} WHERE workspace_id=${workspaceId} AND account_id=${accountId} AND state <> 'deleted' RETURNING *`.pipe(
						Effect.map((rows) =>
							rows[0] ? workspaceFromRow(rows[0] as Row) : null,
						),
					),
				),
			requestMailboxWake: (workspaceId, accountId, nowMs, nextIdleAtMs) =>
				orDie(
					sql`UPDATE api_cloud_workspaces SET
						desired_state='ready',
						status_code=CASE WHEN state IN ('paused','pausing') THEN 'resume-queued' ELSE status_code END,
						request_config=CASE WHEN state IN ('paused','pausing') THEN jsonb_set(request_config, '{startupTimings}', jsonb_build_object('requestedAt', ${nowMs}::bigint, 'resumeRequestedAt', ${nowMs}::bigint), true) ELSE request_config END,
						next_action_at=CASE WHEN state='ready' THEN ${nextIdleAtMs} ELSE ${nowMs} END,
						last_activity_at=${nowMs}, revision=revision+1, updated_at=${nowMs}
					 WHERE workspace_id=${workspaceId} AND account_id=${accountId}
						AND state NOT IN ('archived','archiving','deleted','deleting')
						AND desired_state NOT IN ('archived','deleted')
					 RETURNING *`.pipe(
						Effect.map((rows) =>
							rows[0] ? workspaceFromRow(rows[0] as Row) : null,
						),
					),
				),
			installWrappedTranscriptKey: (
				workspaceId,
				accountId,
				wrappedTranscriptKey,
				nowMs,
			) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`UPDATE api_cloud_workspaces SET
							wrapped_transcript_key=${wrappedTranscriptKey},
							revision=revision+1,
							updated_at=GREATEST(${nowMs}, updated_at+1)
						 WHERE workspace_id=${workspaceId} AND account_id=${accountId}
							AND wrapped_transcript_key IS NULL`;
						const rows = yield* sql`SELECT * FROM api_cloud_workspaces
						 WHERE workspace_id=${workspaceId} AND account_id=${accountId} LIMIT 1`;
						return rows[0] ? workspaceFromRow(rows[0] as Row) : null;
					}).pipe(sql.withTransaction),
				),
			getRuntimeSummary: (workspaceId) =>
				orDie(
					sql`SELECT * FROM api_cloud_workspace_runtime_summaries WHERE workspace_id=${workspaceId}`.pipe(
						Effect.map((rows) =>
							rows[0] ? runtimeSummaryFromRow(rows[0] as Row) : null,
						),
					),
				),
			saveRuntimeSummary: (input) =>
				orDie(
					Effect.gen(function* () {
						const rows = yield* sql`
							INSERT INTO api_cloud_workspace_runtime_summaries
								(workspace_id, runtime_generation, summary_revision, title, last_activity_at, session_head_version, updated_at)
							SELECT ${input.workspaceId}, ${input.runtimeGeneration}, ${input.summaryRevision}, ${input.title}, ${input.lastActivityAtMs}, ${input.sessionHeadVersion}, ${input.updatedAtMs}
							FROM api_cloud_workspaces AS workspace
							WHERE workspace.workspace_id=${input.workspaceId}
								AND COALESCE((workspace.request_config->>'runtimeGeneration')::bigint, 1)=${input.runtimeGeneration}
							ON CONFLICT (workspace_id) DO UPDATE SET
								runtime_generation=EXCLUDED.runtime_generation,
								summary_revision=EXCLUDED.summary_revision,
								title=EXCLUDED.title,
								last_activity_at=CASE
									WHEN api_cloud_workspace_runtime_summaries.runtime_generation=EXCLUDED.runtime_generation
									THEN GREATEST(api_cloud_workspace_runtime_summaries.last_activity_at, EXCLUDED.last_activity_at)
									ELSE EXCLUDED.last_activity_at
								END,
								session_head_version=CASE
									WHEN api_cloud_workspace_runtime_summaries.runtime_generation=EXCLUDED.runtime_generation
									THEN GREATEST(api_cloud_workspace_runtime_summaries.session_head_version, EXCLUDED.session_head_version)
									ELSE EXCLUDED.session_head_version
								END,
								updated_at=EXCLUDED.updated_at
							WHERE EXCLUDED.runtime_generation > api_cloud_workspace_runtime_summaries.runtime_generation
								OR (
									EXCLUDED.runtime_generation = api_cloud_workspace_runtime_summaries.runtime_generation
									AND EXCLUDED.summary_revision > api_cloud_workspace_runtime_summaries.summary_revision
								)
							RETURNING *
						`;
						if (rows[0] !== undefined)
							return {
								kind: "applied" as const,
								summary: runtimeSummaryFromRow(rows[0] as Row),
							};
						const existingRows = yield* sql`
							SELECT summary.*,
								COALESCE((workspace.request_config->>'runtimeGeneration')::bigint, 1) AS current_runtime_generation
							FROM api_cloud_workspaces AS workspace
							LEFT JOIN api_cloud_workspace_runtime_summaries AS summary USING (workspace_id)
							WHERE workspace.workspace_id=${input.workspaceId}
						`;
						const existing = existingRows[0] as Row | undefined;
						if (existing === undefined)
							return { kind: "workspace-missing" as const };
						if (
							numberValue(existing.current_runtime_generation) !==
							input.runtimeGeneration
						)
							return { kind: "rejected-generation" as const };
						return {
							kind: "stale" as const,
							summary: runtimeSummaryFromRow(existing),
						};
					}).pipe(sql.withTransaction),
				),
			getTranscriptCheckpoint: (workspaceId, sessionId) =>
				orDie(
					sql`SELECT * FROM api_cloud_transcript_checkpoints WHERE workspace_id=${workspaceId} AND session_id=${sessionId} LIMIT 1`.pipe(
						Effect.map((rows) =>
							rows[0] ? transcriptCheckpointFromRow(rows[0] as Row) : null,
						),
					),
				),
			saveTranscriptCheckpoint: (checkpoint) =>
				orDie(
					sql`
						INSERT INTO api_cloud_transcript_checkpoints
							(workspace_id, session_id, runtime_generation, stream_epoch,
							 stream_version, object_key, ciphertext_sha256,
							 ciphertext_bytes, created_at)
						SELECT ${checkpoint.workspaceId}, ${checkpoint.sessionId},
							${checkpoint.runtimeGeneration}, ${checkpoint.streamEpoch},
							${checkpoint.streamVersion}, ${checkpoint.objectKey},
							${checkpoint.ciphertextSha256}, ${checkpoint.ciphertextBytes},
							${checkpoint.createdAtMs}
						FROM api_cloud_workspaces AS workspace
						WHERE workspace.workspace_id=${checkpoint.workspaceId}
							AND COALESCE((workspace.request_config->>'runtimeGeneration')::bigint,
								1)=${checkpoint.runtimeGeneration}
						ON CONFLICT (workspace_id, session_id) DO UPDATE SET
							runtime_generation=EXCLUDED.runtime_generation,
							stream_epoch=EXCLUDED.stream_epoch,
							stream_version=EXCLUDED.stream_version,
							object_key=EXCLUDED.object_key,
							ciphertext_sha256=EXCLUDED.ciphertext_sha256,
							ciphertext_bytes=EXCLUDED.ciphertext_bytes,
							created_at=EXCLUDED.created_at
						WHERE (EXCLUDED.runtime_generation > api_cloud_transcript_checkpoints.runtime_generation
							AND EXCLUDED.stream_version >= api_cloud_transcript_checkpoints.stream_version)
							OR (EXCLUDED.runtime_generation = api_cloud_transcript_checkpoints.runtime_generation
								AND EXCLUDED.stream_epoch = api_cloud_transcript_checkpoints.stream_epoch
								AND EXCLUDED.stream_version > api_cloud_transcript_checkpoints.stream_version)
						RETURNING workspace_id
					`.pipe(Effect.map((rows) => rows.length === 1)),
				),
			deleteTranscriptCheckpoints: (workspaceId) =>
				orDie(
					sql`DELETE FROM api_cloud_transcript_checkpoints WHERE workspace_id=${workspaceId}`.pipe(
						Effect.asVoid,
					),
				),
			deleteAccountData: (accountId) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`DELETE FROM api_cloud_workspace_usage WHERE account_id=${accountId}`;
						yield* sql`DELETE FROM api_cloud_workspaces WHERE account_id=${accountId}`;
						yield* sql`DELETE FROM api_cloud_project_builds WHERE account_id=${accountId}`;
						yield* sql`DELETE FROM api_cloud_projects WHERE account_id=${accountId}`;
						yield* sql`DELETE FROM api_cloud_github_installations WHERE account_id=${accountId}`;
					}).pipe(sql.withTransaction),
				),
			recordUsage: (event) =>
				orDie(
					sql`INSERT INTO api_cloud_workspace_usage (event_id, workspace_id, account_id, provider, kind, quantity, provider_event_id, occurred_at, created_at) VALUES (${event.eventId}, ${event.workspaceId}, ${event.accountId}, ${event.provider}, ${event.kind}, ${event.quantity}, ${event.providerEventId ?? null}, ${event.occurredAtMs}, ${Date.now()}) ON CONFLICT DO NOTHING RETURNING event_id`.pipe(
						Effect.map((rows) => rows.length > 0),
					),
				),
		});
	}),
);
