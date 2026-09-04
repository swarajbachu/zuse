import { Schema } from "effect";

import { AgentSessionId, CommandId } from "./ids.ts";

export const CLOUD_COMMAND_PROTOCOL_VERSION = 3 as const;
export const CLOUD_COMMAND_MAX_ENVELOPE_BYTES = 256 * 1024;
export const CLOUD_COMMAND_MAX_NONTERMINAL = 256;
export const CLOUD_COMMAND_MAX_MAILBOX_BYTES = 8 * 1024 * 1024;
export const CLOUD_COMMAND_WATCH_MAX_CHANGES = 100;
export const CLOUD_COMMAND_WATCH_MAX_WAIT_MS = 25_000;
export const CLOUD_COMMAND_LEASE_TTL_MS = 30_000;

export const CloudCommandState = Schema.Literals([
	"reserved",
	"accepted",
	"waiting-for-runtime",
	"leased",
	"lease-expired-awaiting-fence",
	"blocked",
	"applied",
	"rejected",
	"expired",
	"cancelled",
	"outcome-unknown",
]);
export type CloudCommandState = typeof CloudCommandState.Type;

export const CLOUD_COMMAND_TERMINAL_STATES = [
	"applied",
	"rejected",
	"expired",
	"cancelled",
	"outcome-unknown",
] as const;

export const CloudCommandTerminalState = Schema.Literals(
	CLOUD_COMMAND_TERMINAL_STATES,
);
export type CloudCommandTerminalState = typeof CloudCommandTerminalState.Type;

export const isCloudCommandTerminalState = (
	state: unknown,
): state is CloudCommandTerminalState =>
	typeof state === "string" &&
	(CLOUD_COMMAND_TERMINAL_STATES as readonly string[]).includes(state);

export const isCloudCommandFailureState = (
	state: CloudCommandState,
): state is Exclude<CloudCommandTerminalState, "applied"> =>
	state === "rejected" ||
	state === "expired" ||
	state === "cancelled" ||
	state === "outcome-unknown";

export const CloudCommandBlockedReason = Schema.Literals([
	"auth-restored",
	"billing-restored",
	"runtime-compatible",
	"workspace-unpaused",
	"manual-retry",
]);
export type CloudCommandBlockedReason = typeof CloudCommandBlockedReason.Type;

export class CloudCommandDependency extends Schema.Class<CloudCommandDependency>(
	"CloudCommandDependency",
)({
	blobId: Schema.String,
	ciphertextBytes: Schema.Number,
	ciphertextSha256: Schema.String,
	keyVersion: Schema.Number,
	expiresAt: Schema.Number,
}) {}

/** Opaque v3 command. Routing metadata is authenticated as AES-GCM AAD. */
export class CloudCommandEnvelope extends Schema.Class<CloudCommandEnvelope>(
	"CloudCommandEnvelope",
)({
	protocolVersion: Schema.Literal(CLOUD_COMMAND_PROTOCOL_VERSION),
	workspaceId: Schema.String,
	sessionId: AgentSessionId,
	commandId: CommandId,
	kind: Schema.String,
	fingerprint: Schema.String,
	schemaVersion: Schema.Number,
	keyVersion: Schema.Number,
	destructionFence: Schema.Number,
	createdAt: Schema.Number,
	iv: Schema.String,
	ciphertext: Schema.String,
	dependencies: Schema.Array(CloudCommandDependency),
}) {}

export class CommandAcceptance extends Schema.Class<CommandAcceptance>(
	"CommandAcceptance",
)({
	commandId: CommandId,
	workspaceSequence: Schema.Number,
	revision: Schema.Number,
	acceptedAt: Schema.Number,
	state: Schema.Literals(["accepted", "waiting-for-runtime", "blocked"]),
}) {}

export class CommandStatus extends Schema.Class<CommandStatus>("CommandStatus")(
	{
		commandId: CommandId,
		workspaceSequence: Schema.Number,
		revision: Schema.Number,
		/** Keyed command identity. Optional only for additive v2/v3 compatibility. */
		fingerprint: Schema.optional(Schema.String),
		state: CloudCommandState,
		everLeased: Schema.Boolean,
		updatedAt: Schema.Number,
		category: Schema.optional(Schema.String),
		blockedUntil: Schema.optional(CloudCommandBlockedReason),
		resultIv: Schema.optional(Schema.String),
		resultCiphertext: Schema.optional(Schema.String),
	},
) {}

export class CommandChangePage extends Schema.Class<CommandChangePage>(
	"CommandChangePage",
)({
	changes: Schema.Array(CommandStatus),
	nextRevision: Schema.Number,
	resetRequired: Schema.Boolean,
}) {}

export class RuntimeLease extends Schema.Class<RuntimeLease>("RuntimeLease")({
	command: CloudCommandEnvelope,
	workspaceSequence: Schema.Number,
	leaseToken: Schema.String,
	leaseDeadline: Schema.Number,
	runtimeGeneration: Schema.Number,
	/** Immutable compute identity returned to this runtime during bootstrap. */
	providerSandboxId: Schema.String,
	storageIncarnationId: Schema.String,
}) {}

export class RuntimeAcknowledgment extends Schema.Class<RuntimeAcknowledgment>(
	"RuntimeAcknowledgment",
)({
	commandId: CommandId,
	leaseToken: Schema.String,
	fingerprint: Schema.String,
	state: Schema.Literals(["applied", "rejected", "expired", "outcome-unknown"]),
	category: Schema.optional(Schema.String),
	resultIv: Schema.optional(Schema.String),
	resultCiphertext: Schema.optional(Schema.String),
}) {}
