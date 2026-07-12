import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
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
    tunnelHostname: text("tunnel_hostname"),
    // Managed Cloudflare tunnel lifecycle. `tunnel_id`/`dns_record_id` are the
    // Cloudflare resources to tear down on unlink; `tunnel_status` tracks the
    // provisioning state machine (reserved → ready).
    tunnelId: text("tunnel_id"),
    dnsRecordId: text("dns_record_id"),
    tunnelStatus: text("tunnel_status"),
    linkedAt: bigint("linked_at", { mode: "number" }).notNull(),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }),
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
  ],
);

export const relayEnvironmentCredentials = pgTable(
  "relay_environment_credentials",
  {
    credentialId: text("credential_id").primaryKey(),
    environmentId: text("environment_id")
      .notNull()
      .references(() => relayEnvironments.environmentId, { onDelete: "cascade" }),
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
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("relay_devices_account_idx").on(table.accountId),
    check(
      "relay_devices_platform_check",
      sql`${table.platform} IN ('ios', 'android', 'web')`,
    ),
  ],
);

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
    index("relay_agent_activity_env_idx").on(table.environmentId, table.occurredAt),
    check(
      "relay_agent_activity_kind_check",
      sql`${table.kind} IN ('approval-needed', 'question-needed', 'completed', 'error', 'running')`,
    ),
  ],
);
