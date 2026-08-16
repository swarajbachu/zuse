import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	check,
	index,
	jsonb,
	pgTable,
	primaryKey,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const relayLinkChallenges = pgTable(
	"relay_link_challenges",
	{
		challengeId: text("challenge_id").primaryKey(),
		accountId: text("account_id").notNull(),
		challenge: text("challenge").notNull(),
		relayIssuer: text("relay_issuer").notNull(),
		expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
		consumedAt: bigint("consumed_at", { mode: "number" }),
	},
	(table) => [index("relay_link_challenges_account_idx").on(table.accountId)],
);

export const relayEnvironments = pgTable(
	"relay_environments",
	{
		environmentId: text("environment_id").primaryKey(),
		accountId: text("account_id").notNull(),
		orgId: text("org_id"),
		providerKind: text("provider_kind").notNull(),
		label: text("label"),
		environmentPublicKey: text("environment_public_key").notNull(),
		httpBaseUrl: text("http_base_url").notNull(),
		wsBaseUrl: text("ws_base_url").notNull(),
		privateHttpBaseUrl: text("private_http_base_url"),
		privateWsBaseUrl: text("private_ws_base_url"),
		tunnelHostname: text("tunnel_hostname"),
		// Managed Cloudflare tunnel lifecycle. `tunnel_id`/`dns_record_id` are the
		// Cloudflare resources to tear down on unlink; `tunnel_status` tracks the
		// provisioning state machine (reserved → ready).
		tunnelId: text("tunnel_id"),
		dnsRecordId: text("dns_record_id"),
		tunnelStatus: text("tunnel_status"),
		linkedAt: bigint("linked_at", { mode: "number" }).notNull(),
		lastSeenAt: bigint("last_seen_at", { mode: "number" }),
		runtimeVersion: text("runtime_version"),
		wireProtocolVersion: bigint("wire_protocol_version", { mode: "number" }),
		capabilities: jsonb("capabilities"),
		serviceState: text("service_state"),
	},
	(table) => [
		index("relay_environments_account_idx").on(table.accountId),
		check(
			"relay_environments_provider_kind_check",
			sql`${table.providerKind} IN ('desktop', 'ssh', 'cloud')`,
		),
		check(
			"relay_environments_tunnel_status_check",
			sql`${table.tunnelStatus} IS NULL OR ${table.tunnelStatus} IN ('reserved', 'ready')`,
		),
		check(
			"relay_environments_service_state_check",
			sql`${table.serviceState} IS NULL OR ${table.serviceState} IN ('starting', 'healthy', 'degraded', 'stopped', 'updating')`,
		),
	],
);

export const relayEnvironmentCredentials = pgTable(
	"relay_environment_credentials",
	{
		credentialId: text("credential_id").primaryKey(),
		environmentId: text("environment_id")
			.notNull()
			.references(() => relayEnvironments.environmentId, {
				onDelete: "cascade",
			}),
		accountId: text("account_id").notNull(),
		credentialHash: text("credential_hash").notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		revokedAt: bigint("revoked_at", { mode: "number" }),
	},
	(table) => [
		index("relay_environment_credentials_env_idx").on(table.environmentId),
	],
);

export const relayDevices = pgTable(
	"relay_devices",
	{
		deviceId: text("device_id").primaryKey(),
		accountId: text("account_id").notNull(),
		platform: text("platform").notNull(),
		pushToken: text("push_token"),
		dpopJwk: jsonb("dpop_jwk"),
		dpopThumbprint: text("dpop_thumbprint").notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		index("relay_devices_account_idx").on(table.accountId),
		check(
			"relay_devices_platform_check",
			sql`${table.platform} IN ('ios', 'android', 'web', 'desktop')`,
		),
	],
);

export const relayRevokedDpopKeys = pgTable("relay_revoked_dpop_keys", {
	thumbprint: text("thumbprint").primaryKey(),
	revokedAt: bigint("revoked_at", { mode: "number" }).notNull(),
});

export const relayDpopProofs = pgTable(
	"relay_dpop_proofs",
	{
		thumbprint: text("thumbprint").notNull(),
		jti: text("jti").notNull(),
		issuedAt: bigint("issued_at", { mode: "number" }).notNull(),
		expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.thumbprint, table.jti] }),
		index("relay_dpop_proofs_expiry_idx").on(table.expiresAt),
	],
);

export const relayMachines = pgTable(
	"relay_machines",
	{
		machineId: text("machine_id").primaryKey(),
		accountId: text("account_id").notNull(),
		offerId: text("offer_id").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		environmentId: text("environment_id"),
		provider: text("provider").notNull(),
		providerServerId: text("provider_server_id"),
		providerLabel: text("provider_label").notNull(),
		label: text("label"),
		state: text("state").notNull(),
		desiredState: text("desired_state").notNull(),
		statusCode: text("status_code").notNull(),
		bootPhase: text("boot_phase"),
		stableFailureCode: text("stable_failure_code"),
		lastError: text("last_error"),
		entitlementId: text("entitlement_id")
			.notNull()
			.references(() => relayEntitlements.entitlementId),
		enrollmentTokenHash: text("enrollment_token_hash"),
		enrollmentExpiresAt: bigint("enrollment_expires_at", { mode: "number" }),
		enrolledEnvironmentPublicKey: text("enrolled_environment_public_key"),
		finalSnapshotId: text("final_snapshot_id"),
		finalSnapshotDeleteAt: bigint("final_snapshot_delete_at", {
			mode: "number",
		}),
		paidThrough: bigint("paid_through", { mode: "number" }),
		recoveryDeadline: bigint("recovery_deadline", { mode: "number" }),
		accountDeletionRequestedAt: bigint("account_deletion_requested_at", {
			mode: "number",
		}),
		credentialCleanupRequestedAt: bigint("credential_cleanup_requested_at", {
			mode: "number",
		}),
		credentialCleanupDeadline: bigint("credential_cleanup_deadline", {
			mode: "number",
		}),
		credentialCleanupCompletedAt: bigint("credential_cleanup_completed_at", {
			mode: "number",
		}),
		finalSnapshotSkipped: boolean("final_snapshot_skipped")
			.notNull()
			.default(false),
		nextActionAt: bigint("next_action_at", { mode: "number" }).notNull(),
		attemptCount: bigint("attempt_count", { mode: "number" })
			.notNull()
			.default(0),
		leaseOwner: text("lease_owner"),
		leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
		revision: bigint("revision", { mode: "number" }).notNull().default(0),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
		suspendedAt: bigint("suspended_at", { mode: "number" }),
		destroyedAt: bigint("destroyed_at", { mode: "number" }),
	},
	(table) => [
		index("relay_machines_account_idx").on(table.accountId),
		uniqueIndex("relay_machines_account_idempotency_idx").on(
			table.accountId,
			table.idempotencyKey,
		),
		uniqueIndex("relay_machines_enroll_token_idx").on(
			table.enrollmentTokenHash,
		),
		uniqueIndex("relay_machines_environment_idx").on(table.environmentId),
		uniqueIndex("relay_machines_provider_server_idx").on(
			table.provider,
			table.providerServerId,
		),
		index("relay_machines_reconcile_idx").on(
			table.desiredState,
			table.nextActionAt,
			table.leaseExpiresAt,
		),
		check(
			"relay_machines_state_check",
			sql`${table.state} IN ('creating', 'bootstrapping', 'enrolling', 'ready', 'suspending', 'suspended', 'resuming', 'destroying', 'destroyed', 'failed')`,
		),
		check(
			"relay_machines_desired_state_check",
			sql`${table.desiredState} IN ('ready', 'suspended', 'destroyed')`,
		),
	],
);

export const relayEntitlements = pgTable(
	"relay_entitlements",
	{
		entitlementId: text("entitlement_id").primaryKey(),
		accountId: text("account_id").notNull(),
		kind: text("kind").notNull(),
		offerId: text("offer_id"),
		provider: text("provider").notNull(),
		providerSubscriptionId: text("provider_subscription_id"),
		status: text("status").notNull(),
		periodStart: bigint("period_start", { mode: "number" }),
		paidThrough: bigint("paid_through", { mode: "number" }),
		endedAt: bigint("ended_at", { mode: "number" }),
		creditBalance: bigint("credit_balance", { mode: "number" }),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		index("relay_entitlements_account_idx").on(table.accountId),
		index("relay_entitlements_subscription_idx").on(
			table.provider,
			table.providerSubscriptionId,
		),
		check(
			"relay_entitlements_kind_check",
			sql`${table.kind} IN ('persistent-machine', 'cloud-workspace', 'usage-credits')`,
		),
		check(
			"relay_entitlements_status_check",
			sql`${table.status} IN ('pending', 'active', 'grace', 'ended')`,
		),
	],
);

export const relayCloudProjects = pgTable(
	"relay_cloud_projects",
	{
		projectId: text("project_id").primaryKey(),
		accountId: text("account_id").notNull(),
		repositoryIdentity: text("repository_identity").notNull(),
		repositoryUrl: text("repository_url").notNull(),
		displayName: text("display_name").notNull(),
		defaultBranch: text("default_branch").notNull(),
		visibility: text("visibility").notNull(),
		gitConnectionKind: text("git_connection_kind").notNull(),
		cloudEnvironment: jsonb("cloud_environment").notNull().default({}),
		secretBindings: jsonb("secret_bindings").notNull().default([]),
		configurationDigest: text("configuration_digest").notNull(),
		state: text("state").notNull(),
		lastErrorCode: text("last_error_code"),
		idempotencyKey: text("idempotency_key").notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("relay_cloud_projects_account_repo_idx").on(
			table.accountId,
			table.repositoryIdentity,
		),
		uniqueIndex("relay_cloud_projects_account_idempotency_idx").on(
			table.accountId,
			table.idempotencyKey,
		),
		index("relay_cloud_projects_account_idx").on(table.accountId),
		check(
			"relay_cloud_projects_visibility_check",
			sql`${table.visibility} IN ('public', 'private')`,
		),
		check(
			"relay_cloud_projects_state_check",
			sql`${table.state} IN ('connected', 'preparing', 'ready', 'failed')`,
		),
	],
);

export const relayCloudProjectBuilds = pgTable(
	"relay_cloud_project_builds",
	{
		buildId: text("build_id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => relayCloudProjects.projectId, { onDelete: "cascade" }),
		accountId: text("account_id").notNull(),
		provider: text("provider").notNull(),
		providerSandboxId: text("provider_sandbox_id"),
		snapshotId: text("snapshot_id"),
		sourceCommit: text("source_commit"),
		templateVersion: text("template_version").notNull(),
		configurationDigest: text("configuration_digest").notNull(),
		state: text("state").notNull(),
		lastErrorCode: text("last_error_code"),
		idempotencyKey: text("idempotency_key").notNull(),
		nextActionAt: bigint("next_action_at", { mode: "number" }).notNull(),
		leaseOwner: text("lease_owner"),
		leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
		revision: bigint("revision", { mode: "number" }).notNull().default(0),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("relay_cloud_builds_project_provider_idempotency_idx").on(
			table.projectId,
			table.provider,
			table.idempotencyKey,
		),
		index("relay_cloud_builds_active_idx").on(
			table.projectId,
			table.provider,
			table.state,
			table.updatedAt,
		),
		index("relay_cloud_builds_reconcile_idx").on(
			table.state,
			table.nextActionAt,
			table.leaseExpiresAt,
		),
		check(
			"relay_cloud_builds_state_check",
			sql`${table.state} IN ('queued', 'building', 'sanitizing', 'ready', 'failed')`,
		),
	],
);

export const relayCloudWorkspaces = pgTable(
	"relay_cloud_workspaces",
	{
		workspaceId: text("workspace_id").primaryKey(),
		accountId: text("account_id").notNull(),
		projectId: text("project_id")
			.notNull()
			.references(() => relayCloudProjects.projectId),
		buildId: text("build_id")
			.notNull()
			.references(() => relayCloudProjectBuilds.buildId),
		provider: text("provider").notNull(),
		providerSandboxId: text("provider_sandbox_id"),
		runtimeBootTokenHash: text("runtime_boot_token_hash"),
		runtimeBootTokenExpiresAt: bigint("runtime_boot_token_expires_at", {
			mode: "number",
		}),
		runtimeCredentialHash: text("runtime_credential_hash"),
		runtimeState: text("runtime_state").notNull().default("offline"),
		chatId: text("chat_id").notNull(),
		initialSessionId: text("initial_session_id").notNull(),
		branch: text("branch").notNull(),
		baseRef: text("base_ref").notNull(),
		state: text("state").notNull(),
		desiredState: text("desired_state").notNull(),
		statusCode: text("status_code").notNull(),
		credentialEpoch: bigint("credential_epoch", { mode: "number" })
			.notNull()
			.default(0),
		wrappedTranscriptKey: text("wrapped_transcript_key"),
		archiveRequestedAt: bigint("archive_requested_at", { mode: "number" }),
		archiveDeleteAt: bigint("archive_delete_at", { mode: "number" }),
		deletionTombstoneExpiresAt: bigint("deletion_tombstone_expires_at", {
			mode: "number",
		}),
		idempotencyKey: text("idempotency_key").notNull(),
		requestConfig: jsonb("request_config").notNull().default({}),
		nextActionAt: bigint("next_action_at", { mode: "number" }).notNull(),
		leaseOwner: text("lease_owner"),
		leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
		revision: bigint("revision", { mode: "number" }).notNull().default(0),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
		lastActivityAt: bigint("last_activity_at", { mode: "number" }).notNull(),
		runningSince: bigint("running_since", { mode: "number" }),
		deletedAt: bigint("deleted_at", { mode: "number" }),
	},
	(table) => [
		uniqueIndex("relay_cloud_workspaces_account_idempotency_idx").on(
			table.accountId,
			table.idempotencyKey,
		),
		uniqueIndex("relay_cloud_workspaces_provider_sandbox_idx").on(
			table.provider,
			table.providerSandboxId,
		),
		uniqueIndex("relay_cloud_workspaces_chat_idx").on(table.chatId),
		index("relay_cloud_workspaces_project_idx").on(
			table.projectId,
			table.updatedAt,
		),
		index("relay_cloud_workspaces_branch_lease_idx").on(
			table.projectId,
			table.branch,
			table.state,
		),
		uniqueIndex("relay_cloud_workspaces_active_branch_idx")
			.on(table.projectId, table.branch)
			.where(sql`${table.state} <> 'deleted'`),
		index("relay_cloud_workspaces_reconcile_idx").on(
			table.desiredState,
			table.nextActionAt,
			table.leaseExpiresAt,
		),
		check(
			"relay_cloud_workspaces_state_check",
			sql`${table.state} IN ('queued', 'provisioning', 'setup', 'ready', 'pausing', 'paused', 'resuming', 'archiving', 'archived', 'deleting', 'deleted', 'failed')`,
		),
		check(
			"relay_cloud_workspaces_desired_state_check",
			sql`${table.desiredState} IN ('ready', 'paused', 'archived', 'deleted')`,
		),
		check(
			"relay_cloud_workspaces_runtime_state_check",
			sql`${table.runtimeState} IN ('offline', 'connecting', 'online')`,
		),
	],
);

export const relayCloudWorkspaceCommandReceipts = pgTable(
	"relay_cloud_workspace_command_receipts",
	{
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => relayCloudWorkspaces.workspaceId, {
				onDelete: "cascade",
			}),
		commandId: text("command_id").notNull(),
		action: text("action").notNull(),
		workspaceRevision: bigint("workspace_revision", {
			mode: "number",
		}).notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.workspaceId, table.commandId] })],
);

export const relayCloudWorkspaceLaunchIntents = pgTable(
	"relay_cloud_workspace_launch_intents",
	{
		workspaceId: text("workspace_id")
			.primaryKey()
			.notNull()
			.references(() => relayCloudWorkspaces.workspaceId, {
				onDelete: "cascade",
			}),
		accountId: text("account_id").notNull(),
		chatId: text("chat_id").notNull(),
		sessionId: text("session_id").notNull(),
		turnId: text("turn_id").notNull(),
		commandId: text("command_id").notNull().unique(),
		ciphertext: text("ciphertext").notNull(),
		expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		index("relay_cloud_workspace_launch_intents_expiry_idx").on(
			table.expiresAt,
		),
	],
);

/**
 * Monotonic metadata-only projection published by the authoritative runtime.
 * Transcript content remains exclusively in runtime SQLite.
 */
export const relayCloudWorkspaceRuntimeSummaries = pgTable(
	"relay_cloud_workspace_runtime_summaries",
	{
		workspaceId: text("workspace_id")
			.primaryKey()
			.notNull()
			.references(() => relayCloudWorkspaces.workspaceId, {
				onDelete: "cascade",
			}),
		runtimeGeneration: bigint("runtime_generation", {
			mode: "number",
		}).notNull(),
		summaryRevision: bigint("summary_revision", { mode: "number" }).notNull(),
		title: text("title").notNull(),
		lastActivityAt: bigint("last_activity_at", { mode: "number" }).notNull(),
		sessionHeadVersion: bigint("session_head_version", {
			mode: "number",
		}).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		index("relay_cloud_runtime_summaries_activity_idx").on(
			table.lastActivityAt,
		),
	],
);

/** Opaque R2 pointer for the latest encrypted runtime transcript projection. */
export const relayCloudTranscriptCheckpoints = pgTable(
	"relay_cloud_transcript_checkpoints",
	{
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => relayCloudWorkspaces.workspaceId, {
				onDelete: "cascade",
			}),
		sessionId: text("session_id").notNull(),
		runtimeGeneration: bigint("runtime_generation", {
			mode: "number",
		}).notNull(),
		streamEpoch: text("stream_epoch").notNull(),
		streamVersion: bigint("stream_version", { mode: "number" }).notNull(),
		objectKey: text("object_key").notNull(),
		ciphertextSha256: text("ciphertext_sha256").notNull(),
		ciphertextBytes: bigint("ciphertext_bytes", { mode: "number" }).notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.workspaceId, table.sessionId] }),
		index("relay_cloud_transcript_checkpoint_created_idx").on(table.createdAt),
	],
);

export const relayCloudCredentialConnections = pgTable(
	"relay_cloud_credential_connections",
	{
		connectionId: text("connection_id").primaryKey(),
		accountId: text("account_id").notNull(),
		kind: text("kind").notNull(),
		state: text("state").notNull(),
		accountLabel: text("account_label"),
		encryptedPayload: text("encrypted_payload"),
		encryptionKeyVersion: text("encryption_key_version"),
		credentialVersion: bigint("credential_version", { mode: "number" })
			.notNull()
			.default(1),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
		disconnectedAt: bigint("disconnected_at", { mode: "number" }),
	},
	(table) => [
		uniqueIndex("relay_cloud_credentials_account_kind_idx").on(
			table.accountId,
			table.kind,
		),
		check(
			"relay_cloud_credentials_kind_check",
			sql`${table.kind} IN ('github', 'claude', 'codex')`,
		),
		check(
			"relay_cloud_credentials_state_check",
			sql`${table.state} IN ('connected', 'disconnected', 'error')`,
		),
	],
);

export const relayCloudWorkspaceUsage = pgTable(
	"relay_cloud_workspace_usage",
	{
		eventId: text("event_id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => relayCloudWorkspaces.workspaceId),
		accountId: text("account_id").notNull(),
		provider: text("provider").notNull(),
		kind: text("kind").notNull(),
		quantity: bigint("quantity", { mode: "number" }).notNull(),
		providerEventId: text("provider_event_id"),
		occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("relay_cloud_usage_provider_event_idx").on(
			table.provider,
			table.providerEventId,
		),
		index("relay_cloud_usage_workspace_idx").on(
			table.workspaceId,
			table.occurredAt,
		),
		check(
			"relay_cloud_usage_kind_check",
			sql`${table.kind} IN ('runtime-seconds', 'pause', 'resume', 'snapshot-bytes', 'storage-byte-seconds', 'archive', 'restore', 'delete')`,
		),
	],
);

export const relayCloudBillingPeriods = pgTable(
	"relay_cloud_billing_periods",
	{
		periodId: text("period_id").primaryKey(),
		accountId: text("account_id").notNull(),
		providerSubscriptionId: text("provider_subscription_id"),
		status: text("status").notNull(),
		currency: text("currency").notNull().default("USD"),
		periodStart: bigint("period_start", { mode: "number" }).notNull(),
		periodEnd: bigint("period_end", { mode: "number" }).notNull(),
		basePriceMicros: bigint("base_price_micros", { mode: "number" }).notNull(),
		includedProviderCostMicros: bigint("included_provider_cost_micros", {
			mode: "number",
		}).notNull(),
		markupBasisPoints: bigint("markup_basis_points", {
			mode: "number",
		}).notNull(),
		priceCatalogVersion: text("price_catalog_version").notNull(),
		overageCapMicros: bigint("overage_cap_micros", {
			mode: "number",
		}).notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("relay_cloud_billing_period_account_start_idx").on(
			table.accountId,
			table.periodStart,
		),
		index("relay_cloud_billing_period_active_idx").on(
			table.accountId,
			table.periodEnd,
		),
	],
);

export const relayProviderPriceSchedule = pgTable(
	"relay_provider_price_schedule",
	{
		provider: text("provider").notNull(),
		version: text("version").notNull(),
		effectiveAt: bigint("effective_at", { mode: "number" }).notNull(),
		cpuNanoUsdPerSecond: bigint("cpu_nano_usd_per_second", {
			mode: "number",
		}).notNull(),
		memoryNanoUsdPerGibSecond: bigint("memory_nano_usd_per_gib_second", {
			mode: "number",
		}).notNull(),
		storageNanoUsdPerGibSecond: bigint("storage_nano_usd_per_gib_second", {
			mode: "number",
		})
			.notNull()
			.default(0),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.provider, table.version] }),
		index("relay_provider_price_schedule_effective_idx").on(
			table.provider,
			table.effectiveAt,
		),
	],
);

export const relayProviderUsageEvents = pgTable(
	"relay_provider_usage_events",
	{
		eventId: text("event_id").notNull(),
		provider: text("provider").notNull(),
		type: text("type").notNull(),
		providerResourceId: text("provider_resource_id"),
		payload: jsonb("payload").notNull(),
		receivedAt: bigint("received_at", { mode: "number" }).notNull(),
		expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.provider, table.eventId] }),
		index("relay_provider_usage_events_expiry_idx").on(table.expiresAt),
	],
);

export const relayProviderEventDeliveries = pgTable(
	"relay_provider_event_deliveries",
	{
		provider: text("provider").notNull(),
		deliveryId: text("delivery_id").notNull(),
		eventId: text("event_id").notNull(),
		source: text("source").notNull(),
		status: text("status").notNull(),
		receivedAt: bigint("received_at", { mode: "number" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.provider, table.deliveryId] }),
		index("relay_provider_event_deliveries_event_idx").on(
			table.provider,
			table.eventId,
		),
	],
);

export const relayCloudBillingUsage = pgTable(
	"relay_cloud_billing_usage",
	{
		entryId: text("entry_id").primaryKey(),
		periodId: text("period_id").notNull(),
		accountId: text("account_id").notNull(),
		resourceKind: text("resource_kind").notNull(),
		resourceId: text("resource_id").notNull(),
		provider: text("provider").notNull(),
		providerEventId: text("provider_event_id"),
		providerExecutionId: text("provider_execution_id"),
		startedAt: bigint("started_at", { mode: "number" }).notNull(),
		endedAt: bigint("ended_at", { mode: "number" }).notNull(),
		vcpuCount: bigint("vcpu_count", { mode: "number" }).notNull(),
		memoryMib: bigint("memory_mib", { mode: "number" }).notNull(),
		providerCostMicros: bigint("provider_cost_micros", {
			mode: "number",
		}).notNull(),
		status: text("status").notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("relay_cloud_billing_usage_provider_event_idx").on(
			table.provider,
			table.providerEventId,
		),
		index("relay_cloud_billing_usage_period_idx").on(
			table.periodId,
			table.startedAt,
		),
	],
);

export const relayCloudBillingReservations = pgTable(
	"relay_cloud_billing_reservations",
	{
		periodId: text("period_id").notNull(),
		accountId: text("account_id").notNull(),
		resourceKind: text("resource_kind").notNull(),
		resourceId: text("resource_id").notNull(),
		providerCostMicros: bigint("provider_cost_micros", {
			mode: "number",
		}).notNull(),
		startedAt: bigint("started_at", { mode: "number" }).notNull(),
		vcpuCount: bigint("vcpu_count", { mode: "number" }).notNull(),
		memoryMib: bigint("memory_mib", { mode: "number" }).notNull(),
		expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
		updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.periodId, table.resourceKind, table.resourceId],
		}),
		index("relay_cloud_billing_reservations_expiry_idx").on(table.expiresAt),
	],
);

export const relayCloudBillingLedger = pgTable(
	"relay_cloud_billing_ledger",
	{
		entryId: text("entry_id").primaryKey(),
		periodId: text("period_id").notNull(),
		accountId: text("account_id").notNull(),
		kind: text("kind").notNull(),
		amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
		sourceId: text("source_id").notNull(),
		metadata: jsonb("metadata").notNull().default({}),
		occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("relay_cloud_billing_ledger_source_idx").on(
			table.kind,
			table.sourceId,
		),
		index("relay_cloud_billing_ledger_period_idx").on(
			table.periodId,
			table.occurredAt,
		),
	],
);

export const relayCloudBillingCapCommands = pgTable(
	"relay_cloud_billing_cap_commands",
	{
		periodId: text("period_id").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		overageCapMicros: bigint("overage_cap_micros", {
			mode: "number",
		}).notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.periodId, table.idempotencyKey] })],
);

export const relayCloudBillingOutbox = pgTable(
	"relay_cloud_billing_outbox",
	{
		outboxId: text("outbox_id").primaryKey(),
		periodId: text("period_id").notNull(),
		accountId: text("account_id").notNull(),
		provider: text("provider").notNull(),
		amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		attemptCount: bigint("attempt_count", { mode: "number" })
			.notNull()
			.default(0),
		nextAttemptAt: bigint("next_attempt_at", { mode: "number" }).notNull(),
		acknowledgedAt: bigint("acknowledged_at", { mode: "number" }),
		lastError: text("last_error"),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("relay_cloud_billing_outbox_idempotency_idx").on(
			table.provider,
			table.idempotencyKey,
		),
	],
);

export const relayCloudBillingMeterReconciliations = pgTable(
	"relay_cloud_billing_meter_reconciliations",
	{
		reconciliationId: text("reconciliation_id").primaryKey(),
		periodId: text("period_id").notNull(),
		provider: text("provider").notNull(),
		expectedUnits: bigint("expected_units", { mode: "number" }).notNull(),
		observedUnits: bigint("observed_units", { mode: "number" }).notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		index("relay_cloud_billing_meter_reconciliation_period_idx").on(
			table.periodId,
			table.createdAt,
		),
	],
);

export const relayPlatformCosts = pgTable(
	"relay_platform_costs",
	{
		costId: text("cost_id").primaryKey(),
		vendor: text("vendor").notNull(),
		kind: text("kind").notNull(),
		amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
		currency: text("currency").notNull().default("USD"),
		externalId: text("external_id"),
		periodStart: bigint("period_start", { mode: "number" }).notNull(),
		periodEnd: bigint("period_end", { mode: "number" }).notNull(),
		metadata: jsonb("metadata").notNull().default({}),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("relay_platform_cost_vendor_external_idx").on(
			table.vendor,
			table.externalId,
		),
	],
);

export const relayProviderStatementTotals = pgTable(
	"relay_provider_statement_totals",
	{
		statementId: text("statement_id").primaryKey(),
		provider: text("provider").notNull(),
		externalId: text("external_id").notNull(),
		amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
		currency: text("currency").notNull().default("USD"),
		periodStart: bigint("period_start", { mode: "number" }).notNull(),
		periodEnd: bigint("period_end", { mode: "number" }).notNull(),
		metadata: jsonb("metadata").notNull().default({}),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("relay_provider_statement_external_idx").on(
			table.provider,
			table.externalId,
		),
	],
);

// Webhook idempotency ledger: one row per billing-provider event id, so a
// redelivered webhook is a no-op.
export const relayBillingEvents = pgTable(
	"relay_billing_events",
	{
		eventId: text("event_id").notNull(),
		provider: text("provider").notNull(),
		payload: jsonb("payload"),
		receivedAt: bigint("received_at", { mode: "number" }).notNull(),
		processedAt: bigint("processed_at", { mode: "number" }),
	},
	(table) => [primaryKey({ columns: [table.provider, table.eventId] })],
);

export const relayAgentActivity = pgTable(
	"relay_agent_activity",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		environmentId: text("environment_id").notNull(),
		accountId: text("account_id").notNull(),
		sessionId: text("session_id").notNull(),
		kind: text("kind").notNull(),
		title: text("title"),
		occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
	},
	(table) => [
		index("relay_agent_activity_env_idx").on(
			table.environmentId,
			table.occurredAt,
		),
		check(
			"relay_agent_activity_kind_check",
			sql`${table.kind} IN ('approval-needed', 'question-needed', 'completed', 'error', 'running')`,
		),
	],
);
