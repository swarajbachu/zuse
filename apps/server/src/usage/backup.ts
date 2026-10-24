import { join } from "node:path";
import {
	ApiPaths,
	USAGE_HISTORY_MAX_ROWS,
	type UsageBackupState,
	UsageHistoryAccepted,
	type UsageHistoryPage,
	type UsageHistoryRow,
	UsageHistoryRuntimeKey,
	type UsageProfileSnapshot,
} from "@zuse/contracts";
import { validUsageHistoryRow } from "@zuse/utils/usage-history";
import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { PricedUsage } from "tokenmaxer";
import { AppPaths } from "../app-paths.ts";
import { AuthService } from "../auth/services/auth-service.ts";
import {
	MachineControlError,
	MachineControlService,
} from "../machine/machine-control-service.ts";
import { RequestWorkspace } from "../machine/request-workspace.ts";
import { RuntimeCloudControl } from "../machine/runtime-cloud-control.ts";
import { sqliteDbPath } from "../persistence/db-path.ts";
import {
	type HistoryRow,
	opaqueKey,
	persistUsageHistory,
	readDailyHistory,
	readRemoteHistory,
	readUsageHistory,
} from "./history.ts";
import { loadPricedUsageCached } from "./report-cache.ts";

/**
 * Opt-in account backup of hourly usage history. Rows leave the machine with
 * session and project ids replaced by keyed hashes; the API merges uploads
 * monotonically, so retries and multiple devices are safe. A sync runs at
 * most every three days from the usage poller, and immediately on enable.
 */
export const USAGE_BACKUP_INTERVAL_MS = 3 * 24 * 60 * 60 * 1_000;
/** Cloud workspaces are short-lived; upload hourly to bound loss on deletion. */
export const CLOUD_USAGE_UPLOAD_INTERVAL_MS = 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

const Key = {
	account: "account",
	secret: "secret",
	uploadedThrough: "uploaded_through",
	legacyUploaded: "legacy_uploaded",
	syncedAt: "synced_at",
	cloudSyncedAt: "cloud_synced_at",
	error: "last_error",
	/** Account and key the cached `usage_history_remote` rows belong to. */
	remoteAccount: "remote_account",
	remoteSecret: "remote_secret",
} as const;
type StateKey = (typeof Key)[keyof typeof Key];

const readState = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const rows = yield* sql<{
		key: StateKey;
		value: string;
	}>`SELECT key, value FROM usage_backup_state`;
	return new Map(rows.map((row) => [row.key, row.value]));
});

const writeState = (entries: Partial<Record<StateKey, string | null>>) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql.withTransaction(
			Effect.forEach(
				Object.entries(entries),
				([key, value]) =>
					value === null || value === undefined
						? sql`DELETE FROM usage_backup_state WHERE key = ${key}`
						: sql`INSERT INTO usage_backup_state(key, value) VALUES (${key}, ${value}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
				{ discard: true },
			),
		);
	});

const currentSubject = Effect.gen(function* () {
	const auth = yield* AuthService;
	const session = yield* auth.getSession();
	return session._tag === "SignedIn" ? session.session.user.id : null;
}).pipe(Effect.catch(() => Effect.succeed(null)));

const activeAccount = (state: Map<StateKey, string>) =>
	Effect.map(currentSubject, (subject) =>
		subject !== null && state.get(Key.account) === subject ? subject : null,
	);

export const usageBackupState: Effect.Effect<
	UsageBackupState,
	never,
	SqlClient.SqlClient | AuthService
> = Effect.gen(function* () {
	const state = yield* readState.pipe(Effect.orDie);
	const syncedAt = Number(state.get(Key.syncedAt));
	return {
		enabled: (yield* activeAccount(state)) !== null,
		lastSyncedAt: Number.isFinite(syncedAt) ? syncedAt : null,
		lastError: state.get(Key.error) ?? null,
	};
});

/**
 * Other devices' rows for the profile. Only returned while backup is on for
 * the signed-in account and the cache was downloaded for that same account,
 * so a failed download after an account switch never exposes old rows.
 */
export const remoteHistoryForProfile = Effect.gen(function* () {
	const state = yield* readState;
	const secret = state.get(Key.remoteSecret);
	const subject = yield* activeAccount(state);
	if (!secret || subject === null || state.get(Key.remoteAccount) !== subject)
		return null;
	return { secret, rows: yield* readRemoteHistory };
});

const toUploadRow =
	(secret: string) =>
	(row: HistoryRow): UsageHistoryRow => ({
		hour: row.hour,
		sourceId: row.source_id,
		model: row.model.slice(0, 100) || "unknown",
		session: opaqueKey(secret, row.session),
		project: opaqueKey(secret, row.project),
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		cacheReadTokens: row.cache_read_tokens,
		cacheCreationTokens: row.cache_creation_tokens,
		reasoningTokens: row.reasoning_tokens,
		costUsd: row.cost_usd,
		recordCount: Math.max(1, row.record_count),
		firstAt: row.first_at,
		lastAt: Math.min(
			Math.max(row.last_at, row.first_at),
			row.first_at + WEEK_MS - 1,
		),
	});

const fromUploadRow = (row: UsageHistoryRow): HistoryRow => ({
	hour: row.hour,
	source_id: row.sourceId,
	model: row.model,
	session: row.session,
	project: row.project,
	input_tokens: row.inputTokens,
	output_tokens: row.outputTokens,
	cache_read_tokens: row.cacheReadTokens,
	cache_creation_tokens: row.cacheCreationTokens,
	reasoning_tokens: row.reasoningTokens,
	cost_usd: row.costUsd,
	record_count: row.recordCount,
	first_at: row.firstAt,
	last_at: row.lastAt,
});

/** Hash collisions are astronomically unlikely, but the API rejects duplicate keys. */
const uniqueByKey = (rows: ReadonlyArray<UsageHistoryRow>) => [
	...new Map(
		rows.map((row) => [
			[row.hour, row.sourceId, row.model, row.session, row.project].join("\0"),
			row,
		]),
	).values(),
];

/** Legacy daily rows for days with no hourly history, uploaded once. */
const legacyRows = Effect.gen(function* () {
	const history = yield* readUsageHistory();
	const covered = new Set(
		history.map(
			(row) => `${row.hour.slice(0, 10)}\0${row.source_id}\0${row.model}`,
		),
	);
	return (yield* readDailyHistory)
		.filter((row) => !covered.has(`${row.day}\0${row.source_id}\0${row.model}`))
		.map(
			(row): HistoryRow => ({
				...row,
				hour: `${row.day}T00:00:00.000Z`,
				session: "",
				project: "",
				first_at: Date.parse(`${row.day}T00:00:00.000Z`),
				last_at: Date.parse(`${row.day}T23:59:59.999Z`),
			}),
		);
});

type LoadPriced = () => Promise<PricedUsage>;

/** Folds the latest tool logs into durable hourly history before uploading. */
const persistLatest = (loadPriced: LoadPriced | undefined) =>
	Effect.gen(function* () {
		const paths = yield* AppPaths;
		const priced = yield* Effect.tryPromise(
			() =>
				loadPriced?.() ??
				loadPricedUsageCached(
					sqliteDbPath(paths.userData),
					join(paths.userData, "tokenmaxer"),
				),
		);
		yield* persistUsageHistory(priced);
	});

/**
 * Uploads rows changed since the last successful upload. A new account key
 * (the copy was deleted) restarts from the beginning, so nothing is stranded
 * under an old hash. Progress is recorded only after every batch succeeds.
 */
const uploadChangedHistory = <E, R>(
	secret: string,
	send: (rows: ReadonlyArray<UsageHistoryRow>) => Effect.Effect<unknown, E, R>,
) =>
	Effect.gen(function* () {
		const state = yield* readState;
		const fresh = state.get(Key.secret) !== secret;
		const previous = fresh ? null : (state.get(Key.uploadedThrough) ?? null);
		const through = Number(previous ?? -1);
		const changed = yield* readUsageHistory(
			Number.isFinite(through) ? through : -1,
		);
		const legacy =
			!fresh && state.get(Key.legacyUploaded) === "1" ? [] : yield* legacyRows;
		const now = yield* Clock.currentTimeMillis;
		const rows = [...legacy, ...changed].map(toUploadRow(secret));
		const upload = uniqueByKey(
			rows.filter((row) => validUsageHistoryRow(row, now)),
		);
		if (upload.length < rows.length)
			yield* Effect.logWarning(
				`[usage] skipped ${rows.length - upload.length} history rows the backup API would reject`,
			);
		for (let index = 0; index < upload.length; index += USAGE_HISTORY_MAX_ROWS)
			yield* send(upload.slice(index, index + USAGE_HISTORY_MAX_ROWS));
		const newest = changed.at(-1)?.change_seq;
		yield* writeState({
			[Key.secret]: secret,
			[Key.legacyUploaded]: "1",
			[Key.uploadedThrough]: newest === undefined ? previous : String(newest),
		});
	});

type BuildSnapshot<E, R> = (
	timeZone: string,
) => Effect.Effect<UsageProfileSnapshot, E, R>;

const runSync = <E, R>(
	subject: string,
	buildSnapshot: BuildSnapshot<E, R>,
	loadPriced: LoadPriced | undefined,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const control = yield* MachineControlService;
		// Every request goes to the signed-in account; stop if it changes mid-sync.
		const ensureAccount = Effect.gen(function* () {
			if ((yield* currentSubject) !== subject)
				return yield* Effect.fail(new MachineControlError("not-allowed"));
		});

		yield* persistLatest(loadPriced);

		// Turning backup off on any device turns it off for every device.
		yield* ensureAccount;
		if (!(yield* control.usageHistorySettings()).enabled) {
			yield* writeState({ [Key.account]: null });
			return;
		}
		const { key: secret } = yield* control.usageHistoryKey();
		yield* uploadChangedHistory(secret, (rows) =>
			ensureAccount.pipe(Effect.andThen(control.uploadUsageHistory(rows))),
		);

		const remote: HistoryRow[] = [];
		let cursor: string | null = null;
		do {
			yield* ensureAccount;
			const page: UsageHistoryPage = yield* control.usageHistoryPage(cursor);
			for (const row of page.rows) remote.push(fromUploadRow(row));
			cursor = page.nextCursor;
		} while (cursor !== null);
		// Rows and the account they belong to are replaced together.
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* writeState({
					[Key.remoteAccount]: subject,
					[Key.remoteSecret]: secret,
				});
				yield* sql`DELETE FROM usage_history_remote`;
				yield* Effect.forEach(
					remote,
					(row) =>
						sql`INSERT OR REPLACE INTO usage_history_remote(hour, source_id, model, session, project, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, cost_usd, record_count, first_at, last_at) VALUES (${row.hour}, ${row.source_id}, ${row.model}, ${row.session}, ${row.project}, ${row.input_tokens}, ${row.output_tokens}, ${row.cache_read_tokens}, ${row.cache_creation_tokens}, ${row.reasoning_tokens}, ${row.cost_usd}, ${row.record_count}, ${row.first_at}, ${row.last_at})`,
					{ discard: true },
				);
			}),
		);

		const now = yield* Clock.currentTimeMillis;
		yield* writeState({ [Key.syncedAt]: String(now), [Key.error]: null });

		// Keep a published profile current, preserving the owner's opt-ins. The
		// save is conditional on the revision read here, so an unpublish or
		// privacy change made meanwhile wins and this refresh is dropped.
		yield* ensureAccount;
		const profileState = yield* control.getUsageProfile();
		const profile = profileState.profile;
		if (!profileState.published || profile === null) return;
		const snapshot = yield* buildSnapshot(
			Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
		);
		yield* ensureAccount;
		yield* control
			.refreshUsageProfile(
				{
					handle: profile.handle,
					displayName: profile.displayName,
					github: profile.github,
					...snapshot,
					cost: profile.cost === null ? null : snapshot.cost,
					hours: profile.hours === null ? null : snapshot.hours,
				},
				profile.updatedAt,
			)
			.pipe(
				Effect.catch((error) =>
					Effect.logInfo(`[usage] skipped profile refresh: ${error.code}`),
				),
			);
	}).pipe(Effect.provideService(RequestWorkspace, "personal"));

const describe = (cause: unknown) =>
	cause instanceof MachineControlError
		? cause.code
		: cause instanceof Error
			? cause.message
			: "sync-failed";

/** Syncs when backup is on for the signed-in account and the interval has passed. */
export const syncUsageBackup = <E, R>(options: {
	readonly force: boolean;
	readonly buildSnapshot: BuildSnapshot<E, R>;
	/** Test seam; defaults to the shared priced-usage cache. */
	readonly loadPriced?: LoadPriced;
}) =>
	Effect.gen(function* () {
		const state = yield* readState;
		const subject = yield* activeAccount(state);
		if (subject === null) return;
		const syncedAt = Number(state.get(Key.syncedAt));
		const now = yield* Clock.currentTimeMillis;
		if (
			!options.force &&
			Number.isFinite(syncedAt) &&
			now - syncedAt < USAGE_BACKUP_INTERVAL_MS
		)
			return;
		yield* runSync(subject, options.buildSnapshot, options.loadPriced).pipe(
			Effect.catchCause((cause) =>
				Effect.gen(function* () {
					const error = cause.reasons
						.map((reason) =>
							"error" in reason ? describe(reason.error) : "sync-failed",
						)
						.at(0);
					yield* writeState({ [Key.error]: error ?? "sync-failed" });
					yield* Effect.logWarning(
						`[usage] backup sync failed: ${String(cause)}`,
					);
				}),
			),
		);
	});

export const setUsageBackup = <E, R>(
	input: { readonly enabled: boolean; readonly deleteRemote?: boolean },
	buildSnapshot: BuildSnapshot<E, R>,
	loadPriced?: LoadPriced,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const subject = yield* currentSubject;
		if (subject === null)
			return yield* Effect.fail(new MachineControlError("not-allowed"));
		const reset = {
			[Key.secret]: null,
			[Key.remoteAccount]: null,
			[Key.remoteSecret]: null,
			[Key.uploadedThrough]: null,
			[Key.legacyUploaded]: null,
			[Key.syncedAt]: null,
			[Key.error]: null,
		};
		const control = yield* MachineControlService;
		const personal = <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
			effect.pipe(Effect.provideService(RequestWorkspace, "personal"));
		if (input.enabled) {
			yield* personal(control.setUsageHistorySettings(true));
			yield* writeState({ ...reset, [Key.account]: subject });
			yield* sql`DELETE FROM usage_history_remote`;
			yield* syncUsageBackup({ force: true, buildSnapshot, loadPriced });
		} else {
			yield* input.deleteRemote
				? personal(control.deleteUsageHistory())
				: personal(control.setUsageHistorySettings(false));
			yield* writeState({ ...reset, [Key.account]: null });
			yield* sql`DELETE FROM usage_history_remote`;
		}
		return yield* usageBackupState;
	});

const runtimeJson = <A, I>(
	schema: Schema.Codec<A, I>,
	response: () => Promise<Response>,
) =>
	Effect.tryPromise(async () => {
		const result = await response();
		if (!result.ok) throw new Error(`usage-history-http-${result.status}`);
		return Schema.decodeUnknownSync(schema)(await result.json());
	});

/**
 * Personal cloud workspaces upload their own hourly history to the owner's
 * account while the owner has backup on. The workspace authenticates as
 * itself; the API attributes rows to the owner and refuses organizations.
 */
export const syncCloudUsageHistory = (options: {
	readonly loadPriced?: LoadPriced;
}) =>
	Effect.gen(function* () {
		const control = yield* Effect.serviceOption(RuntimeCloudControl);
		const transport = control._tag === "Some" ? control.value.current : null;
		if (transport === null) return;
		const state = yield* readState;
		const syncedAt = Number(state.get(Key.cloudSyncedAt));
		const now = yield* Clock.currentTimeMillis;
		if (
			Number.isFinite(syncedAt) &&
			now - syncedAt < CLOUD_USAGE_UPLOAD_INTERVAL_MS
		)
			return;
		yield* persistLatest(options.loadPriced);
		const { key } = yield* runtimeJson(UsageHistoryRuntimeKey, () =>
			transport.runtimeRequest(
				ApiPaths.cloudWorkspaceRuntimeUsageHistoryKey(transport.workspaceId),
				"GET",
			),
		);
		if (key !== null)
			yield* uploadChangedHistory(key, (rows) =>
				runtimeJson(UsageHistoryAccepted, () =>
					transport.runtimeRequest(
						ApiPaths.cloudWorkspaceRuntimeUsageHistory(transport.workspaceId),
						"PUT",
						{ rows },
					),
				),
			);
		yield* writeState({ [Key.cloudSyncedAt]: String(now) });
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.logWarning(`[usage] cloud usage upload failed: ${String(cause)}`),
		),
	);
