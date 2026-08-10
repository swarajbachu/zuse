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
		providerEndpointDomain: text("provider_endpoint_domain"),
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
			sql`${table.kind} IN ('persistent-machine', 'usage-credits')`,
		),
		check(
			"relay_entitlements_status_check",
			sql`${table.status} IN ('pending', 'active', 'grace', 'ended')`,
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
