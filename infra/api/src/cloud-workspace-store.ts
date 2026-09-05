import {
	CLOUD_COMMAND_PROTOCOL_VERSION,
	type CloudProjectBuildState,
	type CloudProjectState,
	type CloudWorkspaceDesiredState,
	type CloudWorkspaceState,
	type TurnSettlementOutcome,
} from "@zuse/contracts";
import { Context, Effect, Layer, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
	cloudWorkspaceGatewayEpoch,
	cloudWorkspaceRuntimeGeneration,
} from "./cloud-workspace-runtime-fence.ts";

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

export interface CloudAuthAuthorityRecord {
	readonly accountId: string;
	readonly provider: string;
	readonly providerSandboxId?: string;
	readonly storageIncarnationId: string;
	readonly authEpoch: number;
	readonly toolchainVersion: string;
	readonly state: "provisioning" | "ready" | "error";
	readonly provisioningLeaseOwner?: string;
	readonly provisioningLeaseExpiresAtMs?: number;
	readonly revision: number;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

export interface CloudAuthAuthorityClaim {
	readonly record: CloudAuthAuthorityRecord;
	readonly acquired: boolean;
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

export type CloudMailboxLifecycleAction = "archive" | "delete";

export type CloudWorkspaceLifecycleAction =
	| "pause"
	| "resume"
	| "restart"
	| "archive"
	| "unarchive"
	| "delete";

export interface CloudMailboxLifecycleFence {
	readonly workspaceId: string;
	readonly action: CloudMailboxLifecycleAction;
	readonly destructionFence: number;
}

export type CloudWorkspaceLifecycleTransitionOutcome =
	| {
			readonly kind: "applied" | "replay";
			readonly workspace: CloudWorkspaceRecord;
			readonly action: CloudWorkspaceLifecycleAction;
	  }
	| {
			readonly kind: "contended";
			readonly workspace: CloudWorkspaceRecord;
	  }
	| {
			readonly kind: "rejected";
			readonly workspace: CloudWorkspaceRecord;
			readonly reason:
				| "command-id-reused"
				| "destruction-fence-exhausted"
				| "workspace-archived"
				| "workspace-deleted"
				| "mailbox-wake-pending"
				| "workspace-not-running"
				| "workspace-not-archived";
	  }
	| { readonly kind: "missing" };

export interface CloudWorkspaceLifecycleTransitionInput {
	readonly workspace: CloudWorkspaceRecord;
	readonly expectedRevision: number;
	readonly expectedUpdatedAtMs: number;
	readonly expectedState: CloudWorkspaceState;
	readonly expectedDesiredState: CloudWorkspaceDesiredState;
	readonly commandId?: string;
	readonly action: CloudWorkspaceLifecycleAction;
	/** Persist the receipt without rewriting an already-requested normal resume. */
	readonly deduplicateRequestedResume?: boolean;
	readonly createdAtMs: number;
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
 * The only session-derived state retained by Api after runtime bootstrap.
 * It is metadata-only and fenced independently from workspace lifecycle
 * revisions so reconciler writes cannot regress a newer runtime summary.
 */
export interface CloudWorkspaceRuntimeSummaryRecord {
	readonly workspaceId: string;
	readonly runtimeGeneration: number;
	readonly summaryRevision: number;
	readonly title: string;
	readonly lastActivityAtMs: number;
	readonly activeSessionId: string | null;
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
	capabilities: Schema.optional(Schema.Array(Schema.String)),
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
	readonly capabilities?: ReadonlyArray<string>;
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

export interface ApiKeyRecord {
	readonly keyId: string;
	readonly accountId: string;
	readonly name: string;
	readonly secretHash: string;
	readonly prefix: string;
	readonly createdAtMs: number;
	readonly lastUsedAtMs?: number;
	readonly revokedAtMs?: number;
}

export interface ApiWebhookRecord {
	readonly webhookId: string;
	readonly accountId: string;
	readonly url: string;
	readonly sealedSecret: string;
	readonly description?: string;
	readonly createdAtMs: number;
	readonly disabledAtMs?: number;
}

export type ApiMessageRole = "user" | "assistant";

export type ApiMessageStatus =
	| "pending"
	| "delivered"
	| "settled"
	| "failed"
	| "expired";

/**
 * One row of the public-API conversation ledger. User rows double as the
 * pending-command queue drained by the in-sandbox runtime; assistant rows are
 * appended from runtime turn events. `sealedContent` is encrypted with the
 * api data-encryption key.
 */
export interface CloudWorkspaceApiMessageRecord {
	readonly messageId: string;
	readonly workspaceId: string;
	readonly accountId: string;
	readonly seq: number;
	readonly role: ApiMessageRole;
	readonly sealedContent: string;
	readonly commandId?: string;
	readonly turnId?: string;
	readonly outcome?: TurnSettlementOutcome;
	readonly status: ApiMessageStatus;
	readonly createdAtMs: number;
	/** Api receive time of the latest runtime command fetch while pending. */
	readonly deliveryAttemptedAtMs?: number;
	readonly deliveredAtMs?: number;
	readonly expiresAtMs?: number;
}

export interface AppendApiMessageInput {
	readonly messageId: string;
	readonly workspaceId: string;
	readonly accountId: string;
	readonly role: ApiMessageRole;
	readonly sealedContent: string;
	readonly commandId?: string;
	readonly turnId?: string;
	readonly outcome?: TurnSettlementOutcome;
	readonly status: ApiMessageStatus;
	readonly createdAtMs: number;
	readonly expiresAtMs?: number;
}

export interface AppendApiMessageOutcome {
	readonly kind: "created" | "existing";
	readonly message: CloudWorkspaceApiMessageRecord;
}

export type CloudWorkspaceVersion = Pick<
	CloudWorkspaceRecord,
	"workspaceId" | "revision" | "updatedAtMs"
>;

export interface WorkspaceLifecycleCommandWrite {
	readonly workspace: CloudWorkspaceRecord;
	readonly commandId: string;
	readonly action: string;
	readonly createdAtMs: number;
}

export interface AppendApiMessageGuardedInput {
	readonly message: AppendApiMessageInput;
	readonly expectedWorkspace: CloudWorkspaceVersion;
	readonly lifecycleCommand?: WorkspaceLifecycleCommandWrite;
}

export type AppendApiMessageGuardedOutcome =
	| {
			readonly kind: "committed";
			readonly append: AppendApiMessageOutcome;
			readonly workspace: CloudWorkspaceRecord;
			readonly lifecycleCommandSaved: boolean;
	  }
	| {
			readonly kind: "workspace-contended";
			readonly workspace: CloudWorkspaceRecord | null;
	  };

export interface RecordApiTurnEventInput {
	readonly messageId: string;
	readonly workspaceId: string;
	readonly accountId: string;
	readonly turnId: string;
	readonly outcome: TurnSettlementOutcome;
	readonly sealedContent: string;
	readonly contentDigest: string;
	readonly nowMs: number;
	/** Api receive time, independent from the runtime-authored settlement time. */
	readonly receivedAtMs: number;
	readonly webhookFanout?: ApiTurnWebhookFanout;
	/** Route-verified adoption of an assistant row written before turn receipts. */
	readonly adoptLegacyReplay?: boolean;
}

export interface ApiTurnWebhookFanout {
	readonly eventId: string;
	readonly eventType: "workspace.turn.completed";
	readonly sealedPayload: string;
	readonly enqueuedAtMs: number;
	readonly targets: ReadonlyArray<{
		readonly webhookId: string;
		readonly deliveryId: string;
	}>;
}

export interface ApiTurnReceipt {
	readonly workspaceId: string;
	readonly turnId: string;
	readonly outcome: TurnSettlementOutcome;
	readonly settledAtMs: number;
	readonly receivedAtMs: number;
	readonly contentDigest: string;
}

export type RecordApiTurnEventOutcome =
	| {
			readonly kind: "created" | "replay";
			readonly message: CloudWorkspaceApiMessageRecord;
			readonly receipt: ApiTurnReceipt;
	  }
	| { readonly kind: "pruned-replay"; readonly receipt: ApiTurnReceipt }
	| { readonly kind: "conflict"; readonly receipt: ApiTurnReceipt };

export interface ApiWorkspaceLedgerSummary {
	readonly latestSeq: number;
	readonly hasOutstanding: boolean;
	readonly lastAssistant: CloudWorkspaceApiMessageRecord | null;
}

export interface ApiWebhookDeliveryRecord {
	readonly deliveryId: string;
	readonly webhookId: string;
	readonly accountId: string;
	readonly eventId: string;
	readonly eventType: string;
	readonly sealedPayload: string;
	readonly status: "pending" | "delivered" | "failed";
	readonly attempts: number;
	readonly nextAttemptAtMs: number;
	readonly lastError?: string;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

export interface DueApiWebhookDelivery {
	readonly delivery: ApiWebhookDeliveryRecord;
	readonly url: string;
	readonly sealedSecret: string;
}

export interface CloudWorkspaceStoreApi {
	readonly getCloudAuthAuthority: (
		accountId: string,
	) => Effect.Effect<CloudAuthAuthorityRecord | null>;
	readonly claimCloudAuthAuthority: (input: {
		readonly accountId: string;
		readonly provider: string;
		readonly candidateStorageIncarnationId: string;
		readonly toolchainVersion: string;
		readonly leaseOwner: string;
		readonly nowMs: number;
		readonly leaseExpiresAtMs: number;
		/** Explicit account reconnect may replace a ready locator whose storage is gone. */
		readonly replaceReady?: boolean;
	}) => Effect.Effect<CloudAuthAuthorityClaim>;
	readonly completeCloudAuthAuthorityProvisioning: (input: {
		readonly accountId: string;
		readonly providerSandboxId: string;
		readonly storageIncarnationId: string;
		readonly toolchainVersion: string;
		readonly leaseOwner: string;
		readonly nowMs: number;
	}) => Effect.Effect<CloudAuthAuthorityRecord | null>;
	readonly advanceCloudAuthEpoch: (input: {
		readonly accountId: string;
		readonly providerSandboxId: string;
		readonly nowMs: number;
	}) => Effect.Effect<CloudAuthAuthorityRecord | null>;
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
	readonly transitionWorkspaceLifecycle: (
		input: CloudWorkspaceLifecycleTransitionInput,
	) => Effect.Effect<CloudWorkspaceLifecycleTransitionOutcome>;
	readonly listPendingMailboxLifecycles: (
		limit: number,
	) => Effect.Effect<ReadonlyArray<CloudMailboxLifecycleFence>>;
	readonly acknowledgeMailboxLifecycle: (
		lifecycle: CloudMailboxLifecycleFence,
		nowMs: number,
	) => Effect.Effect<boolean>;
	readonly getWorkspaceLifecycleCommand: (
		workspaceId: string,
		commandId: string,
	) => Effect.Effect<string | null>;
	readonly saveWorkspaceLifecycleCommand: (
		input: WorkspaceLifecycleCommandWrite,
	) => Effect.Effect<boolean>;
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
		readonly commandProtocolVersion?: number;
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
	readonly recordMailboxRuntimePoll: (
		workspaceId: string,
		accountId: string,
		runtimeGeneration: number,
		nowMs: number,
		nextCheckAtMs: number,
	) => Effect.Effect<number | null>;
	readonly recordMailboxRuntimeProgress: (
		workspaceId: string,
		accountId: string,
		runtimeGeneration: number,
		wakeRevision: number,
		mailboxRevision: number,
		fenceRequired: boolean,
		nowMs: number,
		nextCheckAtMs: number,
	) => Effect.Effect<boolean>;
	readonly completeMailboxDrain: (
		workspaceId: string,
		accountId: string,
		runtimeGeneration: number,
		wakeRevision: number,
		nowMs: number,
		nextIdleAtMs: number,
	) => Effect.Effect<boolean>;
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
		readonly activeSessionId: string | null;
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
	/** Refuses cleanup while any workspace lifecycle fence remains unsafe. */
	readonly deleteAccountData: (accountId: string) => Effect.Effect<boolean>;
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
	readonly createApiKey: (key: ApiKeyRecord) => Effect.Effect<void>;
	readonly listApiKeys: (
		accountId: string,
	) => Effect.Effect<ReadonlyArray<ApiKeyRecord>>;
	readonly revokeApiKey: (
		accountId: string,
		keyId: string,
		nowMs: number,
	) => Effect.Effect<ApiKeyRecord | null>;
	readonly findActiveApiKeyByHash: (
		secretHash: string,
	) => Effect.Effect<ApiKeyRecord | null>;
	readonly touchApiKey: (keyId: string, nowMs: number) => Effect.Effect<void>;
	readonly createApiWebhook: (
		webhook: ApiWebhookRecord,
		activeLimit: number,
	) => Effect.Effect<boolean>;
	readonly listApiWebhooks: (
		accountId: string,
	) => Effect.Effect<ReadonlyArray<ApiWebhookRecord>>;
	readonly deleteApiWebhook: (
		accountId: string,
		webhookId: string,
	) => Effect.Effect<boolean>;
	readonly appendApiMessage: (
		input: AppendApiMessageInput,
	) => Effect.Effect<AppendApiMessageOutcome>;
	readonly appendApiMessageGuarded: (
		input: AppendApiMessageGuardedInput,
	) => Effect.Effect<AppendApiMessageGuardedOutcome>;
	readonly getApiMessage: (
		messageId: string,
	) => Effect.Effect<CloudWorkspaceApiMessageRecord | null>;
	readonly listApiMessages: (
		workspaceId: string,
		afterSeq: number,
		limit: number,
	) => Effect.Effect<ReadonlyArray<CloudWorkspaceApiMessageRecord>>;
	readonly getApiWorkspaceLedgerSummary: (
		workspaceId: string,
	) => Effect.Effect<ApiWorkspaceLedgerSummary>;
	readonly claimNextApiCommand: (
		workspaceId: string,
		nowMs: number,
	) => Effect.Effect<CloudWorkspaceApiMessageRecord | null>;
	readonly ackApiCommand: (
		workspaceId: string,
		messageId: string,
		turnId: string | undefined,
		commandTurnId: string | undefined,
		nowMs: number,
	) => Effect.Effect<boolean>;
	readonly recordApiTurnEvent: (
		input: RecordApiTurnEventInput,
	) => Effect.Effect<RecordApiTurnEventOutcome>;
	readonly expireApiCommands: (nowMs: number) => Effect.Effect<void>;
	readonly listWorkspacesWithStalePendingApiCommands: (
		cutoffMs: number,
	) => Effect.Effect<ReadonlyArray<string>>;
	readonly pruneApiData: (beforeMs: number) => Effect.Effect<void>;
	readonly claimDueApiWebhookDeliveries: (
		nowMs: number,
		limit: number,
		leaseMs: number,
	) => Effect.Effect<ReadonlyArray<DueApiWebhookDelivery>>;
	readonly completeApiWebhookDelivery: (
		deliveryId: string,
		nowMs: number,
	) => Effect.Effect<void>;
	readonly failApiWebhookDelivery: (input: {
		readonly deliveryId: string;
		readonly nowMs: number;
		readonly error: string;
		readonly nextAttemptAtMs: number;
		readonly terminal: boolean;
	}) => Effect.Effect<void>;
}

export class CloudWorkspaceStore extends Context.Service<
	CloudWorkspaceStore,
	CloudWorkspaceStoreApi
>()("@zuse/api/CloudWorkspaceStore") {}

interface MemoryState {
	readonly authAuthorities: Map<string, CloudAuthAuthorityRecord>;
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
	readonly apiKeys: Map<string, ApiKeyRecord>;
	readonly apiWebhooks: Map<string, ApiWebhookRecord>;
	readonly apiMessages: Map<string, CloudWorkspaceApiMessageRecord>;
	readonly apiTurnReceipts: Map<string, ApiTurnReceipt>;
	readonly apiDeliveries: Map<string, ApiWebhookDeliveryRecord>;
}

const activeBranch = (workspace: CloudWorkspaceRecord): boolean =>
	workspace.state !== "deleted";

/** A runtime capability is valid only for the generation that advertised it. */
export const workspaceSupportsCloudCommandMailbox = (
	workspace: CloudWorkspaceRecord,
): boolean =>
	workspace.requestConfig.cloudCommandProtocolVersion ===
		CLOUD_COMMAND_PROTOCOL_VERSION &&
	workspace.requestConfig.cloudCommandRuntimeGeneration ===
		cloudWorkspaceRuntimeGeneration(workspace);

/**
 * New workspaces can durably accept commands before their first runtime has
 * connected. Leasing remains fenced by the generation-scoped runtime proof.
 */
export const workspaceAcceptsCloudCommandMailbox = (
	workspace: CloudWorkspaceRecord,
): boolean =>
	workspaceSupportsCloudCommandMailbox(workspace) ||
	workspace.requestConfig.cloudCommandEnrollmentProtocolVersion ===
		CLOUD_COMMAND_PROTOCOL_VERSION;
const transcriptCheckpointKey = (
	workspaceId: string,
	sessionId: string,
): string => `${workspaceId}\u0000${sessionId}`;

const apiTurnReceiptKey = (workspaceId: string, turnId: string): string =>
	`${workspaceId}\u0000${turnId}`;

const apiTurnReceiptMatchesInput = (
	receipt: ApiTurnReceipt,
	input: RecordApiTurnEventInput,
): boolean =>
	receipt.outcome === input.outcome &&
	receipt.settledAtMs === input.nowMs &&
	receipt.contentDigest === input.contentDigest;

const applyApiWebhookFanoutInMemory = (
	current: MemoryState,
	input: RecordApiTurnEventInput,
	receipt: ApiTurnReceipt,
): MemoryState => {
	const fanout = input.webhookFanout;
	if (fanout === undefined || fanout.targets.length === 0) return current;
	const apiDeliveries = new Map(current.apiDeliveries);
	for (const target of fanout.targets) {
		const webhook = current.apiWebhooks.get(target.webhookId);
		if (
			webhook === undefined ||
			webhook.accountId !== input.accountId ||
			webhook.disabledAtMs !== undefined ||
			webhook.createdAtMs > receipt.settledAtMs
		)
			continue;
		const duplicate = [...apiDeliveries.values()].some(
			(delivery) =>
				delivery.webhookId === target.webhookId &&
				delivery.eventId === fanout.eventId,
		);
		if (duplicate) continue;
		const collidingId = apiDeliveries.get(target.deliveryId);
		if (collidingId !== undefined)
			throw new Error(
				`API webhook delivery id collision: ${target.deliveryId}`,
			);
		apiDeliveries.set(target.deliveryId, {
			deliveryId: target.deliveryId,
			webhookId: target.webhookId,
			accountId: input.accountId,
			eventId: fanout.eventId,
			eventType: fanout.eventType,
			sealedPayload: fanout.sealedPayload,
			status: "pending",
			attempts: 0,
			nextAttemptAtMs: fanout.enqueuedAtMs,
			createdAtMs: fanout.enqueuedAtMs,
			updatedAtMs: fanout.enqueuedAtMs,
		});
	}
	return { ...current, apiDeliveries };
};

const nextApiMessageSeq = (
	messages: ReadonlyMap<string, CloudWorkspaceApiMessageRecord>,
	workspaceId: string,
): number =>
	1 +
	Math.max(
		0,
		...[...messages.values()]
			.filter((message) => message.workspaceId === workspaceId)
			.map((message) => message.seq),
	);

const workspaceVersionMatches = (
	workspace: CloudWorkspaceRecord,
	expected: CloudWorkspaceVersion,
): boolean =>
	workspace.workspaceId === expected.workspaceId &&
	workspace.revision === expected.revision &&
	workspace.updatedAtMs === expected.updatedAtMs;

const guardedAppendTargetsWorkspace = (
	input: AppendApiMessageGuardedInput,
	workspace: CloudWorkspaceRecord,
): boolean =>
	input.message.workspaceId === workspace.workspaceId &&
	input.message.accountId === workspace.accountId &&
	(input.lifecycleCommand === undefined ||
		(input.lifecycleCommand.workspace.workspaceId === workspace.workspaceId &&
			input.lifecycleCommand.workspace.accountId === workspace.accountId));

const apiMessageBelongsToWorkspace = (
	message: CloudWorkspaceApiMessageRecord,
	workspace: CloudWorkspaceRecord,
): boolean =>
	message.workspaceId === workspace.workspaceId &&
	message.accountId === workspace.accountId;

const workspaceLifecycleLockKey = (workspaceId: string): string =>
	`workspace-lifecycle:${workspaceId}`;

const apiMessagesLockKey = (workspaceId: string): string =>
	`api-messages:${workspaceId}`;

const apiWebhooksLockKey = (accountId: string): string =>
	`api-webhooks:${accountId}`;

const saveWorkspaceLifecycleCommandInMemory = (
	current: MemoryState,
	input: WorkspaceLifecycleCommandWrite,
): readonly [boolean, MemoryState] => {
	const { workspace, commandId, action } = input;
	const commandKey = `${workspace.workspaceId}:${commandId}`;
	const saved = current.workspaces.get(workspace.workspaceId);
	if (
		saved === undefined ||
		current.lifecycleCommands.has(commandKey) ||
		saved.revision > workspace.revision ||
		(saved.revision === workspace.revision &&
			saved.updatedAtMs >= workspace.updatedAtMs)
	)
		return [false, current];
	const prepared = prepareWorkspaceSave(saved, workspace);
	if (prepared === null) return [false, current];
	return [
		true,
		{
			...current,
			workspaces: new Map(current.workspaces).set(workspace.workspaceId, {
				...prepared,
				leaseOwner: saved.leaseOwner,
				leaseExpiresAtMs: saved.leaseExpiresAtMs,
			}),
			lifecycleCommands: new Map(current.lifecycleCommands).set(
				commandKey,
				action,
			),
		},
	];
};

const appendApiMessageInMemory = (
	current: MemoryState,
	input: AppendApiMessageInput,
): readonly [AppendApiMessageOutcome, MemoryState] => {
	const existing = current.apiMessages.get(input.messageId);
	if (existing !== undefined)
		return [{ kind: "existing", message: existing }, current];
	const assistantAlreadyRecorded =
		input.role === "user" &&
		input.status === "delivered" &&
		input.turnId !== undefined &&
		([...current.apiMessages.values()].some(
			(candidate) =>
				candidate.workspaceId === input.workspaceId &&
				candidate.role === "assistant" &&
				candidate.turnId === input.turnId,
		) ||
			current.apiTurnReceipts.has(
				apiTurnReceiptKey(input.workspaceId, input.turnId),
			));
	const message: CloudWorkspaceApiMessageRecord = {
		...input,
		status: assistantAlreadyRecorded ? "settled" : input.status,
		seq: nextApiMessageSeq(current.apiMessages, input.workspaceId),
	};
	return [
		{ kind: "created", message },
		{
			...current,
			apiMessages: new Map(current.apiMessages).set(message.messageId, message),
		},
	];
};

/**
 * Associate one causal user row with a settlement. Upgraded runtimes match the
 * api-assigned turn id exactly. During rollout, a pre-change runtime clears
 * that provisional id when it ACKs; its next settlement may then claim only
 * the oldest delivered, unbound row. Strict FIFO ensures there is at most one
 * such active legacy command.
 */
const settleApiTurnUserMessageInMemory = (
	apiMessages: ReadonlyMap<string, CloudWorkspaceApiMessageRecord>,
	workspaceId: string,
	turnId: string,
): Map<string, CloudWorkspaceApiMessageRecord> => {
	const next = new Map(apiMessages);
	const candidates = [...next.values()]
		.filter(
			(message) =>
				message.workspaceId === workspaceId &&
				message.role === "user" &&
				message.status !== "settled" &&
				(message.turnId === turnId ||
					(message.turnId === undefined && message.status === "delivered")),
		)
		.sort((left, right) => {
			const leftExact = left.turnId === turnId ? 0 : 1;
			const rightExact = right.turnId === turnId ? 0 : 1;
			return leftExact - rightExact || left.seq - right.seq;
		});
	const candidate = candidates[0];
	if (candidate !== undefined)
		next.set(candidate.messageId, {
			...candidate,
			turnId,
			status: "settled",
		});
	return next;
};

/**
 * A pre-turn-id runtime ACK identifies only the command message. If its turn
 * event won the race, claim that turn only when FIFO and the durable receipt
 * place it inside the latest command-fetch attempt. Both api receive time
 * and runtime settlement time are fenced: this excludes an unrelated turn
 * that either arrived before the latest retry or was published late from an
 * earlier session turn.
 */
const legacyAckSettlementTurnInMemory = (
	current: MemoryState,
	message: CloudWorkspaceApiMessageRecord,
	acknowledgedAtMs: number,
): string | undefined => {
	const attemptedAtMs = message.deliveryAttemptedAtMs;
	if (attemptedAtMs === undefined) return undefined;
	const workspaceMessages = [...current.apiMessages.values()].filter(
		(candidate) => candidate.workspaceId === message.workspaceId,
	);
	const hasEarlierOutstanding = workspaceMessages.some(
		(candidate) =>
			candidate.role === "user" &&
			candidate.seq < message.seq &&
			(candidate.status === "pending" || candidate.status === "delivered") &&
			(candidate.expiresAtMs === undefined ||
				candidate.expiresAtMs > acknowledgedAtMs),
	);
	if (hasEarlierOutstanding) return undefined;
	const candidates = workspaceMessages.filter((candidate) => {
		if (
			candidate.role !== "assistant" ||
			candidate.status !== "settled" ||
			candidate.seq <= message.seq ||
			candidate.turnId === undefined
		)
			return false;
		const receipt = current.apiTurnReceipts.get(
			apiTurnReceiptKey(message.workspaceId, candidate.turnId),
		);
		return (
			receipt !== undefined &&
			receipt.receivedAtMs >= attemptedAtMs &&
			receipt.receivedAtMs <= acknowledgedAtMs &&
			receipt.settledAtMs >= attemptedAtMs &&
			!workspaceMessages.some(
				(claimed) =>
					claimed.role === "user" &&
					claimed.messageId !== message.messageId &&
					claimed.turnId === candidate.turnId,
			)
		);
	});
	return candidates.length === 1 ? candidates[0]?.turnId : undefined;
};

const recordOrEmpty = (value: unknown): Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: {};

const destructionFenceFromUnknown = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;

const mailboxLifecycleFenceFromConfig = (
	workspaceId: string,
	value: unknown,
): CloudMailboxLifecycleFence | null => {
	const record = recordOrEmpty(value);
	const action = record.action;
	const destructionFence = destructionFenceFromUnknown(record.destructionFence);
	return (action === "archive" || action === "delete") &&
		destructionFence !== null
		? {
				workspaceId,
				action,
				destructionFence,
			}
		: null;
};

export const pendingMailboxLifecycle = (
	workspace: CloudWorkspaceRecord,
): CloudMailboxLifecycleFence | null =>
	mailboxLifecycleFenceFromConfig(
		workspace.workspaceId,
		workspace.requestConfig.cloudMailboxLifecyclePending,
	);

export const deliveredMailboxLifecycle = (
	workspace: CloudWorkspaceRecord,
): CloudMailboxLifecycleFence | null =>
	mailboxLifecycleFenceFromConfig(
		workspace.workspaceId,
		workspace.requestConfig.cloudMailboxLifecycleDelivered,
	);

export const workspaceDestructionFence = (
	workspace: Pick<CloudWorkspaceRecord, "requestConfig">,
): number =>
	Math.max(
		destructionFenceFromUnknown(workspace.requestConfig.destructionFence) ?? 0,
		destructionFenceFromUnknown(
			recordOrEmpty(workspace.requestConfig.cloudMailboxLifecyclePending)
				.destructionFence,
		) ?? 0,
		destructionFenceFromUnknown(
			recordOrEmpty(workspace.requestConfig.cloudMailboxLifecycleDelivered)
				.destructionFence,
		) ?? 0,
	);

export const mailboxLifecycleCovers = (
	candidate: CloudMailboxLifecycleFence | null,
	action: CloudMailboxLifecycleAction,
	destructionFence: number,
): boolean =>
	candidate !== null &&
	candidate.destructionFence >= destructionFence &&
	(candidate.action === action || candidate.action === "delete");

/** Delete metadata is irreversible even if a stale writer regressed row state. */
export const workspaceDeletionRequested = (
	workspace: CloudWorkspaceRecord,
): boolean =>
	workspace.state === "deleted" ||
	workspace.state === "deleting" ||
	workspace.desiredState === "deleted" ||
	pendingMailboxLifecycle(workspace)?.action === "delete" ||
	deliveredMailboxLifecycle(workspace)?.action === "delete";

export const destructiveMailboxLifecycle = (
	workspace: CloudWorkspaceRecord,
): CloudMailboxLifecycleAction | null =>
	workspaceDeletionRequested(workspace)
		? "delete"
		: workspace.state === "archived" ||
				workspace.state === "archiving" ||
				workspace.desiredState === "archived"
			? "archive"
			: null;

/** The one canonical lifecycle notification callers may forward to the DO. */
export const mailboxLifecycleToDeliver = (
	workspace: CloudWorkspaceRecord,
): CloudMailboxLifecycleFence | null => {
	const pending = pendingMailboxLifecycle(workspace);
	if (pending !== null) {
		// Delete dominates an older archived outbox row. The reconciler will replace
		// that stale row with a canonical delete fence; never deliver archive using
		// lifecycle metadata from the newer deletion state.
		if (workspaceDeletionRequested(workspace) && pending.action !== "delete")
			return null;
		return pending;
	}
	const action = destructiveMailboxLifecycle(workspace);
	if (action === null) return null;
	const destructionFence = Math.max(workspaceDestructionFence(workspace), 1);
	return mailboxLifecycleCovers(
		deliveredMailboxLifecycle(workspace),
		action,
		destructionFence,
	)
		? null
		: { workspaceId: workspace.workspaceId, action, destructionFence };
};

export const workspaceDeletionIsDurablyFenced = (
	workspace: CloudWorkspaceRecord,
): boolean =>
	workspace.state === "deleted" &&
	pendingMailboxLifecycle(workspace) === null &&
	mailboxLifecycleCovers(
		deliveredMailboxLifecycle(workspace),
		"delete",
		workspaceDestructionFence(workspace),
	);

export const withPendingMailboxLifecycle = (
	requestConfig: Readonly<Record<string, unknown>>,
	action: CloudMailboxLifecycleAction,
	destructionFence: number,
): Readonly<Record<string, unknown>> => ({
	...requestConfig,
	destructionFence,
	cloudMailboxLifecyclePending: { action, destructionFence },
});

const preserveMailboxLifecycle = (
	requestConfig: Readonly<Record<string, unknown>>,
	workspace: CloudWorkspaceRecord,
): Readonly<Record<string, unknown>> => {
	const {
		destructionFence: _destructionFence,
		cloudMailboxLifecyclePending: _pending,
		cloudMailboxLifecycleDelivered: _delivered,
		...rest
	} = requestConfig;
	const pending = pendingMailboxLifecycle(workspace);
	const delivered = deliveredMailboxLifecycle(workspace);
	return {
		...rest,
		destructionFence: workspaceDestructionFence(workspace),
		...(pending === null
			? {}
			: {
					cloudMailboxLifecyclePending: {
						action: pending.action,
						destructionFence: pending.destructionFence,
					},
				}),
		...(delivered === null
			? {}
			: {
					cloudMailboxLifecycleDelivered: {
						action: delivered.action,
						destructionFence: delivered.destructionFence,
					},
				}),
	};
};

/** Reject stale generic writers once the irreversible delete fence exists. */
const prepareWorkspaceSave = (
	current: CloudWorkspaceRecord,
	proposed: CloudWorkspaceRecord,
): CloudWorkspaceRecord | null => {
	if (!workspaceDeletionRequested(current)) return proposed;
	if (proposed.desiredState !== "deleted") return null;
	if (current.state === "deleted" && proposed.state !== "deleted") return null;
	if (
		current.state === "deleting" &&
		proposed.state !== "deleting" &&
		proposed.state !== "deleted"
	)
		return null;
	return {
		...proposed,
		requestConfig: preserveMailboxLifecycle(proposed.requestConfig, current),
	};
};

const prepareWorkspaceLifecycleTransition = (
	current: CloudWorkspaceRecord,
	input: CloudWorkspaceLifecycleTransitionInput,
):
	| { readonly kind: "ready"; readonly workspace: CloudWorkspaceRecord }
	| {
			readonly kind: "rejected";
			readonly reason: Extract<
				CloudWorkspaceLifecycleTransitionOutcome,
				{ readonly kind: "rejected" }
			>["reason"];
	  } => {
	const lifecycle = destructiveMailboxLifecycle(current);
	if (input.action !== "delete" && lifecycle === "delete")
		return { kind: "rejected", reason: "workspace-deleted" };
	if (
		(input.action === "pause" ||
			input.action === "resume" ||
			input.action === "restart") &&
		lifecycle === "archive"
	)
		return { kind: "rejected", reason: "workspace-archived" };
	// A durably accepted command owns readiness until its mailbox drain reaches a
	// terminal state. Letting a later manual pause overwrite desiredState would
	// strand that command with no finite reconciliation deadline. Archive/delete
	// remain allowed because their destruction fence terminalizes mailbox work.
	if (
		input.action === "pause" &&
		current.requestConfig.cloudMailboxWakePending === true
	)
		return { kind: "rejected", reason: "mailbox-wake-pending" };
	if (input.action === "unarchive" && lifecycle !== "archive")
		return { kind: "rejected", reason: "workspace-not-archived" };
	if (
		input.action === "restart" &&
		(current.state !== "ready" || current.providerSandboxId === undefined)
	)
		return { kind: "rejected", reason: "workspace-not-running" };
	if (
		input.action === "resume" &&
		input.deduplicateRequestedResume === true &&
		current.desiredState === "ready" &&
		current.state !== "failed"
	)
		return { kind: "ready", workspace: current };

	const currentFence = workspaceDestructionFence(current);
	const destructiveAction =
		input.action === "archive" || input.action === "delete"
			? input.action
			: null;
	const lifecycleAlreadyRequestedInRow =
		destructiveAction === "delete"
			? current.state === "deleted" ||
				current.state === "deleting" ||
				current.desiredState === "deleted"
			: destructiveAction === "archive"
				? current.state === "archived" ||
					current.state === "archiving" ||
					current.desiredState === "archived"
				: false;
	if (
		destructiveAction !== null &&
		lifecycle === destructiveAction &&
		lifecycleAlreadyRequestedInRow &&
		(mailboxLifecycleCovers(
			pendingMailboxLifecycle(current),
			destructiveAction,
			currentFence,
		) ||
			mailboxLifecycleCovers(
				deliveredMailboxLifecycle(current),
				destructiveAction,
				currentFence,
			))
	)
		return { kind: "ready", workspace: current };

	if (destructiveAction !== null && currentFence >= Number.MAX_SAFE_INTEGER)
		return { kind: "rejected", reason: "destruction-fence-exhausted" };

	const baseRequestConfig = preserveMailboxLifecycle(
		input.workspace.requestConfig,
		current,
	);
	const requestConfig =
		destructiveAction === null
			? baseRequestConfig
			: withPendingMailboxLifecycle(
					baseRequestConfig,
					destructiveAction,
					currentFence + 1,
				);
	return {
		kind: "ready",
		workspace: {
			...input.workspace,
			requestConfig,
			leaseOwner: current.leaseOwner,
			leaseExpiresAtMs: current.leaseExpiresAtMs,
			revision: current.revision + 1,
			updatedAtMs: Math.max(input.createdAtMs, current.updatedAtMs + 1),
		},
	};
};

/** Preserve only irreversible mailbox metadata when workspace data is erased. */
export const mailboxLifecycleTombstoneConfig = (
	workspace: CloudWorkspaceRecord,
): Readonly<Record<string, unknown>> => {
	const pending = pendingMailboxLifecycle(workspace);
	const delivered = deliveredMailboxLifecycle(workspace);
	return {
		destructionFence:
			typeof workspace.requestConfig.destructionFence === "number"
				? workspace.requestConfig.destructionFence
				: 0,
		...(pending === null
			? {}
			: {
					cloudMailboxLifecyclePending: {
						action: pending.action,
						destructionFence: pending.destructionFence,
					},
				}),
		...(delivered === null
			? {}
			: {
					cloudMailboxLifecycleDelivered: {
						action: delivered.action,
						destructionFence: delivered.destructionFence,
					},
				}),
	};
};

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
		nextActionAtMs:
			workspace.requestConfig.cloudMailboxWakePending === true
				? Math.min(workspace.nextActionAtMs, input.nowMs)
				: input.nextActionAtMs,
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
			authAuthorities: new Map(),
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
			apiKeys: new Map(),
			apiWebhooks: new Map(),
			apiMessages: new Map(),
			apiTurnReceipts: new Map(),
			apiDeliveries: new Map(),
		});
		return CloudWorkspaceStore.of({
			getCloudAuthAuthority: (accountId) =>
				Ref.get(state).pipe(
					Effect.map(
						(current) => current.authAuthorities.get(accountId) ?? null,
					),
				),
			claimCloudAuthAuthority: (input) =>
				Ref.modify(
					state,
					(current): readonly [CloudAuthAuthorityClaim, MemoryState] => {
						const existing = current.authAuthorities.get(input.accountId);
						if (
							(existing?.state === "ready" && input.replaceReady !== true) ||
							(existing?.provisioningLeaseExpiresAtMs !== undefined &&
								existing.provisioningLeaseExpiresAtMs > input.nowMs &&
								existing.provisioningLeaseOwner !== input.leaseOwner)
						)
							return [{ record: existing, acquired: false }, current] as const;
						const replacingReady =
							existing?.state === "ready" && input.replaceReady === true;
						const record: CloudAuthAuthorityRecord = {
							accountId: input.accountId,
							provider: input.provider,
							storageIncarnationId: replacingReady
								? input.candidateStorageIncarnationId
								: (existing?.storageIncarnationId ??
									input.candidateStorageIncarnationId),
							authEpoch: replacingReady
								? existing.authEpoch + 1
								: (existing?.authEpoch ?? 1),
							toolchainVersion: input.toolchainVersion,
							state: "provisioning",
							provisioningLeaseOwner: input.leaseOwner,
							provisioningLeaseExpiresAtMs: input.leaseExpiresAtMs,
							revision: (existing?.revision ?? -1) + 1,
							createdAtMs: existing?.createdAtMs ?? input.nowMs,
							updatedAtMs: input.nowMs,
						};
						return [
							{ record, acquired: true },
							{
								...current,
								authAuthorities: new Map(current.authAuthorities).set(
									input.accountId,
									record,
								),
							},
						] as const;
					},
				),
			completeCloudAuthAuthorityProvisioning: (input) =>
				Ref.modify(state, (current) => {
					const existing = current.authAuthorities.get(input.accountId);
					if (
						existing === undefined ||
						(existing.state !== "ready" &&
							existing.provisioningLeaseOwner !== input.leaseOwner)
					)
						return [null, current] as const;
					const record: CloudAuthAuthorityRecord = {
						...existing,
						providerSandboxId: input.providerSandboxId,
						storageIncarnationId: input.storageIncarnationId,
						toolchainVersion: input.toolchainVersion,
						state: "ready",
						provisioningLeaseOwner: undefined,
						provisioningLeaseExpiresAtMs: undefined,
						revision: existing.revision + 1,
						updatedAtMs: input.nowMs,
					};
					return [
						record,
						{
							...current,
							authAuthorities: new Map(current.authAuthorities).set(
								input.accountId,
								record,
							),
						},
					] as const;
				}),
			advanceCloudAuthEpoch: (input) =>
				Ref.modify(state, (current) => {
					const existing = current.authAuthorities.get(input.accountId);
					if (
						existing?.state !== "ready" ||
						existing.providerSandboxId !== input.providerSandboxId
					)
						return [null, current] as const;
					const record: CloudAuthAuthorityRecord = {
						...existing,
						authEpoch: existing.authEpoch + 1,
						revision: existing.revision + 1,
						updatedAtMs: input.nowMs,
					};
					return [
						record,
						{
							...current,
							authAuthorities: new Map(current.authAuthorities).set(
								input.accountId,
								record,
							),
						},
					] as const;
				}),
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
						const currentGeneration =
							cloudWorkspaceRuntimeGeneration(workspace);
						const currentGatewayEpoch = cloudWorkspaceGatewayEpoch(workspace);
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
							...(input.capabilities === undefined
								? {}
								: { capabilities: input.capabilities }),
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
					const {
						cloudCommandProtocolVersion: _priorCommandProtocolVersion,
						cloudCommandRuntimeGeneration: _priorCommandRuntimeGeneration,
						...runtimeConfig
					} = workspace.requestConfig;
					const updated: CloudWorkspaceRecord = {
						...workspace,
						runtimeState: "online",
						state: launchPending ? "setup" : "ready",
						statusCode: launchPending ? "agent-starting" : "agent-running",
						requestConfig: {
							...runtimeConfig,
							runtimeProcessManaged: true,
							...(typeof input.commandProtocolVersion === "number"
								? {
										cloudCommandProtocolVersion: input.commandProtocolVersion,
										cloudCommandRuntimeGeneration:
											cloudWorkspaceRuntimeGeneration(workspace),
									}
								: {}),
							startupTimings: {
								...timings,
								connectedAt: timings.connectedAt ?? input.nowMs,
								repositoryReadyAt: timings.repositoryReadyAt ?? input.nowMs,
							},
						},
						nextActionAtMs:
							workspace.requestConfig.cloudMailboxWakePending === true
								? Math.min(workspace.nextActionAtMs, input.nowMs)
								: launchPending
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
						cloudWorkspaceRuntimeGeneration(workspace) !== input.generation ||
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
					const prepared =
						saved === undefined
							? workspace
							: prepareWorkspaceSave(saved, workspace);
					if (prepared === null) return current;
					return {
						...current,
						workspaces: new Map(current.workspaces).set(prepared.workspaceId, {
							...prepared,
							leaseOwner: saved?.leaseOwner,
							leaseExpiresAtMs: saved?.leaseExpiresAtMs,
						}),
					};
				}),
			transitionWorkspaceLifecycle: (input) =>
				Ref.modify(
					state,
					(
						current,
					): readonly [
						CloudWorkspaceLifecycleTransitionOutcome,
						MemoryState,
					] => {
						const stored = current.workspaces.get(input.workspace.workspaceId);
						if (stored === undefined)
							return [{ kind: "missing" } as const, current] as const;
						const receiptKey =
							input.commandId === undefined
								? undefined
								: `${stored.workspaceId}:${input.commandId}`;
						const receivedAction =
							receiptKey === undefined
								? undefined
								: current.lifecycleCommands.get(receiptKey);
						if (receivedAction !== undefined)
							return [
								receivedAction === input.action
									? ({
											kind: "replay",
											workspace: stored,
											action: input.action,
										} as const)
									: ({
											kind: "rejected",
											workspace: stored,
											reason: "command-id-reused",
										} as const),
								current,
							] as const;
						if (
							stored.revision !== input.expectedRevision ||
							stored.updatedAtMs !== input.expectedUpdatedAtMs ||
							stored.state !== input.expectedState ||
							stored.desiredState !== input.expectedDesiredState
						)
							return [
								{ kind: "contended", workspace: stored } as const,
								current,
							] as const;
						const prepared = prepareWorkspaceLifecycleTransition(stored, input);
						if (prepared.kind === "rejected")
							return [
								{
									kind: "rejected",
									workspace: stored,
									reason: prepared.reason,
								} as const,
								current,
							] as const;
						const nextCommands = new Map(current.lifecycleCommands);
						if (receiptKey !== undefined)
							nextCommands.set(receiptKey, input.action);
						return [
							{
								kind: "applied",
								workspace: prepared.workspace,
								action: input.action,
							} as const,
							{
								...current,
								workspaces: new Map(current.workspaces).set(
									stored.workspaceId,
									prepared.workspace,
								),
								lifecycleCommands: nextCommands,
							},
						] as const;
					},
				),
			listPendingMailboxLifecycles: (limit) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.workspaces.values()]
							.map(mailboxLifecycleToDeliver)
							.filter(
								(lifecycle): lifecycle is CloudMailboxLifecycleFence =>
									lifecycle !== null,
							)
							.slice(0, limit),
					),
				),
			acknowledgeMailboxLifecycle: (lifecycle, nowMs) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(lifecycle.workspaceId);
					const pending =
						workspace === undefined ? null : pendingMailboxLifecycle(workspace);
					if (
						workspace === undefined ||
						pending?.action !== lifecycle.action ||
						pending.destructionFence !== lifecycle.destructionFence
					)
						return [false, current] as const;
					const { cloudMailboxLifecyclePending: _pending, ...requestConfig } =
						workspace.requestConfig;
					const updated: CloudWorkspaceRecord = {
						...workspace,
						requestConfig: {
							...requestConfig,
							cloudMailboxLifecycleDelivered: {
								action: lifecycle.action,
								destructionFence: lifecycle.destructionFence,
							},
						},
						revision: workspace.revision + 1,
						updatedAtMs: Math.max(nowMs, workspace.updatedAtMs + 1),
					};
					return [
						true,
						{
							...current,
							workspaces: new Map(current.workspaces).set(
								workspace.workspaceId,
								updated,
							),
						},
					] as const;
				}),
			getWorkspaceLifecycleCommand: (workspaceId, commandId) =>
				Ref.get(state).pipe(
					Effect.map(
						(current) =>
							current.lifecycleCommands.get(`${workspaceId}:${commandId}`) ??
							null,
					),
				),
			saveWorkspaceLifecycleCommand: (input) =>
				Ref.modify(state, (current) =>
					saveWorkspaceLifecycleCommandInMemory(current, input),
				),
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
					if (
						workspace?.accountId !== accountId ||
						workspaceDeletionRequested(workspace)
					)
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
						nextActionAtMs:
							workspace.requestConfig.cloudMailboxWakePending === true
								? workspace.nextActionAtMs
								: workspace.state === "paused"
									? nowMs
									: nextIdleAtMs,
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
			requestMailboxWake: (workspaceId, accountId, nowMs, _nextIdleAtMs) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(workspaceId);
					if (
						workspace?.accountId !== accountId ||
						workspaceDeletionRequested(workspace) ||
						workspace.state === "archived" ||
						workspace.state === "archiving" ||
						workspace.desiredState === "archived"
					)
						return [null, current] as const;
					const resuming =
						workspace.state === "paused" ||
						workspace.state === "pausing" ||
						(workspace.state === "ready" &&
							workspace.runtimeState !== "online");
					const alreadyPending =
						workspace.requestConfig.cloudMailboxWakePending === true;
					const previousWakeRevision =
						typeof workspace.requestConfig.cloudMailboxWakeRevision ===
							"number" &&
						Number.isSafeInteger(
							workspace.requestConfig.cloudMailboxWakeRevision,
						)
							? workspace.requestConfig.cloudMailboxWakeRevision
							: 0;
					const {
						cloudMailboxRuntimeSeenAt: _cloudMailboxRuntimeSeenAt,
						cloudMailboxProgressAt: _cloudMailboxProgressAt,
						cloudMailboxProgressRevision: _cloudMailboxProgressRevision,
						cloudMailboxFenceRequired: _cloudMailboxFenceRequired,
						...requestConfigWithoutRuntimeObservation
					} = workspace.requestConfig;
					const wakeConfig = alreadyPending
						? workspace.requestConfig
						: requestConfigWithoutRuntimeObservation;
					const updated: CloudWorkspaceRecord = {
						...workspace,
						desiredState: "ready",
						statusCode: resuming ? "resume-queued" : workspace.statusCode,
						requestConfig: {
							...(resuming
								? {
										...wakeConfig,
										startupTimings: {
											requestedAt: nowMs,
											resumeRequestedAt: nowMs,
										},
									}
								: wakeConfig),
							cloudMailboxWakePending: true,
							cloudMailboxWakeRequestedAt:
								alreadyPending &&
								typeof workspace.requestConfig.cloudMailboxWakeRequestedAt ===
									"number"
									? workspace.requestConfig.cloudMailboxWakeRequestedAt
									: nowMs,
							cloudMailboxWakeRevision: previousWakeRevision + 1,
						},
						nextActionAtMs: nowMs,
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
			recordMailboxRuntimePoll: (
				workspaceId,
				accountId,
				runtimeGeneration,
				nowMs,
				nextCheckAtMs,
			) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(workspaceId);
					if (
						workspace?.accountId !== accountId ||
						workspace.requestConfig.cloudMailboxWakePending !== true ||
						workspace.state !== "ready" ||
						workspace.desiredState !== "ready" ||
						workspace.runtimeState !== "online" ||
						cloudWorkspaceRuntimeGeneration(workspace) !== runtimeGeneration
					)
						return [null, current] as const;
					const wakeRevision =
						typeof workspace.requestConfig.cloudMailboxWakeRevision ===
							"number" &&
						Number.isSafeInteger(
							workspace.requestConfig.cloudMailboxWakeRevision,
						)
							? workspace.requestConfig.cloudMailboxWakeRevision
							: 1;
					const priorSeenAt =
						typeof workspace.requestConfig.cloudMailboxRuntimeSeenAt ===
						"number"
							? workspace.requestConfig.cloudMailboxRuntimeSeenAt
							: undefined;
					if (priorSeenAt !== undefined)
						return [wakeRevision, current] as const;
					const updated: CloudWorkspaceRecord = {
						...workspace,
						requestConfig: {
							...workspace.requestConfig,
							cloudMailboxWakeRevision: wakeRevision,
							cloudMailboxRuntimeSeenAt: nowMs,
						},
						nextActionAtMs: nextCheckAtMs,
						revision: workspace.revision + 1,
						updatedAtMs: nowMs,
					};
					return [
						wakeRevision,
						{
							...current,
							workspaces: new Map(current.workspaces).set(workspaceId, updated),
						},
					] as const;
				}),
			recordMailboxRuntimeProgress: (
				workspaceId,
				accountId,
				runtimeGeneration,
				wakeRevision,
				mailboxRevision,
				fenceRequired,
				nowMs,
				nextCheckAtMs,
			) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(workspaceId);
					if (
						workspace?.accountId !== accountId ||
						workspace.requestConfig.cloudMailboxWakePending !== true ||
						workspace.requestConfig.cloudMailboxWakeRevision !== wakeRevision ||
						workspace.state !== "ready" ||
						workspace.desiredState !== "ready" ||
						workspace.runtimeState !== "online" ||
						cloudWorkspaceRuntimeGeneration(workspace) !== runtimeGeneration
					)
						return [false, current] as const;
					const priorProgressRevision =
						typeof workspace.requestConfig.cloudMailboxProgressRevision ===
						"number"
							? workspace.requestConfig.cloudMailboxProgressRevision
							: undefined;
					if (
						!fenceRequired &&
						workspace.requestConfig.cloudMailboxFenceRequired === true
					)
						return [true, current] as const;
					if (
						!fenceRequired &&
						priorProgressRevision !== undefined &&
						priorProgressRevision >= mailboxRevision
					)
						return [true, current] as const;
					if (
						fenceRequired &&
						workspace.requestConfig.cloudMailboxFenceRequired === true
					)
						return [true, current] as const;
					const updated: CloudWorkspaceRecord = {
						...workspace,
						requestConfig: {
							...workspace.requestConfig,
							...(priorProgressRevision === undefined ||
							mailboxRevision > priorProgressRevision
								? {
										cloudMailboxProgressRevision: mailboxRevision,
										cloudMailboxProgressAt: nowMs,
									}
								: {}),
							...(fenceRequired ? { cloudMailboxFenceRequired: true } : {}),
						},
						nextActionAtMs: fenceRequired ? nowMs : nextCheckAtMs,
						revision: workspace.revision + 1,
						updatedAtMs: nowMs,
					};
					return [
						true,
						{
							...current,
							workspaces: new Map(current.workspaces).set(workspaceId, updated),
						},
					] as const;
				}),
			completeMailboxDrain: (
				workspaceId,
				accountId,
				runtimeGeneration,
				wakeRevision,
				nowMs,
				nextIdleAtMs,
			) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(workspaceId);
					if (
						workspace?.accountId !== accountId ||
						workspace.requestConfig.cloudMailboxWakePending !== true ||
						workspace.requestConfig.cloudMailboxWakeRevision !== wakeRevision ||
						workspace.state !== "ready" ||
						workspace.desiredState !== "ready" ||
						workspace.runtimeState !== "online" ||
						cloudWorkspaceRuntimeGeneration(workspace) !== runtimeGeneration
					)
						return [false, current] as const;
					const {
						cloudMailboxWakePending: _cloudMailboxWakePending,
						cloudMailboxWakeRequestedAt: _cloudMailboxWakeRequestedAt,
						cloudMailboxRuntimeSeenAt: _cloudMailboxRuntimeSeenAt,
						cloudMailboxProgressAt: _cloudMailboxProgressAt,
						cloudMailboxProgressRevision: _cloudMailboxProgressRevision,
						cloudMailboxFenceRequired: _cloudMailboxFenceRequired,
						...requestConfig
					} = workspace.requestConfig;
					const updated: CloudWorkspaceRecord = {
						...workspace,
						requestConfig,
						nextActionAtMs: nextIdleAtMs,
						revision: workspace.revision + 1,
						updatedAtMs: nowMs,
					};
					return [
						true,
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
							cloudWorkspaceRuntimeGeneration(workspace) !==
							input.runtimeGeneration
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
							sessionHeadVersion:
								sameGeneration &&
								previous.activeSessionId === input.activeSessionId
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
						cloudWorkspaceRuntimeGeneration(workspace) !==
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
				Ref.modify(state, (current) => {
					const accountWorkspaces = [...current.workspaces.values()].filter(
						(workspace) => workspace.accountId === accountId,
					);
					if (
						accountWorkspaces.some(
							(workspace) => !workspaceDeletionIsDurablyFenced(workspace),
						)
					)
						return [false, current] as const;
					const githubInstallations = new Map(
						[...current.githubInstallations].filter(
							([, installation]) => installation.accountId !== accountId,
						),
					);
					const authAuthorities = new Map(current.authAuthorities);
					authAuthorities.delete(accountId);
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
					const apiKeys = new Map(
						[...current.apiKeys].filter(
							([, key]) => key.accountId !== accountId,
						),
					);
					const apiWebhooks = new Map(
						[...current.apiWebhooks].filter(
							([, webhook]) => webhook.accountId !== accountId,
						),
					);
					const apiMessages = new Map(
						[...current.apiMessages].filter(([, message]) =>
							workspaces.has(message.workspaceId),
						),
					);
					const apiTurnReceipts = new Map(
						[...current.apiTurnReceipts].filter(([, receipt]) =>
							workspaces.has(receipt.workspaceId),
						),
					);
					const apiDeliveries = new Map(
						[...current.apiDeliveries].filter(([, delivery]) =>
							apiWebhooks.has(delivery.webhookId),
						),
					);
					const removedWorkspaceIds = new Set(
						accountWorkspaces.map((workspace) => workspace.workspaceId),
					);
					const lifecycleCommands = new Map(
						[...current.lifecycleCommands].filter(([key]) => {
							const separator = key.indexOf(":");
							return !removedWorkspaceIds.has(key.slice(0, separator));
						}),
					);
					return [
						true,
						{
							...current,
							authAuthorities,
							githubInstallations,
							projects,
							builds,
							workspaces,
							launchIntents,
							runtimeSummaries,
							transcriptCheckpoints,
							lifecycleCommands,
							apiKeys,
							apiWebhooks,
							apiMessages,
							apiTurnReceipts,
							apiDeliveries,
						},
					] as const;
				}),
			recordUsage: (event) =>
				Ref.modify(state, (current) => {
					if (current.usage.has(event.eventId))
						return [false, current] as const;
					const usage = new Set(current.usage);
					usage.add(event.eventId);
					return [true, { ...current, usage }] as const;
				}),
			createApiKey: (key) =>
				Ref.update(state, (current) => ({
					...current,
					apiKeys: new Map(current.apiKeys).set(key.keyId, key),
				})),
			listApiKeys: (accountId) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.apiKeys.values()]
							.filter((key) => key.accountId === accountId)
							.sort((a, b) => a.createdAtMs - b.createdAtMs),
					),
				),
			revokeApiKey: (accountId, keyId, nowMs) =>
				Ref.modify(state, (current) => {
					const key = current.apiKeys.get(keyId);
					if (key === undefined || key.accountId !== accountId)
						return [null, current] as const;
					if (key.revokedAtMs !== undefined) return [key, current] as const;
					const revoked = { ...key, revokedAtMs: nowMs };
					return [
						revoked,
						{
							...current,
							apiKeys: new Map(current.apiKeys).set(keyId, revoked),
						},
					] as const;
				}),
			findActiveApiKeyByHash: (secretHash) =>
				Ref.get(state).pipe(
					Effect.map(
						(current) =>
							[...current.apiKeys.values()].find(
								(key) =>
									key.secretHash === secretHash &&
									key.revokedAtMs === undefined,
							) ?? null,
					),
				),
			touchApiKey: (keyId, nowMs) =>
				Ref.update(state, (current) => {
					const key = current.apiKeys.get(keyId);
					if (
						key === undefined ||
						(key.lastUsedAtMs !== undefined &&
							key.lastUsedAtMs > nowMs - 60_000)
					)
						return current;
					return {
						...current,
						apiKeys: new Map(current.apiKeys).set(keyId, {
							...key,
							lastUsedAtMs: nowMs,
						}),
					};
				}),
			createApiWebhook: (webhook, activeLimit) =>
				Ref.modify(state, (current) => {
					const activeCount = [...current.apiWebhooks.values()].filter(
						(existing) =>
							existing.accountId === webhook.accountId &&
							existing.disabledAtMs === undefined,
					).length;
					if (
						current.apiWebhooks.has(webhook.webhookId) ||
						activeCount >= activeLimit
					)
						return [false, current] as const;
					return [
						true,
						{
							...current,
							apiWebhooks: new Map(current.apiWebhooks).set(
								webhook.webhookId,
								webhook,
							),
						},
					] as const;
				}),
			listApiWebhooks: (accountId) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.apiWebhooks.values()]
							.filter(
								(webhook) =>
									webhook.accountId === accountId &&
									webhook.disabledAtMs === undefined,
							)
							.sort((a, b) => a.createdAtMs - b.createdAtMs),
					),
				),
			deleteApiWebhook: (accountId, webhookId) =>
				Ref.modify(state, (current) => {
					const webhook = current.apiWebhooks.get(webhookId);
					if (webhook === undefined || webhook.accountId !== accountId)
						return [false, current] as const;
					const apiWebhooks = new Map(current.apiWebhooks);
					apiWebhooks.delete(webhookId);
					const apiDeliveries = new Map(
						[...current.apiDeliveries].filter(
							([, delivery]) => delivery.webhookId !== webhookId,
						),
					);
					return [true, { ...current, apiWebhooks, apiDeliveries }] as const;
				}),
			appendApiMessage: (input) =>
				Ref.modify(state, (current) =>
					appendApiMessageInMemory(current, input),
				),
			appendApiMessageGuarded: (input) =>
				Ref.modify(
					state,
					(current): readonly [AppendApiMessageGuardedOutcome, MemoryState] => {
						const saved = current.workspaces.get(
							input.expectedWorkspace.workspaceId,
						);
						const existing = current.apiMessages.get(input.message.messageId);
						if (
							saved !== undefined &&
							existing !== undefined &&
							existing.status !== "pending" &&
							guardedAppendTargetsWorkspace(input, saved) &&
							apiMessageBelongsToWorkspace(existing, saved)
						) {
							const [append] = appendApiMessageInMemory(current, input.message);
							return [
								{
									kind: "committed",
									append,
									workspace: saved,
									lifecycleCommandSaved: false,
								},
								current,
							];
						}
						if (
							saved === undefined ||
							!workspaceVersionMatches(saved, input.expectedWorkspace) ||
							!guardedAppendTargetsWorkspace(input, saved)
						) {
							const outcome: AppendApiMessageGuardedOutcome = {
								kind: "workspace-contended",
								workspace: saved ?? null,
							};
							return [outcome, current] as const;
						}

						let next = current;
						let lifecycleCommandSaved = false;
						if (input.lifecycleCommand !== undefined) {
							[lifecycleCommandSaved, next] =
								saveWorkspaceLifecycleCommandInMemory(
									next,
									input.lifecycleCommand,
								);
							if (!lifecycleCommandSaved) {
								const outcome: AppendApiMessageGuardedOutcome = {
									kind: "workspace-contended",
									workspace: saved,
								};
								return [outcome, current] as const;
							}
						}

						const [append, appended] = appendApiMessageInMemory(
							next,
							input.message,
						);
						const outcome: AppendApiMessageGuardedOutcome = {
							kind: "committed",
							append,
							workspace: appended.workspaces.get(saved.workspaceId) ?? saved,
							lifecycleCommandSaved,
						};
						return [outcome, appended];
					},
				),
			getApiMessage: (messageId) =>
				Ref.get(state).pipe(
					Effect.map((current) => current.apiMessages.get(messageId) ?? null),
				),
			listApiMessages: (workspaceId, afterSeq, limit) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.apiMessages.values()]
							.filter(
								(message) =>
									message.workspaceId === workspaceId && message.seq > afterSeq,
							)
							.sort((a, b) => a.seq - b.seq)
							.slice(0, limit),
					),
				),
			getApiWorkspaceLedgerSummary: (workspaceId) =>
				Ref.get(state).pipe(
					Effect.map((current) => {
						const messages = [...current.apiMessages.values()].filter(
							(message) => message.workspaceId === workspaceId,
						);
						const lastAssistant = messages
							.filter((message) => message.role === "assistant")
							.sort((left, right) => right.seq - left.seq)[0];
						return {
							latestSeq: messages.reduce(
								(latest, message) => Math.max(latest, message.seq),
								0,
							),
							hasOutstanding: messages.some(
								(message) =>
									message.role === "user" &&
									(message.status === "pending" ||
										message.status === "delivered"),
							),
							lastAssistant: lastAssistant ?? null,
						} satisfies ApiWorkspaceLedgerSummary;
					}),
				),
			claimNextApiCommand: (workspaceId, nowMs) =>
				Ref.modify(state, (current) => {
					const pending = [...current.apiMessages.values()]
						.filter(
							(message) =>
								message.workspaceId === workspaceId &&
								message.role === "user" &&
								message.status === "pending" &&
								(message.expiresAtMs === undefined ||
									message.expiresAtMs > nowMs),
						)
						.sort((a, b) => a.seq - b.seq);
					const first = pending[0];
					if (first === undefined) return [null, current] as const;
					const attempted = {
						...first,
						deliveryAttemptedAtMs: Math.max(
							first.deliveryAttemptedAtMs ?? 0,
							nowMs,
						),
					};
					return [
						attempted,
						{
							...current,
							apiMessages: new Map(current.apiMessages).set(
								attempted.messageId,
								attempted,
							),
						},
					] as const;
				}),
			ackApiCommand: (workspaceId, messageId, turnId, commandTurnId, nowMs) =>
				Ref.modify(state, (current) => {
					const message = current.apiMessages.get(messageId);
					if (
						message === undefined ||
						message.workspaceId !== workspaceId ||
						message.role !== "user"
					)
						return [false, current] as const;
					if (message.status === "delivered" || message.status === "settled")
						return [
							turnId === undefined || message.turnId === turnId,
							current,
						] as const;
					if (message.status !== "pending") return [false, current] as const;
					if (
						turnId !== undefined &&
						message.turnId !== undefined &&
						message.turnId !== turnId &&
						message.turnId !== commandTurnId
					)
						return [false, current] as const;
					const legacySettlementTurn =
						turnId === undefined
							? legacyAckSettlementTurnInMemory(current, message, nowMs)
							: undefined;
					const settled =
						legacySettlementTurn !== undefined ||
						(turnId !== undefined &&
							[...current.apiMessages.values()].some(
								(candidate) =>
									candidate.workspaceId === workspaceId &&
									candidate.role === "assistant" &&
									candidate.turnId === turnId,
							));
					const delivered = {
						...message,
						turnId: legacySettlementTurn ?? turnId,
						status: settled ? ("settled" as const) : ("delivered" as const),
						deliveredAtMs: nowMs,
					};
					return [
						true,
						{
							...current,
							apiMessages: new Map(current.apiMessages).set(
								messageId,
								delivered,
							),
						},
					] as const;
				}),
			recordApiTurnEvent: (input) =>
				Ref.modify<MemoryState, RecordApiTurnEventOutcome>(state, (current) => {
					const receiptKey = apiTurnReceiptKey(input.workspaceId, input.turnId);
					const storedReceipt = current.apiTurnReceipts.get(receiptKey);
					const replay = [...current.apiMessages.values()].find(
						(message) =>
							message.workspaceId === input.workspaceId &&
							message.role === "assistant" &&
							message.turnId === input.turnId,
					);
					if (replay !== undefined) {
						if (storedReceipt === undefined) {
							if (
								input.adoptLegacyReplay !== true ||
								replay.messageId !== input.messageId ||
								replay.accountId !== input.accountId ||
								replay.outcome !== input.outcome
							)
								throw new Error(
									`API assistant turn is missing its receipt: ${input.workspaceId}/${input.turnId}`,
								);
							const adoptedReceipt: ApiTurnReceipt = {
								workspaceId: input.workspaceId,
								turnId: input.turnId,
								outcome: input.outcome,
								settledAtMs: input.nowMs,
								receivedAtMs: input.receivedAtMs,
								contentDigest: input.contentDigest,
							};
							const adopted = {
								...current,
								apiMessages: settleApiTurnUserMessageInMemory(
									current.apiMessages,
									input.workspaceId,
									input.turnId,
								),
								apiTurnReceipts: new Map(current.apiTurnReceipts).set(
									receiptKey,
									adoptedReceipt,
								),
							};
							return [
								{
									kind: "replay",
									message: replay,
									receipt: adoptedReceipt,
								},
								applyApiWebhookFanoutInMemory(adopted, input, adoptedReceipt),
							] as const;
						}
						if (
							!apiTurnReceiptMatchesInput(storedReceipt, input) ||
							replay.messageId !== input.messageId ||
							replay.accountId !== input.accountId
						)
							return [
								{ kind: "conflict", receipt: storedReceipt },
								current,
							] as const;
						const outcome: RecordApiTurnEventOutcome = {
							kind: "replay",
							message: replay,
							receipt: storedReceipt,
						};
						return [
							outcome,
							applyApiWebhookFanoutInMemory(current, input, storedReceipt),
						] as const;
					}
					if (storedReceipt !== undefined) {
						if (!apiTurnReceiptMatchesInput(storedReceipt, input))
							return [
								{ kind: "conflict", receipt: storedReceipt },
								current,
							] as const;
						const outcome: RecordApiTurnEventOutcome = {
							kind: "pruned-replay",
							receipt: storedReceipt,
						};
						return [
							outcome,
							applyApiWebhookFanoutInMemory(current, input, storedReceipt),
						] as const;
					}
					const message: CloudWorkspaceApiMessageRecord = {
						messageId: input.messageId,
						workspaceId: input.workspaceId,
						accountId: input.accountId,
						seq: nextApiMessageSeq(current.apiMessages, input.workspaceId),
						role: "assistant",
						sealedContent: input.sealedContent,
						turnId: input.turnId,
						outcome: input.outcome,
						status: "settled",
						createdAtMs: input.nowMs,
					};
					const apiMessages = settleApiTurnUserMessageInMemory(
						current.apiMessages,
						input.workspaceId,
						input.turnId,
					);
					apiMessages.set(message.messageId, message);
					const receipt: ApiTurnReceipt = {
						workspaceId: input.workspaceId,
						turnId: input.turnId,
						outcome: input.outcome,
						settledAtMs: input.nowMs,
						receivedAtMs: input.receivedAtMs,
						contentDigest: input.contentDigest,
					};
					const apiTurnReceipts = new Map(current.apiTurnReceipts).set(
						receiptKey,
						receipt,
					);
					const outcome: RecordApiTurnEventOutcome = {
						kind: "created",
						message,
						receipt,
					};
					const recorded = {
						...current,
						apiMessages,
						apiTurnReceipts,
					};
					return [
						outcome,
						applyApiWebhookFanoutInMemory(recorded, input, receipt),
					] as const;
				}),
			expireApiCommands: (nowMs) =>
				Ref.update(state, (current) => {
					const apiMessages = new Map(current.apiMessages);
					for (const [id, message] of apiMessages) {
						if (
							message.role === "user" &&
							(message.status === "pending" ||
								message.status === "delivered") &&
							message.expiresAtMs !== undefined &&
							message.expiresAtMs <= nowMs
						)
							apiMessages.set(id, {
								...message,
								status: message.status === "pending" ? "expired" : "failed",
							});
					}
					return { ...current, apiMessages };
				}),
			listWorkspacesWithStalePendingApiCommands: (cutoffMs) =>
				Ref.get(state).pipe(
					Effect.map((current) => [
						...new Set(
							[...current.apiMessages.values()]
								.filter(
									(message) =>
										message.role === "user" &&
										message.status === "pending" &&
										message.createdAtMs <= cutoffMs &&
										(message.expiresAtMs === undefined ||
											message.expiresAtMs > cutoffMs),
								)
								.map((message) => message.workspaceId),
						),
					]),
				),
			pruneApiData: (beforeMs) =>
				Ref.update(state, (current) => {
					const protectedMessageIds = new Set<string>();
					const messagesByWorkspace = new Map<
						string,
						Array<CloudWorkspaceApiMessageRecord>
					>();
					for (const message of current.apiMessages.values()) {
						const messages = messagesByWorkspace.get(message.workspaceId) ?? [];
						messages.push(message);
						messagesByWorkspace.set(message.workspaceId, messages);
					}
					for (const messages of messagesByWorkspace.values())
						for (const message of messages
							.sort((left, right) => right.seq - left.seq)
							.slice(0, 1_000))
							protectedMessageIds.add(message.messageId);

					const apiMessages = new Map(
						[...current.apiMessages].filter(
							([messageId, message]) =>
								protectedMessageIds.has(messageId) ||
								message.createdAtMs >= beforeMs ||
								(message.role === "assistant" &&
									(message.turnId === undefined ||
										!current.apiTurnReceipts.has(
											apiTurnReceiptKey(message.workspaceId, message.turnId),
										))) ||
								(message.status !== "settled" &&
									message.status !== "failed" &&
									message.status !== "expired"),
						),
					);
					const apiDeliveries = new Map(
						[...current.apiDeliveries].map(([deliveryId, delivery]) => [
							deliveryId,
							delivery.updatedAtMs < beforeMs &&
							(delivery.status === "delivered" || delivery.status === "failed")
								? { ...delivery, sealedPayload: "", lastError: undefined }
								: delivery,
						]),
					);
					return { ...current, apiMessages, apiDeliveries };
				}),
			claimDueApiWebhookDeliveries: (nowMs, limit, leaseMs) =>
				Ref.modify(state, (current) => {
					const due = [...current.apiDeliveries.values()]
						.filter(
							(delivery) =>
								delivery.status === "pending" &&
								delivery.nextAttemptAtMs <= nowMs &&
								current.apiWebhooks.get(delivery.webhookId)?.disabledAtMs ===
									undefined &&
								current.apiWebhooks.has(delivery.webhookId),
						)
						.sort((a, b) => a.nextAttemptAtMs - b.nextAttemptAtMs)
						.slice(0, limit);
					const apiDeliveries = new Map(current.apiDeliveries);
					const claimed: Array<DueApiWebhookDelivery> = [];
					for (const delivery of due) {
						const webhook = current.apiWebhooks.get(delivery.webhookId);
						if (webhook === undefined) continue;
						const leased = {
							...delivery,
							nextAttemptAtMs: nowMs + leaseMs,
							updatedAtMs: nowMs,
						};
						apiDeliveries.set(delivery.deliveryId, leased);
						claimed.push({
							delivery: leased,
							url: webhook.url,
							sealedSecret: webhook.sealedSecret,
						});
					}
					return [claimed, { ...current, apiDeliveries }] as const;
				}),
			completeApiWebhookDelivery: (deliveryId, nowMs) =>
				Ref.update(state, (current) => {
					const delivery = current.apiDeliveries.get(deliveryId);
					if (delivery === undefined) return current;
					return {
						...current,
						apiDeliveries: new Map(current.apiDeliveries).set(deliveryId, {
							...delivery,
							status: "delivered",
							updatedAtMs: nowMs,
						}),
					};
				}),
			failApiWebhookDelivery: (input) =>
				Ref.update(state, (current) => {
					const delivery = current.apiDeliveries.get(input.deliveryId);
					if (delivery === undefined) return current;
					return {
						...current,
						apiDeliveries: new Map(current.apiDeliveries).set(
							input.deliveryId,
							{
								...delivery,
								status: input.terminal ? "failed" : "pending",
								attempts: delivery.attempts + 1,
								lastError: input.error,
								nextAttemptAtMs: input.nextAttemptAtMs,
								updatedAtMs: input.nowMs,
							},
						),
					};
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
const authAuthorityFromRow = (row: Row): CloudAuthAuthorityRecord => ({
	accountId: String(row.account_id),
	provider: String(row.provider),
	providerSandboxId: optionalString(row.provider_sandbox_id),
	storageIncarnationId: String(row.storage_incarnation_id),
	authEpoch: numberValue(row.auth_epoch),
	toolchainVersion: String(row.toolchain_version),
	state: row.state as CloudAuthAuthorityRecord["state"],
	provisioningLeaseOwner: optionalString(row.provisioning_lease_owner),
	provisioningLeaseExpiresAtMs: optionalNumber(
		row.provisioning_lease_expires_at,
	),
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
	activeSessionId: optionalString(row.active_session_id) ?? null,
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

const apiKeyFromRow = (row: Row): ApiKeyRecord => ({
	keyId: String(row.key_id),
	accountId: String(row.account_id),
	name: String(row.name),
	secretHash: String(row.secret_hash),
	prefix: String(row.prefix),
	createdAtMs: numberValue(row.created_at),
	lastUsedAtMs: optionalNumber(row.last_used_at),
	revokedAtMs: optionalNumber(row.revoked_at),
});

const apiWebhookFromRow = (row: Row): ApiWebhookRecord => ({
	webhookId: String(row.webhook_id),
	accountId: String(row.account_id),
	url: String(row.url),
	sealedSecret: String(row.sealed_secret),
	description: optionalString(row.description),
	createdAtMs: numberValue(row.created_at),
	disabledAtMs: optionalNumber(row.disabled_at),
});

const apiMessageFromRow = (row: Row): CloudWorkspaceApiMessageRecord => ({
	messageId: String(row.message_id),
	workspaceId: String(row.workspace_id),
	accountId: String(row.account_id),
	seq: numberValue(row.seq),
	role: row.role as ApiMessageRole,
	sealedContent: String(row.sealed_content),
	commandId: optionalString(row.command_id),
	turnId: optionalString(row.turn_id),
	outcome: optionalString(row.outcome) as TurnSettlementOutcome | undefined,
	status: row.status as ApiMessageStatus,
	createdAtMs: numberValue(row.created_at),
	deliveryAttemptedAtMs: optionalNumber(row.delivery_attempted_at),
	deliveredAtMs: optionalNumber(row.delivered_at),
	expiresAtMs: optionalNumber(row.expires_at),
});

const apiTurnReceiptFromRow = (row: Row): ApiTurnReceipt => ({
	workspaceId: String(row.workspace_id),
	turnId: String(row.turn_id),
	outcome: String(row.outcome) as TurnSettlementOutcome,
	settledAtMs: numberValue(row.settled_at),
	receivedAtMs: numberValue(row.received_at),
	contentDigest: String(row.content_digest),
});

const apiDeliveryFromRow = (row: Row): ApiWebhookDeliveryRecord => ({
	deliveryId: String(row.delivery_id),
	webhookId: String(row.webhook_id),
	accountId: String(row.account_id),
	eventId: String(row.event_id),
	eventType: String(row.event_type),
	sealedPayload: String(row.sealed_payload),
	status: row.status as ApiWebhookDeliveryRecord["status"],
	attempts: numberValue(row.attempts),
	nextAttemptAtMs: numberValue(row.next_attempt_at),
	lastError: optionalString(row.last_error),
	createdAtMs: numberValue(row.created_at),
	updatedAtMs: numberValue(row.updated_at),
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
		const saveWorkspaceReturning = (w: CloudWorkspaceRecord) =>
			orDie(
				sql`UPDATE api_cloud_workspaces SET provider_sandbox_id=${w.providerSandboxId ?? null}, runtime_boot_token_hash=${w.runtimeBootTokenHash ?? null}, runtime_boot_token_expires_at=${w.runtimeBootTokenExpiresAtMs ?? null}, runtime_credential_hash=${w.runtimeCredentialHash ?? null}, runtime_state=${w.runtimeState}, state=${w.state}, desired_state=${w.desiredState}, status_code=${w.statusCode}, wrapped_transcript_key=${w.wrappedTranscriptKey ?? null}, archive_requested_at=${w.archiveRequestedAtMs ?? null}, archive_delete_at=${w.archiveDeleteAtMs ?? null}, deletion_tombstone_expires_at=${w.deletionTombstoneExpiresAtMs ?? null}, request_config=${JSON.stringify(w.requestConfig)}::jsonb, next_action_at=${w.nextActionAtMs}, revision=${w.revision}, updated_at=${w.updatedAtMs}, last_activity_at=${w.lastActivityAtMs}, running_since=${w.runningSinceMs ?? null}, deleted_at=${w.deletedAtMs ?? null} WHERE workspace_id=${w.workspaceId} AND (revision < ${w.revision} OR (revision = ${w.revision} AND updated_at < ${w.updatedAtMs})) RETURNING *`,
			);
		const saveWorkspaceIfNewer = (w: CloudWorkspaceRecord) =>
			Effect.gen(function* () {
				const rows =
					yield* sql`SELECT * FROM api_cloud_workspaces WHERE workspace_id=${w.workspaceId} FOR UPDATE`;
				if (rows[0] === undefined) return false;
				const prepared = prepareWorkspaceSave(
					workspaceFromRow(rows[0] as Row),
					w,
				);
				if (prepared === null) return false;
				return (yield* saveWorkspaceReturning(prepared)).length === 1;
			}).pipe(sql.withTransaction, Effect.orDie);
		const saveWorkspace = (w: CloudWorkspaceRecord) =>
			saveWorkspaceIfNewer(w).pipe(Effect.asVoid);
		const saveWorkspaceLifecycleCommandTransaction = (
			input: WorkspaceLifecycleCommandWrite,
		) =>
			Effect.gen(function* () {
				const receipt =
					yield* sql`INSERT INTO api_cloud_workspace_command_receipts (workspace_id, command_id, action, workspace_revision, created_at) VALUES (${input.workspace.workspaceId}, ${input.commandId}, ${input.action}, ${input.workspace.revision}, ${input.createdAtMs}) ON CONFLICT (workspace_id, command_id) DO NOTHING RETURNING command_id`;
				if (receipt.length === 0) return false;
				if (yield* saveWorkspaceIfNewer(input.workspace)) return true;
				// Keep the receipt and state transition atomic. A stale write must
				// remain retryable instead of looking successfully consumed.
				yield* sql`DELETE FROM api_cloud_workspace_command_receipts WHERE workspace_id=${input.workspace.workspaceId} AND command_id=${input.commandId}`;
				return false;
			});
		const getApiMessageTransaction = (messageId: string) =>
			sql`SELECT * FROM api_cloud_workspace_api_messages WHERE message_id=${messageId}`.pipe(
				Effect.map((rows) =>
					rows[0] ? apiMessageFromRow(rows[0] as Row) : null,
				),
			);
		const appendApiMessageTransaction = (
			input: AppendApiMessageInput,
			loaded?: CloudWorkspaceApiMessageRecord | null,
		) =>
			Effect.gen(function* () {
				const existing =
					loaded === undefined
						? yield* getApiMessageTransaction(input.messageId)
						: loaded;
				if (existing !== null)
					return {
						kind: "existing",
						message: existing,
					} satisfies AppendApiMessageOutcome;
				let status = input.status;
				if (
					input.role === "user" &&
					input.status === "delivered" &&
					input.turnId !== undefined
				) {
					const settled =
						yield* sql`SELECT 1 FROM api_cloud_workspace_api_messages WHERE workspace_id=${input.workspaceId} AND role='assistant' AND turn_id=${input.turnId} UNION ALL SELECT 1 FROM api_cloud_workspace_api_turn_receipts WHERE workspace_id=${input.workspaceId} AND turn_id=${input.turnId} LIMIT 1`;
					if (settled.length > 0) status = "settled";
				}
				const created =
					yield* sql`INSERT INTO api_cloud_workspace_api_messages (message_id, workspace_id, account_id, seq, role, sealed_content, command_id, turn_id, outcome, status, created_at, expires_at) SELECT ${input.messageId}, ${input.workspaceId}, ${input.accountId}, COALESCE(MAX(seq), 0) + 1, ${input.role}, ${input.sealedContent}, ${input.commandId ?? null}, ${input.turnId ?? null}, ${input.outcome ?? null}, ${status}, ${input.createdAtMs}, ${input.expiresAtMs ?? null} FROM api_cloud_workspace_api_messages WHERE workspace_id=${input.workspaceId} RETURNING *`;
				return {
					kind: "created",
					message: apiMessageFromRow(created[0] as Row),
				} satisfies AppendApiMessageOutcome;
			});
		const insertApiWebhookFanoutTransaction = (
			input: RecordApiTurnEventInput,
			receipt: ApiTurnReceipt,
		) => {
			const fanout = input.webhookFanout;
			if (fanout === undefined || fanout.targets.length === 0)
				return Effect.void;
			return Effect.forEach(
				fanout.targets,
				(target) =>
					sql`INSERT INTO api_api_webhook_deliveries (delivery_id, webhook_id, account_id, event_id, event_type, sealed_payload, status, attempts, next_attempt_at, created_at, updated_at)
						SELECT ${target.deliveryId}, webhook_id, ${input.accountId}, ${fanout.eventId}, ${fanout.eventType}, ${fanout.sealedPayload}, 'pending', 0, ${fanout.enqueuedAtMs}, ${fanout.enqueuedAtMs}, ${fanout.enqueuedAtMs}
						FROM api_api_webhooks
						WHERE webhook_id=${target.webhookId}
							AND account_id=${input.accountId}
							AND disabled_at IS NULL
							AND created_at <= ${receipt.settledAtMs}
						ON CONFLICT (webhook_id, event_id) DO NOTHING`,
				{ discard: true },
			);
		};
		const settleApiTurnUserMessageTransaction = (
			workspaceId: string,
			turnId: string,
		) =>
			sql`WITH candidate AS (
				SELECT message_id
				FROM api_cloud_workspace_api_messages
				WHERE workspace_id=${workspaceId}
					AND role='user'
					AND status <> 'settled'
					AND (turn_id=${turnId} OR (turn_id IS NULL AND status='delivered'))
				ORDER BY CASE WHEN turn_id=${turnId} THEN 0 ELSE 1 END, seq
				LIMIT 1
				FOR UPDATE
			)
			UPDATE api_cloud_workspace_api_messages AS message
			SET status='settled', turn_id=${turnId}
			FROM candidate
			WHERE message.message_id=candidate.message_id`.pipe(Effect.asVoid);
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
			getCloudAuthAuthority: (accountId) =>
				orDie(
					sql`SELECT * FROM api_cloud_auth_authorities WHERE account_id=${accountId}`.pipe(
						Effect.map((rows) =>
							rows[0] ? authAuthorityFromRow(rows[0] as Row) : null,
						),
					),
				),
			claimCloudAuthAuthority: (input) =>
				orDie(
					Effect.gen(function* () {
						const rows = yield* sql`
							INSERT INTO api_cloud_auth_authorities
								(account_id, provider, storage_incarnation_id, auth_epoch,
								 toolchain_version, state, provisioning_lease_owner,
								 provisioning_lease_expires_at, revision, created_at, updated_at)
							VALUES (${input.accountId}, ${input.provider},
								${input.candidateStorageIncarnationId}, 1,
								${input.toolchainVersion}, 'provisioning', ${input.leaseOwner},
								${input.leaseExpiresAtMs}, 0, ${input.nowMs}, ${input.nowMs})
							ON CONFLICT (account_id) DO UPDATE SET
								provider=EXCLUDED.provider,
								provider_sandbox_id=CASE WHEN ${input.replaceReady === true} THEN NULL ELSE api_cloud_auth_authorities.provider_sandbox_id END,
								storage_incarnation_id=CASE WHEN ${input.replaceReady === true} THEN EXCLUDED.storage_incarnation_id ELSE api_cloud_auth_authorities.storage_incarnation_id END,
								auth_epoch=CASE WHEN ${input.replaceReady === true} THEN api_cloud_auth_authorities.auth_epoch + 1 ELSE api_cloud_auth_authorities.auth_epoch END,
								toolchain_version=EXCLUDED.toolchain_version,
								state='provisioning',
								provisioning_lease_owner=EXCLUDED.provisioning_lease_owner,
								provisioning_lease_expires_at=EXCLUDED.provisioning_lease_expires_at,
								revision=api_cloud_auth_authorities.revision + 1,
								updated_at=EXCLUDED.updated_at
							WHERE (${input.replaceReady === true} OR api_cloud_auth_authorities.state <> 'ready')
								AND (api_cloud_auth_authorities.provisioning_lease_expires_at IS NULL
									OR api_cloud_auth_authorities.provisioning_lease_expires_at <= ${input.nowMs}
									OR api_cloud_auth_authorities.provisioning_lease_owner = ${input.leaseOwner})
							RETURNING *
						`;
						const row =
							rows[0] ??
							(yield* sql`SELECT * FROM api_cloud_auth_authorities WHERE account_id=${input.accountId}`)[0];
						const record = authAuthorityFromRow(row as Row);
						return {
							record,
							acquired:
								record.state === "provisioning" &&
								record.provisioningLeaseOwner === input.leaseOwner,
						};
					}).pipe(sql.withTransaction),
				),
			completeCloudAuthAuthorityProvisioning: (input) =>
				orDie(
					sql`
						UPDATE api_cloud_auth_authorities SET
							provider_sandbox_id=${input.providerSandboxId},
							storage_incarnation_id=${input.storageIncarnationId},
							toolchain_version=${input.toolchainVersion},
							state='ready', provisioning_lease_owner=NULL,
							provisioning_lease_expires_at=NULL, revision=revision + 1,
							updated_at=${input.nowMs}
						WHERE account_id=${input.accountId}
							AND (provisioning_lease_owner=${input.leaseOwner}
								OR (state='ready' AND provider_sandbox_id=${input.providerSandboxId}))
						RETURNING *
					`.pipe(
						Effect.map((rows) =>
							rows[0] ? authAuthorityFromRow(rows[0] as Row) : null,
						),
					),
				),
			advanceCloudAuthEpoch: (input) =>
				orDie(
					sql`
						UPDATE api_cloud_auth_authorities SET auth_epoch=auth_epoch + 1,
							revision=revision + 1, updated_at=${input.nowMs}
						WHERE account_id=${input.accountId} AND state='ready'
							AND provider_sandbox_id=${input.providerSandboxId}
						RETURNING *
					`.pipe(
						Effect.map((rows) =>
							rows[0] ? authAuthorityFromRow(rows[0] as Row) : null,
						),
					),
				),
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
						// Idempotent callers can independently choose different randomized
						// branches before reaching the store. Serialize by operation identity
						// first so the loser observes the existing workspace instead of racing
						// the account/idempotency unique constraint.
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cloud-workspace-idempotency:${w.accountId}:${w.idempotencyKey}`}, 0))`;
						const existing =
							yield* sql`SELECT * FROM api_cloud_workspaces WHERE account_id=${w.accountId} AND idempotency_key=${w.idempotencyKey}`;
						if (existing[0]) {
							return {
								kind: "existing",
								workspace: workspaceFromRow(existing[0] as Row),
							} satisfies CreateCloudWorkspaceOutcome;
						}
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${w.projectId}:${w.branch}`}, 0))`;
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
			transitionWorkspaceLifecycle: (input) =>
				orDie(
					Effect.gen(function* () {
						const locked =
							yield* sql`SELECT * FROM api_cloud_workspaces WHERE workspace_id=${input.workspace.workspaceId} FOR UPDATE`;
						if (locked[0] === undefined) return { kind: "missing" } as const;
						const current = workspaceFromRow(locked[0] as Row);
						if (input.commandId !== undefined) {
							const receipts =
								yield* sql`SELECT action FROM api_cloud_workspace_command_receipts WHERE workspace_id=${current.workspaceId} AND command_id=${input.commandId}`;
							if (receipts[0] !== undefined)
								return String(receipts[0].action) === input.action
									? ({
											kind: "replay",
											workspace: current,
											action: input.action,
										} as const)
									: ({
											kind: "rejected",
											workspace: current,
											reason: "command-id-reused",
										} as const);
						}
						if (
							current.revision !== input.expectedRevision ||
							current.updatedAtMs !== input.expectedUpdatedAtMs ||
							current.state !== input.expectedState ||
							current.desiredState !== input.expectedDesiredState
						)
							return { kind: "contended", workspace: current } as const;
						const prepared = prepareWorkspaceLifecycleTransition(
							current,
							input,
						);
						if (prepared.kind === "rejected")
							return {
								kind: "rejected",
								workspace: current,
								reason: prepared.reason,
							} as const;
						let saved = current;
						if (prepared.workspace !== current) {
							const updated = yield* saveWorkspaceReturning(prepared.workspace);
							if (updated[0] === undefined)
								return { kind: "contended", workspace: current } as const;
							saved = workspaceFromRow(updated[0] as Row);
						}
						if (input.commandId !== undefined)
							yield* sql`INSERT INTO api_cloud_workspace_command_receipts (workspace_id, command_id, action, workspace_revision, created_at) VALUES (${current.workspaceId}, ${input.commandId}, ${input.action}, ${saved.revision}, ${input.createdAtMs})`;
						return {
							kind: "applied",
							workspace: saved,
							action: input.action,
						} as const;
					}).pipe(sql.withTransaction),
				),
			listPendingMailboxLifecycles: (limit) =>
				orDie(
					sql`SELECT * FROM api_cloud_workspaces
						WHERE request_config #>> '{cloudMailboxLifecyclePending,action}' IN ('archive', 'delete')
							AND jsonb_typeof(request_config #> '{cloudMailboxLifecyclePending,destructionFence}')='number'
						ORDER BY updated_at
						LIMIT ${limit}`.pipe(
						Effect.map((rows) =>
							rows.flatMap((row) => {
								const lifecycle = mailboxLifecycleToDeliver(
									workspaceFromRow(row as Row),
								);
								return lifecycle === null ? [] : [lifecycle];
							}),
						),
					),
				),
			acknowledgeMailboxLifecycle: (lifecycle, nowMs) =>
				orDie(
					sql`UPDATE api_cloud_workspaces
						SET request_config=(request_config - 'cloudMailboxLifecyclePending') || jsonb_build_object(
								'cloudMailboxLifecycleDelivered',
								jsonb_build_object(
									'action', ${lifecycle.action}::text,
									'destructionFence', ${lifecycle.destructionFence}::bigint
								)
							),
							revision=revision+1,
							updated_at=GREATEST(${nowMs}::bigint, updated_at+1)
						WHERE workspace_id=${lifecycle.workspaceId}
							AND request_config #>> '{cloudMailboxLifecyclePending,action}'=${lifecycle.action}
							AND request_config #> '{cloudMailboxLifecyclePending,destructionFence}'=to_jsonb(${lifecycle.destructionFence}::bigint)
						RETURNING workspace_id`.pipe(
						Effect.map((rows) => rows.length === 1),
					),
				),
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
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceLifecycleLockKey(input.workspace.workspaceId)}, 0))`;
						return yield* saveWorkspaceLifecycleCommandTransaction(input);
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
							...(input.capabilities === undefined
								? {}
								: { capabilities: input.capabilities }),
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
						request_config=(request_config - 'cloudCommandProtocolVersion' - 'cloudCommandRuntimeGeneration') || jsonb_build_object(
							'runtimeProcessManaged', true,
							'startupTimings', COALESCE(request_config->'startupTimings', '{}'::jsonb) || jsonb_build_object(
								'connectedAt', COALESCE(request_config #> '{startupTimings,connectedAt}', to_jsonb(${input.nowMs}::bigint)),
								'repositoryReadyAt', COALESCE(request_config #> '{startupTimings,repositoryReadyAt}', to_jsonb(${input.nowMs}::bigint))
							)
						) || CASE WHEN ${input.commandProtocolVersion ?? null}::integer IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
							'cloudCommandProtocolVersion', ${input.commandProtocolVersion ?? null}::integer,
							'cloudCommandRuntimeGeneration', COALESCE((request_config->>'runtimeGeneration')::bigint, 1)
						) END,
						next_action_at=CASE WHEN COALESCE((request_config->>'cloudMailboxWakePending')::boolean, false)=true THEN LEAST(next_action_at, ${input.nowMs}::bigint) WHEN jsonb_typeof(request_config->'sessionHeadVersion')='number' AND COALESCE((request_config->>'runtimeSessionRecoveryPending')::boolean, false)=false THEN ${input.nextIdleAtMs}::bigint ELSE ${input.nowMs + 30_000}::bigint END,
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
							cloudWorkspaceRuntimeGeneration(workspace) !== input.generation ||
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
					sql`UPDATE api_cloud_workspaces SET desired_state=CASE WHEN state='paused' THEN 'ready' ELSE desired_state END, status_code=CASE WHEN state='paused' THEN 'resume-queued' ELSE status_code END, request_config=CASE WHEN state='paused' THEN jsonb_set(request_config, '{startupTimings}', jsonb_build_object('requestedAt', ${nowMs}::bigint, 'resumeRequestedAt', ${nowMs}::bigint), true) ELSE request_config END, next_action_at=CASE WHEN COALESCE((request_config->>'cloudMailboxWakePending')::boolean, false)=true THEN next_action_at WHEN state='paused' THEN ${nowMs} WHEN state='ready' THEN ${nextIdleAtMs} ELSE next_action_at END, last_activity_at=${nowMs}, revision=revision+1, updated_at=${nowMs} WHERE workspace_id=${workspaceId} AND account_id=${accountId} AND state <> 'deleted' AND desired_state <> 'deleted' AND (request_config #>> '{cloudMailboxLifecyclePending,action}') IS DISTINCT FROM 'delete' AND (request_config #>> '{cloudMailboxLifecycleDelivered,action}') IS DISTINCT FROM 'delete' RETURNING *`.pipe(
						Effect.map((rows) =>
							rows[0] ? workspaceFromRow(rows[0] as Row) : null,
						),
					),
				),
			requestMailboxWake: (workspaceId, accountId, nowMs, _nextIdleAtMs) =>
				orDie(
					sql`UPDATE api_cloud_workspaces SET
						desired_state='ready',
						status_code=CASE WHEN state IN ('paused','pausing') OR (state='ready' AND runtime_state <> 'online') THEN 'resume-queued' ELSE status_code END,
						request_config=(CASE
							WHEN COALESCE((request_config->>'cloudMailboxWakePending')::boolean, false)=true THEN
								CASE WHEN state IN ('paused','pausing') OR (state='ready' AND runtime_state <> 'online') THEN jsonb_set(request_config, '{startupTimings}', jsonb_build_object('requestedAt', ${nowMs}::bigint, 'resumeRequestedAt', ${nowMs}::bigint), true) ELSE request_config END
							ELSE
								(CASE WHEN state IN ('paused','pausing') OR (state='ready' AND runtime_state <> 'online') THEN jsonb_set(request_config, '{startupTimings}', jsonb_build_object('requestedAt', ${nowMs}::bigint, 'resumeRequestedAt', ${nowMs}::bigint), true) ELSE request_config END) - 'cloudMailboxRuntimeSeenAt' - 'cloudMailboxProgressAt' - 'cloudMailboxProgressRevision' - 'cloudMailboxFenceRequired'
						END) || jsonb_build_object(
							'cloudMailboxWakePending', true,
							'cloudMailboxWakeRequestedAt', CASE WHEN COALESCE((request_config->>'cloudMailboxWakePending')::boolean, false)=true AND jsonb_typeof(request_config->'cloudMailboxWakeRequestedAt')='number' THEN request_config->'cloudMailboxWakeRequestedAt' ELSE to_jsonb(${nowMs}::bigint) END,
							'cloudMailboxWakeRevision', CASE WHEN jsonb_typeof(request_config->'cloudMailboxWakeRevision')='number' THEN (request_config->>'cloudMailboxWakeRevision')::bigint + 1 ELSE 1 END
						),
						next_action_at=${nowMs},
						last_activity_at=${nowMs}, revision=revision+1, updated_at=${nowMs}
					 WHERE workspace_id=${workspaceId} AND account_id=${accountId}
						AND state NOT IN ('archived','archiving','deleted','deleting')
						AND desired_state NOT IN ('archived','deleted')
						AND (request_config #>> '{cloudMailboxLifecyclePending,action}') IS DISTINCT FROM 'delete'
						AND (request_config #>> '{cloudMailboxLifecycleDelivered,action}') IS DISTINCT FROM 'delete'
					 RETURNING *`.pipe(
						Effect.map((rows) =>
							rows[0] ? workspaceFromRow(rows[0] as Row) : null,
						),
					),
				),
			recordMailboxRuntimePoll: (
				workspaceId,
				accountId,
				runtimeGeneration,
				nowMs,
				nextCheckAtMs,
			) =>
				orDie(
					Effect.gen(function* () {
						const observed = yield* sql`UPDATE api_cloud_workspaces SET
								request_config=jsonb_set(jsonb_set(request_config, '{cloudMailboxWakeRevision}', to_jsonb(CASE WHEN jsonb_typeof(request_config->'cloudMailboxWakeRevision')='number' THEN (request_config->>'cloudMailboxWakeRevision')::bigint ELSE 1 END), true), '{cloudMailboxRuntimeSeenAt}', to_jsonb(${nowMs}::bigint), true),
								next_action_at=${nextCheckAtMs}, revision=revision+1, updated_at=${nowMs}
							 WHERE workspace_id=${workspaceId} AND account_id=${accountId}
								AND COALESCE((request_config->>'cloudMailboxWakePending')::boolean, false)=true
								AND state='ready' AND desired_state='ready' AND runtime_state='online'
								AND COALESCE((request_config->>'runtimeGeneration')::bigint, 1)=${runtimeGeneration}
								AND jsonb_typeof(request_config->'cloudMailboxRuntimeSeenAt') IS DISTINCT FROM 'number'
							 RETURNING (request_config->>'cloudMailboxWakeRevision')::bigint AS wake_revision`;
						const rows =
							observed.length > 0
								? observed
								: yield* sql`SELECT (request_config->>'cloudMailboxWakeRevision')::bigint AS wake_revision
									 FROM api_cloud_workspaces
									 WHERE workspace_id=${workspaceId} AND account_id=${accountId}
										AND COALESCE((request_config->>'cloudMailboxWakePending')::boolean, false)=true
										AND state='ready' AND desired_state='ready' AND runtime_state='online'
										AND COALESCE((request_config->>'runtimeGeneration')::bigint, 1)=${runtimeGeneration}`;
						const wakeRevision = rows[0]?.wake_revision;
						return typeof wakeRevision === "number"
							? wakeRevision
							: wakeRevision === undefined
								? null
								: Number(wakeRevision);
					}).pipe(sql.withTransaction),
				),
			recordMailboxRuntimeProgress: (
				workspaceId,
				accountId,
				runtimeGeneration,
				wakeRevision,
				mailboxRevision,
				fenceRequired,
				nowMs,
				nextCheckAtMs,
			) =>
				orDie(
					(fenceRequired
						? sql`UPDATE api_cloud_workspaces SET
								request_config=request_config || jsonb_build_object('cloudMailboxFenceRequired', true, 'cloudMailboxProgressRevision', ${mailboxRevision}::bigint, 'cloudMailboxProgressAt', ${nowMs}::bigint),
								next_action_at=${nowMs}, revision=revision+1, updated_at=${nowMs}
							 WHERE workspace_id=${workspaceId} AND account_id=${accountId}
								AND COALESCE((request_config->>'cloudMailboxWakePending')::boolean, false)=true
								AND (request_config->>'cloudMailboxWakeRevision')::bigint=${wakeRevision}
								AND state='ready' AND desired_state='ready' AND runtime_state='online'
								AND COALESCE((request_config->>'runtimeGeneration')::bigint, 1)=${runtimeGeneration}
								AND COALESCE((request_config->>'cloudMailboxFenceRequired')::boolean, false)=false
							 RETURNING workspace_id`
						: sql`UPDATE api_cloud_workspaces SET
								request_config=request_config || jsonb_build_object('cloudMailboxProgressRevision', ${mailboxRevision}::bigint, 'cloudMailboxProgressAt', ${nowMs}::bigint),
								next_action_at=${nextCheckAtMs}, revision=revision+1, updated_at=${nowMs}
							 WHERE workspace_id=${workspaceId} AND account_id=${accountId}
								AND COALESCE((request_config->>'cloudMailboxWakePending')::boolean, false)=true
								AND (request_config->>'cloudMailboxWakeRevision')::bigint=${wakeRevision}
								AND state='ready' AND desired_state='ready' AND runtime_state='online'
								AND COALESCE((request_config->>'runtimeGeneration')::bigint, 1)=${runtimeGeneration}
								AND COALESCE((request_config->>'cloudMailboxFenceRequired')::boolean, false)=false
								AND (jsonb_typeof(request_config->'cloudMailboxProgressRevision') IS DISTINCT FROM 'number' OR (request_config->>'cloudMailboxProgressRevision')::bigint < ${mailboxRevision})
							 RETURNING workspace_id`
					).pipe(Effect.map((rows) => rows.length === 1)),
				),
			completeMailboxDrain: (
				workspaceId,
				accountId,
				runtimeGeneration,
				wakeRevision,
				nowMs,
				nextIdleAtMs,
			) =>
				orDie(
					sql`UPDATE api_cloud_workspaces SET
						request_config=request_config - 'cloudMailboxWakePending' - 'cloudMailboxWakeRequestedAt' - 'cloudMailboxRuntimeSeenAt' - 'cloudMailboxProgressAt' - 'cloudMailboxProgressRevision' - 'cloudMailboxFenceRequired',
						next_action_at=${nextIdleAtMs}, revision=revision+1, updated_at=${nowMs}
					 WHERE workspace_id=${workspaceId} AND account_id=${accountId}
						AND COALESCE((request_config->>'cloudMailboxWakePending')::boolean, false)=true
						AND (request_config->>'cloudMailboxWakeRevision')::bigint=${wakeRevision}
						AND state='ready' AND desired_state='ready' AND runtime_state='online'
						AND COALESCE((request_config->>'runtimeGeneration')::bigint, 1)=${runtimeGeneration}
					 RETURNING workspace_id`.pipe(
						Effect.map((rows) => rows.length === 1),
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
								(workspace_id, runtime_generation, summary_revision, title, last_activity_at, active_session_id, session_head_version, updated_at)
							SELECT ${input.workspaceId}, ${input.runtimeGeneration}, ${input.summaryRevision}, ${input.title}, ${input.lastActivityAtMs}, ${input.activeSessionId}, ${input.sessionHeadVersion}, ${input.updatedAtMs}
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
								active_session_id=EXCLUDED.active_session_id,
								session_head_version=CASE
									WHEN api_cloud_workspace_runtime_summaries.runtime_generation=EXCLUDED.runtime_generation
										AND api_cloud_workspace_runtime_summaries.active_session_id IS NOT DISTINCT FROM EXCLUDED.active_session_id
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
						const locked =
							yield* sql`SELECT * FROM api_cloud_workspaces WHERE account_id=${accountId} FOR UPDATE`;
						if (
							locked.some(
								(row) =>
									!workspaceDeletionIsDurablyFenced(
										workspaceFromRow(row as Row),
									),
							)
						)
							return false;
						for (const row of locked)
							yield* sql`DELETE FROM api_cloud_workspaces WHERE workspace_id=${String(row.workspace_id)}`;
						// A workspace created after the row lock must keep account cleanup from
						// cascading through a live workspace. Project FKs close the final race.
						const remaining =
							yield* sql`SELECT workspace_id FROM api_cloud_workspaces WHERE account_id=${accountId} LIMIT 1`;
						if (remaining.length > 0) return false;
						yield* sql`DELETE FROM api_cloud_workspace_usage WHERE account_id=${accountId}`;
						yield* sql`DELETE FROM api_cloud_project_builds WHERE account_id=${accountId}`;
						yield* sql`DELETE FROM api_cloud_projects WHERE account_id=${accountId}`;
						yield* sql`DELETE FROM api_cloud_github_installations WHERE account_id=${accountId}`;
						yield* sql`DELETE FROM api_api_webhooks WHERE account_id=${accountId}`;
						yield* sql`DELETE FROM api_api_keys WHERE account_id=${accountId}`;
						yield* sql`DELETE FROM api_cloud_auth_authorities WHERE account_id=${accountId}`;
						return true;
					}).pipe(sql.withTransaction),
				),
			recordUsage: (event) =>
				orDie(
					sql`INSERT INTO api_cloud_workspace_usage (event_id, workspace_id, account_id, provider, kind, quantity, provider_event_id, occurred_at, created_at) VALUES (${event.eventId}, ${event.workspaceId}, ${event.accountId}, ${event.provider}, ${event.kind}, ${event.quantity}, ${event.providerEventId ?? null}, ${event.occurredAtMs}, ${Date.now()}) ON CONFLICT DO NOTHING RETURNING event_id`.pipe(
						Effect.map((rows) => rows.length > 0),
					),
				),
			createApiKey: (key) =>
				orDie(
					sql`INSERT INTO api_api_keys (key_id, account_id, name, secret_hash, prefix, created_at, last_used_at, revoked_at) VALUES (${key.keyId}, ${key.accountId}, ${key.name}, ${key.secretHash}, ${key.prefix}, ${key.createdAtMs}, ${key.lastUsedAtMs ?? null}, ${key.revokedAtMs ?? null})`.pipe(
						Effect.asVoid,
					),
				),
			listApiKeys: (accountId) =>
				orDie(
					sql`SELECT * FROM api_api_keys WHERE account_id=${accountId} ORDER BY created_at`.pipe(
						Effect.map((rows) => rows.map((row) => apiKeyFromRow(row as Row))),
					),
				),
			revokeApiKey: (accountId, keyId, nowMs) =>
				orDie(
					sql`UPDATE api_api_keys SET revoked_at=COALESCE(revoked_at, ${nowMs}) WHERE key_id=${keyId} AND account_id=${accountId} RETURNING *`.pipe(
						Effect.map((rows) =>
							rows[0] ? apiKeyFromRow(rows[0] as Row) : null,
						),
					),
				),
			findActiveApiKeyByHash: (secretHash) =>
				orDie(
					sql`SELECT * FROM api_api_keys WHERE secret_hash=${secretHash} AND revoked_at IS NULL LIMIT 1`.pipe(
						Effect.map((rows) =>
							rows[0] ? apiKeyFromRow(rows[0] as Row) : null,
						),
					),
				),
			touchApiKey: (keyId, nowMs) =>
				orDie(
					sql`UPDATE api_api_keys SET last_used_at=${nowMs} WHERE key_id=${keyId} AND (last_used_at IS NULL OR last_used_at <= ${nowMs - 60_000})`.pipe(
						Effect.asVoid,
					),
				),
			createApiWebhook: (webhook, activeLimit) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${apiWebhooksLockKey(webhook.accountId)}, 0))`;
						const rows =
							yield* sql`SELECT COUNT(*)::int AS active_count FROM api_api_webhooks WHERE account_id=${webhook.accountId} AND disabled_at IS NULL`;
						const activeCount = Number(
							(rows[0] as Row | undefined)?.active_count ?? 0,
						);
						if (activeCount >= activeLimit) return false;
						const inserted =
							yield* sql`INSERT INTO api_api_webhooks (webhook_id, account_id, url, sealed_secret, description, created_at, disabled_at) VALUES (${webhook.webhookId}, ${webhook.accountId}, ${webhook.url}, ${webhook.sealedSecret}, ${webhook.description ?? null}, ${webhook.createdAtMs}, ${webhook.disabledAtMs ?? null}) ON CONFLICT (webhook_id) DO NOTHING RETURNING webhook_id`;
						return inserted.length === 1;
					}).pipe(sql.withTransaction),
				),
			listApiWebhooks: (accountId) =>
				orDie(
					sql`SELECT * FROM api_api_webhooks WHERE account_id=${accountId} AND disabled_at IS NULL ORDER BY created_at`.pipe(
						Effect.map((rows) =>
							rows.map((row) => apiWebhookFromRow(row as Row)),
						),
					),
				),
			deleteApiWebhook: (accountId, webhookId) =>
				orDie(
					sql`DELETE FROM api_api_webhooks WHERE webhook_id=${webhookId} AND account_id=${accountId} RETURNING webhook_id`.pipe(
						Effect.map((rows) => rows.length === 1),
					),
				),
			appendApiMessage: (input) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${apiMessagesLockKey(input.workspaceId)}, 0))`;
						return yield* appendApiMessageTransaction(input);
					}).pipe(sql.withTransaction),
				),
			appendApiMessageGuarded: (input) =>
				orDie(
					Effect.gen(function* () {
						const workspaceId = input.expectedWorkspace.workspaceId;
						// All operations needing both locks acquire lifecycle first, then
						// the API ledger lock. Single-resource writes use their one lock.
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceLifecycleLockKey(workspaceId)}, 0))`;
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${apiMessagesLockKey(workspaceId)}, 0))`;
						const existing = yield* getApiMessageTransaction(
							input.message.messageId,
						);
						const rows =
							yield* sql`SELECT * FROM api_cloud_workspaces WHERE workspace_id=${workspaceId} FOR UPDATE`;
						const saved = rows[0] ? workspaceFromRow(rows[0] as Row) : null;
						if (
							saved !== null &&
							existing !== null &&
							existing.status !== "pending" &&
							guardedAppendTargetsWorkspace(input, saved) &&
							apiMessageBelongsToWorkspace(existing, saved)
						)
							return {
								kind: "committed",
								append: { kind: "existing", message: existing },
								workspace: saved,
								lifecycleCommandSaved: false,
							} satisfies AppendApiMessageGuardedOutcome;
						if (
							saved === null ||
							!workspaceVersionMatches(saved, input.expectedWorkspace) ||
							!guardedAppendTargetsWorkspace(input, saved)
						) {
							return {
								kind: "workspace-contended",
								workspace: saved,
							} satisfies AppendApiMessageGuardedOutcome;
						}

						let lifecycleCommandSaved = false;
						if (input.lifecycleCommand !== undefined) {
							lifecycleCommandSaved =
								yield* saveWorkspaceLifecycleCommandTransaction(
									input.lifecycleCommand,
								);
							if (!lifecycleCommandSaved)
								return {
									kind: "workspace-contended",
									workspace: saved,
								} satisfies AppendApiMessageGuardedOutcome;
						}

						const append = yield* appendApiMessageTransaction(
							input.message,
							existing,
						);
						const workspace =
							input.lifecycleCommand === undefined
								? saved
								: {
										...input.lifecycleCommand.workspace,
										leaseOwner: saved.leaseOwner,
										leaseExpiresAtMs: saved.leaseExpiresAtMs,
									};
						return {
							kind: "committed",
							append,
							workspace,
							lifecycleCommandSaved,
						} satisfies AppendApiMessageGuardedOutcome;
					}).pipe(sql.withTransaction),
				),
			getApiMessage: (messageId) =>
				orDie(
					sql`SELECT * FROM api_cloud_workspace_api_messages WHERE message_id=${messageId}`.pipe(
						Effect.map((rows) =>
							rows[0] ? apiMessageFromRow(rows[0] as Row) : null,
						),
					),
				),
			listApiMessages: (workspaceId, afterSeq, limit) =>
				orDie(
					sql`SELECT * FROM api_cloud_workspace_api_messages WHERE workspace_id=${workspaceId} AND seq > ${afterSeq} ORDER BY seq LIMIT ${limit}`.pipe(
						Effect.map((rows) =>
							rows.map((row) => apiMessageFromRow(row as Row)),
						),
					),
				),
			getApiWorkspaceLedgerSummary: (workspaceId) =>
				orDie(
					sql`SELECT
						COALESCE((SELECT MAX(seq) FROM api_cloud_workspace_api_messages WHERE workspace_id=${workspaceId}), 0) AS latest_seq,
						EXISTS(SELECT 1 FROM api_cloud_workspace_api_messages WHERE workspace_id=${workspaceId} AND role='user' AND status IN ('pending', 'delivered')) AS outstanding,
						(SELECT row_to_json(assistant) FROM (SELECT * FROM api_cloud_workspace_api_messages WHERE workspace_id=${workspaceId} AND role='assistant' ORDER BY seq DESC LIMIT 1) AS assistant) AS last_assistant`.pipe(
						Effect.map((rows) => {
							const row = rows[0] as Row;
							const lastAssistant = row.last_assistant;
							return {
								latestSeq: numberValue(row.latest_seq),
								hasOutstanding: row.outstanding === true,
								lastAssistant:
									typeof lastAssistant === "object" && lastAssistant !== null
										? apiMessageFromRow(lastAssistant as Row)
										: null,
							} satisfies ApiWorkspaceLedgerSummary;
						}),
					),
				),
			claimNextApiCommand: (workspaceId, nowMs) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${apiMessagesLockKey(workspaceId)}, 0))`;
						const rows =
							yield* sql`SELECT * FROM api_cloud_workspace_api_messages WHERE workspace_id=${workspaceId} AND role='user' AND status='pending' AND (expires_at IS NULL OR expires_at > ${nowMs}) ORDER BY seq`;
						const first = rows[0] as Row | undefined;
						if (first === undefined) return null;
						const attemptedRows =
							yield* sql`UPDATE api_cloud_workspace_api_messages SET delivery_attempted_at=GREATEST(COALESCE(delivery_attempted_at, 0), ${nowMs}) WHERE message_id=${String(first.message_id)} AND workspace_id=${workspaceId} AND role='user' AND status='pending' RETURNING *`;
						const attempted = attemptedRows[0] as Row | undefined;
						if (attempted === undefined) return null;
						return apiMessageFromRow(attempted);
					}).pipe(sql.withTransaction),
				),
			ackApiCommand: (workspaceId, messageId, turnId, commandTurnId, nowMs) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${apiMessagesLockKey(workspaceId)}, 0))`;
						if (turnId === undefined) {
							const pendingRows =
								yield* sql`SELECT * FROM api_cloud_workspace_api_messages WHERE workspace_id=${workspaceId} AND message_id=${messageId} AND role='user' AND status='pending'`;
							const pending = pendingRows[0]
								? apiMessageFromRow(pendingRows[0] as Row)
								: null;
							if (pending === null) {
								const legacyFound =
									yield* sql`SELECT message_id FROM api_cloud_workspace_api_messages WHERE workspace_id=${workspaceId} AND message_id=${messageId} AND role='user' AND status IN ('delivered', 'settled')`;
								return legacyFound.length === 1;
							}
							const candidateRows =
								pending.deliveryAttemptedAtMs === undefined
									? []
									: yield* sql`SELECT assistant.turn_id
									FROM api_cloud_workspace_api_messages AS assistant
									INNER JOIN api_cloud_workspace_api_turn_receipts AS receipt
										ON receipt.workspace_id=assistant.workspace_id
										AND receipt.turn_id=assistant.turn_id
									WHERE assistant.workspace_id=${workspaceId}
										AND assistant.role='assistant'
										AND assistant.status='settled'
										AND assistant.seq > ${pending.seq}
										AND receipt.received_at >= ${pending.deliveryAttemptedAtMs}
										AND receipt.received_at <= ${nowMs}
										AND receipt.settled_at >= ${pending.deliveryAttemptedAtMs}
										AND NOT EXISTS (
											SELECT 1
											FROM api_cloud_workspace_api_messages AS claimed
											WHERE claimed.workspace_id=${workspaceId}
												AND claimed.role='user'
												AND claimed.message_id <> ${messageId}
												AND claimed.turn_id=assistant.turn_id
										)
										AND NOT EXISTS (
											SELECT 1
											FROM api_cloud_workspace_api_messages AS earlier
											WHERE earlier.workspace_id=${workspaceId}
												AND earlier.role='user'
												AND earlier.seq < ${pending.seq}
												AND earlier.status IN ('pending', 'delivered')
												AND (earlier.expires_at IS NULL OR earlier.expires_at > ${nowMs})
										)
									ORDER BY assistant.seq
									LIMIT 2`;
							const legacySettlementTurn =
								candidateRows.length === 1
									? String((candidateRows[0] as Row).turn_id)
									: undefined;
							const legacyRows =
								yield* sql`UPDATE api_cloud_workspace_api_messages SET status=${legacySettlementTurn === undefined ? "delivered" : "settled"}, delivered_at=${nowMs}, turn_id=${legacySettlementTurn ?? null} WHERE workspace_id=${workspaceId} AND message_id=${messageId} AND role='user' AND status='pending' RETURNING message_id`;
							if (legacyRows.length === 1) return true;
							return false;
						}
						const rows =
							yield* sql`UPDATE api_cloud_workspace_api_messages AS message SET status=CASE WHEN EXISTS (SELECT 1 FROM api_cloud_workspace_api_messages AS assistant WHERE assistant.workspace_id=${workspaceId} AND assistant.role='assistant' AND assistant.turn_id=${turnId}) THEN 'settled' ELSE 'delivered' END, delivered_at=${nowMs}, turn_id=${turnId} WHERE message.workspace_id=${workspaceId} AND message.message_id=${messageId} AND message.role='user' AND message.status='pending' AND (message.turn_id IS NULL OR message.turn_id=${turnId} OR (${commandTurnId ?? null} IS NOT NULL AND message.turn_id=${commandTurnId ?? null})) RETURNING message_id`;
						if (rows.length === 1) return true;
						const found =
							yield* sql`SELECT message_id FROM api_cloud_workspace_api_messages WHERE workspace_id=${workspaceId} AND message_id=${messageId} AND role='user' AND turn_id=${turnId} AND status IN ('delivered', 'settled')`;
						return found.length === 1;
					}).pipe(sql.withTransaction),
				),
			recordApiTurnEvent: (input) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${apiMessagesLockKey(input.workspaceId)}, 0))`;
						const replayRows =
							yield* sql`SELECT * FROM api_cloud_workspace_api_messages WHERE workspace_id=${input.workspaceId} AND role='assistant' AND turn_id=${input.turnId}`;
						const receiptRow =
							(yield* sql`SELECT * FROM api_cloud_workspace_api_turn_receipts WHERE workspace_id=${input.workspaceId} AND turn_id=${input.turnId}`)[0];
						const replayRow = replayRows[0] as Row | undefined;
						let receipt: ApiTurnReceipt;
						let outcome: RecordApiTurnEventOutcome;
						if (replayRow !== undefined) {
							const replay = apiMessageFromRow(replayRow);
							if (receiptRow === undefined) {
								if (
									input.adoptLegacyReplay !== true ||
									replay.messageId !== input.messageId ||
									replay.accountId !== input.accountId ||
									replay.outcome !== input.outcome
								)
									return yield* Effect.die(
										new Error(
											`API assistant turn is missing its receipt: ${input.workspaceId}/${input.turnId}`,
										),
									);
								yield* sql`INSERT INTO api_cloud_workspace_api_turn_receipts (workspace_id, turn_id, outcome, settled_at, received_at, content_digest) VALUES (${input.workspaceId}, ${input.turnId}, ${input.outcome}, ${input.nowMs}, ${input.receivedAtMs}, ${input.contentDigest})`;
								yield* settleApiTurnUserMessageTransaction(
									input.workspaceId,
									input.turnId,
								);
								receipt = {
									workspaceId: input.workspaceId,
									turnId: input.turnId,
									outcome: input.outcome,
									settledAtMs: input.nowMs,
									receivedAtMs: input.receivedAtMs,
									contentDigest: input.contentDigest,
								};
							} else {
								receipt = apiTurnReceiptFromRow(receiptRow as Row);
							}
							if (
								!apiTurnReceiptMatchesInput(receipt, input) ||
								replay.messageId !== input.messageId ||
								replay.accountId !== input.accountId
							)
								return {
									kind: "conflict",
									receipt,
								} satisfies RecordApiTurnEventOutcome;
							outcome = {
								kind: "replay",
								message: replay,
								receipt,
							} satisfies RecordApiTurnEventOutcome;
						} else if (receiptRow !== undefined) {
							receipt = apiTurnReceiptFromRow(receiptRow as Row);
							if (!apiTurnReceiptMatchesInput(receipt, input))
								return {
									kind: "conflict",
									receipt,
								} satisfies RecordApiTurnEventOutcome;
							outcome = {
								kind: "pruned-replay",
								receipt,
							} satisfies RecordApiTurnEventOutcome;
						} else {
							const created =
								yield* sql`INSERT INTO api_cloud_workspace_api_messages (message_id, workspace_id, account_id, seq, role, sealed_content, turn_id, outcome, status, created_at) SELECT ${input.messageId}, ${input.workspaceId}, ${input.accountId}, COALESCE(MAX(seq), 0) + 1, 'assistant', ${input.sealedContent}, ${input.turnId}, ${input.outcome}, 'settled', ${input.nowMs} FROM api_cloud_workspace_api_messages WHERE workspace_id=${input.workspaceId} RETURNING *`;
							yield* sql`INSERT INTO api_cloud_workspace_api_turn_receipts (workspace_id, turn_id, outcome, settled_at, received_at, content_digest) VALUES (${input.workspaceId}, ${input.turnId}, ${input.outcome}, ${input.nowMs}, ${input.receivedAtMs}, ${input.contentDigest})`;
							yield* settleApiTurnUserMessageTransaction(
								input.workspaceId,
								input.turnId,
							);
							receipt = {
								workspaceId: input.workspaceId,
								turnId: input.turnId,
								outcome: input.outcome,
								settledAtMs: input.nowMs,
								receivedAtMs: input.receivedAtMs,
								contentDigest: input.contentDigest,
							};
							outcome = {
								kind: "created",
								message: apiMessageFromRow(created[0] as Row),
								receipt,
							} satisfies RecordApiTurnEventOutcome;
						}
						yield* insertApiWebhookFanoutTransaction(input, receipt);
						return outcome;
					}).pipe(sql.withTransaction),
				),
			expireApiCommands: (nowMs) =>
				orDie(
					sql`UPDATE api_cloud_workspace_api_messages SET status=CASE WHEN status='pending' THEN 'expired' ELSE 'failed' END WHERE role='user' AND status IN ('pending', 'delivered') AND expires_at IS NOT NULL AND expires_at <= ${nowMs}`.pipe(
						Effect.asVoid,
					),
				),
			listWorkspacesWithStalePendingApiCommands: (cutoffMs) =>
				orDie(
					sql`SELECT DISTINCT workspace_id FROM api_cloud_workspace_api_messages WHERE role='user' AND status='pending' AND created_at <= ${cutoffMs} AND (expires_at IS NULL OR expires_at > ${cutoffMs})`.pipe(
						Effect.map((rows) =>
							rows.map((row) => String((row as Row).workspace_id)),
						),
					),
				),
			pruneApiData: (beforeMs) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`WITH ranked AS (
							SELECT message_id, row_number() OVER (PARTITION BY workspace_id ORDER BY seq DESC) AS recency_rank
							FROM api_cloud_workspace_api_messages
						)
						DELETE FROM api_cloud_workspace_api_messages AS message
						USING ranked
						WHERE message.message_id=ranked.message_id
							AND ranked.recency_rank > 1000
							AND message.created_at < ${beforeMs}
							AND message.status IN ('settled', 'failed', 'expired')
							AND (
								message.role <> 'assistant'
								OR EXISTS (
									SELECT 1
									FROM api_cloud_workspace_api_turn_receipts AS receipt
									WHERE receipt.workspace_id=message.workspace_id
										AND receipt.turn_id=message.turn_id
								)
							)`;
						// Preserve the compact (webhook_id,event_id) tombstone: runtimes
						// replay durable turn events after restarts, so deleting it would
						// resurrect an already delivered webhook. Only discard old payloads.
						yield* sql`UPDATE api_api_webhook_deliveries SET sealed_payload='', last_error=NULL WHERE updated_at < ${beforeMs} AND status IN ('delivered', 'failed') AND sealed_payload <> ''`;
					}).pipe(sql.withTransaction, Effect.asVoid),
				),
			claimDueApiWebhookDeliveries: (nowMs, limit, leaseMs) =>
				orDie(
					sql`WITH candidate AS (SELECT d.delivery_id FROM api_api_webhook_deliveries AS d JOIN api_api_webhooks AS w ON w.webhook_id=d.webhook_id AND w.disabled_at IS NULL WHERE d.status='pending' AND d.next_attempt_at <= ${nowMs} ORDER BY d.next_attempt_at LIMIT ${limit} FOR UPDATE OF d SKIP LOCKED) UPDATE api_api_webhook_deliveries AS d SET next_attempt_at=${nowMs + leaseMs}, updated_at=${nowMs} FROM candidate, api_api_webhooks AS w WHERE d.delivery_id=candidate.delivery_id AND w.webhook_id=d.webhook_id RETURNING d.*, w.url AS webhook_url, w.sealed_secret AS webhook_sealed_secret`.pipe(
						Effect.map((rows) =>
							rows.map((raw) => {
								const row = raw as Row;
								return {
									delivery: apiDeliveryFromRow(row),
									url: String(row.webhook_url),
									sealedSecret: String(row.webhook_sealed_secret),
								} satisfies DueApiWebhookDelivery;
							}),
						),
					),
				),
			completeApiWebhookDelivery: (deliveryId, nowMs) =>
				orDie(
					sql`UPDATE api_api_webhook_deliveries SET status='delivered', updated_at=${nowMs} WHERE delivery_id=${deliveryId}`.pipe(
						Effect.asVoid,
					),
				),
			failApiWebhookDelivery: (input) =>
				orDie(
					sql`UPDATE api_api_webhook_deliveries SET status=${input.terminal ? "failed" : "pending"}, attempts=attempts + 1, last_error=${input.error}, next_attempt_at=${input.nextAttemptAtMs}, updated_at=${input.nowMs} WHERE delivery_id=${input.deliveryId}`.pipe(
						Effect.asVoid,
					),
				),
		});
	}),
);
