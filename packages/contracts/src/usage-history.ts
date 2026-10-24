import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { CloudWorkspaceOpError } from "./cloud-workspaces.ts";
import { UsageSourceId } from "./usage.ts";

const Count = Schema.Number.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const EpochMs = Schema.Number.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }),
);
/** Keyed hash of a session or project identifier; empty when the source has none. */
const OpaqueKey = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{32})?$/u));

/**
 * One hour of usage for a source, model, session, and project. Session and
 * project identifiers are HMAC-hashed with the account key before upload, so
 * the backup never contains chats, paths, or raw session ids.
 */
export const UsageHistoryRow = Schema.Struct({
	hour: Schema.String.check(
		Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/u),
	),
	sourceId: UsageSourceId,
	model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
	session: OpaqueKey,
	project: OpaqueKey,
	inputTokens: Count,
	outputTokens: Count,
	cacheReadTokens: Count,
	cacheCreationTokens: Count,
	reasoningTokens: Count,
	costUsd: Schema.NullOr(
		Schema.Number.check(
			Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 }),
		),
	),
	recordCount: Count,
	firstAt: EpochMs,
	lastAt: EpochMs,
});
export type UsageHistoryRow = typeof UsageHistoryRow.Type;

export const USAGE_HISTORY_MAX_ROWS = 2_000;

export const UsageHistoryUpload = Schema.Struct({
	rows: Schema.Array(UsageHistoryRow).check(
		Schema.isMaxLength(USAGE_HISTORY_MAX_ROWS),
	),
});
export type UsageHistoryUpload = typeof UsageHistoryUpload.Type;

export const UsageHistoryPage = Schema.Struct({
	rows: Schema.Array(UsageHistoryRow),
	/** Opaque cursor for the next page; null when complete. */
	nextCursor: Schema.NullOr(Schema.String),
});
export type UsageHistoryPage = typeof UsageHistoryPage.Type;

/** Per-account HMAC key so every device hashes the same session to the same key. */
export const UsageHistoryKey = Schema.Struct({
	key: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});
export type UsageHistoryKey = typeof UsageHistoryKey.Type;

/** Desktop-side backup state for the signed-in account. */
export const UsageBackupState = Schema.Struct({
	enabled: Schema.Boolean,
	lastSyncedAt: Schema.NullOr(Schema.Number),
	lastError: Schema.NullOr(Schema.String),
});
export type UsageBackupState = typeof UsageBackupState.Type;

export const UsageBackupGetRpc = Rpc.make("usage.backup.get", {
	success: UsageBackupState,
	error: CloudWorkspaceOpError,
});
/** Enabling syncs immediately; disabling with `deleteRemote` erases the account copy. */
export const UsageBackupSetRpc = Rpc.make("usage.backup.set", {
	payload: Schema.Struct({
		enabled: Schema.Boolean,
		deleteRemote: Schema.optional(Schema.Boolean),
	}),
	success: UsageBackupState,
	error: CloudWorkspaceOpError,
});

export const UsageHistoryAccepted = Schema.Struct({ accepted: Count });
export type UsageHistoryAccepted = typeof UsageHistoryAccepted.Type;

/**
 * Account-level backup switch. Devices that opted in stop when it turns off,
 * and personal cloud workspaces upload only while it is on.
 */
export const UsageHistorySettings = Schema.Struct({ enabled: Schema.Boolean });
export type UsageHistorySettings = typeof UsageHistorySettings.Type;

/** Hash key for a cloud workspace runtime; null while the owner's backup is off. */
export const UsageHistoryRuntimeKey = Schema.Struct({
	key: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
});
export type UsageHistoryRuntimeKey = typeof UsageHistoryRuntimeKey.Type;
