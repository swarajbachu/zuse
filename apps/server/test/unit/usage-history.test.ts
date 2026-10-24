import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	UsageHistoryRow,
	UsageProfileInput,
	UsageProfileSnapshot,
	UsageProfileState,
} from "@zuse/contracts";
import { layer as nodeSqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { makeUsageRecord, type PricedUsage } from "tokenmaxer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppPaths } from "../../src/app-paths.ts";
import { AuthService } from "../../src/auth/services/auth-service.ts";
import {
	MachineControlError,
	MachineControlService,
} from "../../src/machine/machine-control-service.ts";
import { RuntimeCloudControl } from "../../src/machine/runtime-cloud-control.ts";
import { Migration0036UsageCostDaily } from "../../src/persistence/migrations/0036_usage_cost_daily.ts";
import { Migration0093UsageHistory } from "../../src/persistence/migrations/0093_usage_history.ts";
import {
	remoteHistoryForProfile,
	setUsageBackup,
	syncCloudUsageHistory,
	syncUsageBackup,
	USAGE_BACKUP_INTERVAL_MS,
	usageBackupState,
} from "../../src/usage/backup.ts";
import {
	type HistoryRow,
	mergePersistedUsage,
	mergeRemoteHistory,
	opaqueKey,
	PERSISTED_HISTORY,
	persistUsageHistory,
	REMOTE_HISTORY,
	readUsageHistory,
	toHistoryRows,
} from "../../src/usage/history.ts";

const SECRET = "ab".repeat(32);
const record = (
	at: string,
	tokens: number,
	overrides: Partial<Parameters<typeof makeUsageRecord>[0]> = {},
) =>
	makeUsageRecord({
		sourceId: "claude",
		sourceLabel: "Claude Code",
		model: "model-a",
		sessionId: "session-1",
		projectPath: "/private/project",
		startedAt: at,
		endedAt: at,
		counts: { inputTokens: tokens },
		provenance: "live",
		fingerprintParts: [at, String(tokens), overrides.sessionId ?? "session-1"],
		...overrides,
	});
const row = (overrides: Partial<HistoryRow> = {}): HistoryRow => ({
	hour: "2026-01-01T10:00:00.000Z",
	source_id: "claude",
	model: "model-a",
	session: "session-1",
	project: "/private/project",
	input_tokens: 10,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_creation_tokens: 0,
	reasoning_tokens: 0,
	cost_usd: null,
	record_count: 1,
	first_at: Date.parse("2026-01-01T10:05:00.000Z"),
	last_at: Date.parse("2026-01-01T10:06:00.000Z"),
	...overrides,
});
const tokens = (records: ReadonlyArray<{ inputTokens: number }>) =>
	records.reduce((sum, entry) => sum + entry.inputTokens, 0);

describe("usage history merge", () => {
	it("aggregates live records per hour, session, and project", () => {
		const rows = toHistoryRows([
			record("2026-01-01T10:05:00.000Z", 3),
			record("2026-01-01T10:40:00.000Z", 4),
			record("2026-01-01T11:01:00.000Z", 5),
			{
				...record("2026-01-01T12:00:00.000Z", 9),
				provenance: PERSISTED_HISTORY,
			},
		]);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			hour: "2026-01-01T10:00:00.000Z",
			input_tokens: 7,
			record_count: 2,
			session: "session-1",
			project: "/private/project",
		});
	});

	it("restores trimmed hours, keeps larger live hours, and prefers larger stored hours", () => {
		const live = [
			record("2026-01-01T11:05:00.000Z", 50),
			record("2026-01-01T12:05:00.000Z", 2),
		];
		const merged = mergePersistedUsage(
			{ records: live, sources: [] },
			[
				row(),
				row({ hour: "2026-01-01T11:00:00.000Z", input_tokens: 20 }),
				row({ hour: "2026-01-01T12:00:00.000Z", input_tokens: 30 }),
			],
			[
				{
					day: "2026-01-01",
					source_id: "claude",
					model: "model-a",
					input_tokens: 999,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_creation_tokens: 0,
					reasoning_tokens: 0,
					cost_usd: null,
					cost_status: "unknown",
					record_count: 1,
				},
				{
					day: "2025-12-31",
					source_id: "claude",
					model: "model-a",
					input_tokens: 7,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_creation_tokens: 0,
					reasoning_tokens: 0,
					cost_usd: null,
					cost_status: "unknown",
					record_count: 1,
				},
			],
		).records;
		expect(tokens(merged)).toBe(10 + 50 + 30 + 7);
		const restored = merged.find(
			(entry) =>
				entry.provenance === PERSISTED_HISTORY && entry.inputTokens === 10,
		);
		expect(restored).toMatchObject({
			sessionId: "session-1",
			projectPath: "/private/project",
			sourceLabel: "Claude Code",
		});
		expect(restored?.startedAt.toISOString()).toBe("2026-01-01T10:05:00.000Z");
	});

	it("adds other devices' rows once, matching by hashed key", () => {
		const local = [record("2026-01-01T10:05:00.000Z", 10)];
		const remoteSame = row({
			session: opaqueKey(SECRET, "session-1"),
			project: opaqueKey(SECRET, "/private/project"),
		});
		const remoteOther = row({
			session: opaqueKey(SECRET, "other-device-session"),
			project: "",
			input_tokens: 4,
		});
		const merged = mergeRemoteHistory(local, [remoteSame, remoteOther], SECRET);
		expect(tokens(merged)).toBe(14);
		expect(
			merged.find((entry) => entry.provenance === REMOTE_HISTORY)?.sessionId,
		).toBe(opaqueKey(SECRET, "other-device-session"));
		const larger = mergeRemoteHistory(
			local,
			[{ ...remoteSame, input_tokens: 25 }],
			SECRET,
		);
		expect(tokens(larger)).toBe(25);
		expect(JSON.stringify(merged)).not.toMatch(/session-1|private/);
	});

	it("gives one session one identity across local and backed-up hours", () => {
		const merged = mergeRemoteHistory(
			[record("2026-01-01T11:05:00.000Z", 10)],
			[
				row({
					session: opaqueKey(SECRET, "session-1"),
					project: opaqueKey(SECRET, "/private/project"),
				}),
			],
			SECRET,
		);
		expect(tokens(merged)).toBe(20);
		expect(new Set(merged.map((entry) => entry.sessionId))).toEqual(
			new Set([opaqueKey(SECRET, "session-1")]),
		);
		expect(new Set(merged.map((entry) => entry.projectPath))).toEqual(
			new Set([opaqueKey(SECRET, "/private/project")]),
		);
	});
});

const signedIn = (id: string) => ({
	_tag: "SignedIn" as const,
	session: { user: { id } },
});

describe("usage backup sync", () => {
	let directory: string;
	let runtime: ManagedRuntime.ManagedRuntime<
		| SqlClient.SqlClient
		| AppPaths
		| AuthService
		| MachineControlService
		| RuntimeCloudControl,
		unknown
	>;
	let subject: string | null;
	let uploads: UsageHistoryRow[][];
	let remote: UsageHistoryRow[];
	let published: UsageProfileInput[];
	let profile: UsageProfileState;
	let failUpload: boolean;
	let failPage: boolean;
	let refreshed: { input: UsageProfileInput; updatedAt: number }[];
	let failRefresh: boolean;
	let deleted: number;
	let priced: PricedUsage;
	let accountEnabled: boolean;
	let accountKey: string;
	let workspace: {
		key: string | null;
		requests: { path: string; method: string; body?: unknown }[];
		status: number;
	};

	const snapshot = {
		cost: { usd: 1, complete: true },
		hours: Array.from({ length: 24 }, () => 0),
	} as unknown as UsageProfileSnapshot;
	const buildSnapshot = () => Effect.succeed(snapshot);
	const run = <A, E>(
		effect: Effect.Effect<
			A,
			E,
			| SqlClient.SqlClient
			| AppPaths
			| AuthService
			| MachineControlService
			| RuntimeCloudControl
		>,
	) => runtime.runPromise(effect);
	const sync = (force = false) =>
		run(
			syncUsageBackup({ force, buildSnapshot, loadPriced: async () => priced }),
		);

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "usage-history-"));
		subject = "alice";
		uploads = [];
		remote = [];
		published = [];
		failUpload = false;
		failPage = false;
		refreshed = [];
		failRefresh = false;
		deleted = 0;
		accountEnabled = false;
		accountKey = SECRET;
		workspace = { key: null, requests: [], status: 200 };
		profile = { profile: null, published: false };
		priced = {
			records: [
				record("2026-01-01T10:05:00.000Z", 10),
				record("2026-01-01T11:05:00.000Z", 5, {
					sessionId: "session-2",
					fingerprintParts: ["b"],
				}),
			],
			sources: [],
		};
		const control = {
			usageHistoryKey: () => Effect.sync(() => ({ key: accountKey })),
			usageHistorySettings: () =>
				Effect.sync(() => ({ enabled: accountEnabled })),
			setUsageHistorySettings: (enabled: boolean) =>
				Effect.sync(() => {
					accountEnabled = enabled;
					return { enabled };
				}),
			uploadUsageHistory: (rows: ReadonlyArray<UsageHistoryRow>) =>
				failUpload
					? Effect.fail(new MachineControlError("provider-unavailable"))
					: Effect.sync(() => {
							uploads.push([...rows]);
							return { accepted: rows.length };
						}),
			usageHistoryPage: (cursor: string | null) =>
				failPage
					? Effect.fail(new MachineControlError("provider-unavailable"))
					: Effect.succeed(
							cursor === null
								? {
										rows: remote.slice(0, 1),
										nextCursor: remote.length > 1 ? "1" : null,
									}
								: { rows: remote.slice(1), nextCursor: null },
						),
			deleteUsageHistory: () =>
				Effect.sync(() => {
					deleted += 1;
					accountEnabled = false;
					return { accepted: 0 };
				}),
			getUsageProfile: () => Effect.succeed(profile),
			refreshUsageProfile: (input: UsageProfileInput, updatedAt: number) =>
				failRefresh
					? Effect.fail(new MachineControlError("conflict"))
					: Effect.sync(() => {
							refreshed.push({ input, updatedAt });
							return profile;
						}),
			publishUsageProfile: (input: UsageProfileInput) =>
				Effect.sync(() => {
					published.push(input);
					return profile;
				}),
		};
		runtime = ManagedRuntime.make(
			Layer.mergeAll(
				nodeSqliteLayer({
					filename: join(directory, "zuse.sqlite"),
					disableWAL: true,
				}),
				Layer.succeed(AppPaths, { userData: directory } as never),
				Layer.succeed(AuthService, {
					getSession: () =>
						Effect.succeed(
							subject === null ? { _tag: "SignedOut" } : signedIn(subject),
						),
				} as never),
				Layer.succeed(MachineControlService, control as never),
				Layer.succeed(RuntimeCloudControl, {
					current: {
						workspaceId: "workspace-1",
						request: async () => new Response(null, { status: 404 }),
						runtimeRequest: async (
							path: string,
							method: string,
							body?: unknown,
						) => {
							workspace.requests.push({ path, method, body });
							if (workspace.status !== 200)
								return new Response(null, { status: workspace.status });
							return Response.json(
								method === "GET"
									? { key: workspace.key }
									: {
											accepted: (body as { rows: unknown[] }).rows.length,
										},
							);
						},
					},
				}),
			),
		);
		await run(
			Effect.gen(function* () {
				yield* Migration0036UsageCostDaily;
				yield* Migration0093UsageHistory;
			}),
		);
	});
	afterEach(async () => {
		await runtime.dispose();
		rmSync(directory, { recursive: true, force: true });
	});

	it("persists monotonically and only advances change_seq when a row grows", async () => {
		await run(persistUsageHistory(priced));
		const first = await run(readUsageHistory());
		await run(
			persistUsageHistory({
				...priced,
				records: [record("2026-01-01T10:05:00.000Z", 3)],
			}),
		);
		expect(await run(readUsageHistory())).toEqual(first);
		await run(
			persistUsageHistory({
				...priced,
				records: [record("2026-01-01T10:05:00.000Z", 30)],
			}),
		);
		const grown = await run(readUsageHistory(first.at(-1)?.change_seq ?? 0));
		expect(grown).toHaveLength(1);
		expect(grown[0]?.input_tokens).toBe(30);
	});

	it("does nothing until enabled for the signed-in account", async () => {
		await sync(true);
		expect(uploads).toEqual([]);
		expect((await run(usageBackupState)).enabled).toBe(false);
	});

	it("uploads hashed rows, caches the account copy, and respects the interval", async () => {
		remote = [
			{
				hour: "2026-01-02T09:00:00.000Z",
				sourceId: "codex",
				model: "model-b",
				session: opaqueKey(SECRET, "elsewhere"),
				project: "",
				inputTokens: 7,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				reasoningTokens: 0,
				costUsd: null,
				recordCount: 1,
				firstAt: Date.parse("2026-01-02T09:10:00.000Z"),
				lastAt: Date.parse("2026-01-02T09:10:00.000Z"),
			},
			{
				hour: "2026-01-03T09:00:00.000Z",
				sourceId: "codex",
				model: "model-b",
				session: "",
				project: "",
				inputTokens: 1,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				reasoningTokens: 0,
				costUsd: null,
				recordCount: 1,
				firstAt: Date.parse("2026-01-03T09:10:00.000Z"),
				lastAt: Date.parse("2026-01-03T09:10:00.000Z"),
			},
		];
		const state = await run(
			setUsageBackup({ enabled: true }, buildSnapshot, async () => priced),
		);
		expect(state).toMatchObject({ enabled: true, lastError: null });
		expect(state.lastSyncedAt).toEqual(expect.any(Number));
		const sent = uploads.flat();
		expect(sent).toHaveLength(2);
		expect(JSON.stringify(sent)).not.toMatch(/session-1|private/);
		expect(sent[0]?.session).toBe(opaqueKey(SECRET, "session-1"));
		const cached = await run(
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql<{
						count: number;
					}>`SELECT COUNT(*) AS count FROM usage_history_remote`,
			),
		);
		expect(cached[0]?.count).toBe(2);

		await sync();
		expect(uploads).toHaveLength(1);
		priced = {
			...priced,
			records: [
				...priced.records,
				record("2026-01-04T08:00:00.000Z", 1, { fingerprintParts: ["c"] }),
			],
		};
		await sync(true);
		expect(uploads.at(-1)).toHaveLength(1);
		expect(USAGE_BACKUP_INTERVAL_MS).toBe(3 * 24 * 60 * 60 * 1_000);
	});

	it("republishes a published profile with the owner's opt-ins", async () => {
		profile = {
			published: true,
			profile: {
				handle: "sample-dev",
				displayName: "Sample",
				github: "",
				cost: null,
				hours: Array.from({ length: 24 }, () => 0),
				updatedAt: 7,
			} as never,
		};
		await run(
			setUsageBackup({ enabled: true }, buildSnapshot, async () => priced),
		);
		expect(published).toEqual([]);
		expect(refreshed).toHaveLength(1);
		expect(refreshed[0]?.updatedAt).toBe(7);
		expect(refreshed[0]?.input).toMatchObject({
			handle: "sample-dev",
			cost: null,
		});
		expect(refreshed[0]?.input.hours).toHaveLength(24);
	});

	it("drops a refresh the profile owner changed meanwhile without failing the sync", async () => {
		profile = {
			published: true,
			profile: {
				handle: "sample-dev",
				displayName: "Sample",
				github: "",
				cost: null,
				hours: null,
				updatedAt: 7,
			} as never,
		};
		failRefresh = true;
		const state = await run(
			setUsageBackup({ enabled: true }, buildSnapshot, async () => priced),
		);
		expect(state.lastError).toBeNull();
	});

	it("never shows one account's cached rows to another account", async () => {
		remote = [
			{
				hour: "2026-01-02T09:00:00.000Z",
				sourceId: "codex",
				model: "model-b",
				session: "",
				project: "",
				inputTokens: 7,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				reasoningTokens: 0,
				costUsd: null,
				recordCount: 1,
				firstAt: Date.parse("2026-01-02T09:10:00.000Z"),
				lastAt: Date.parse("2026-01-02T09:10:00.000Z"),
			},
		];
		await run(
			setUsageBackup({ enabled: true }, buildSnapshot, async () => priced),
		);
		expect((await run(remoteHistoryForProfile))?.rows).toHaveLength(1);

		subject = "bob";
		failPage = true;
		await run(
			setUsageBackup({ enabled: true }, buildSnapshot, async () => priced),
		);
		expect(await run(remoteHistoryForProfile)).toBeNull();
	});

	it("skips rows the backup API would reject and keeps backing up the rest", async () => {
		priced = {
			...priced,
			records: [
				...priced.records,
				record("2019-06-01T10:05:00.000Z", 9, { fingerprintParts: ["old"] }),
			],
		};
		await run(
			setUsageBackup({ enabled: true }, buildSnapshot, async () => priced),
		);
		expect(uploads.flat()).toHaveLength(2);
		expect(uploads.flat().some((entry) => entry.hour.startsWith("2019"))).toBe(
			false,
		);
		await sync(true);
		expect(uploads).toHaveLength(1);
	});

	it("stops when the account changes and records sync failures", async () => {
		await run(
			setUsageBackup({ enabled: true }, buildSnapshot, async () => priced),
		);
		subject = "bob";
		await sync(true);
		expect(uploads).toHaveLength(1);
		expect((await run(usageBackupState)).enabled).toBe(false);

		subject = "alice";
		failUpload = true;
		priced = {
			...priced,
			records: [
				record("2026-02-01T08:00:00.000Z", 1, { fingerprintParts: ["d"] }),
			],
		};
		await sync(true);
		expect((await run(usageBackupState)).lastError).toBe(
			"provider-unavailable",
		);
	});

	it("disables and erases the account copy on request", async () => {
		await run(
			setUsageBackup({ enabled: true }, buildSnapshot, async () => priced),
		);
		const state = await run(
			setUsageBackup({ enabled: false, deleteRemote: true }, buildSnapshot),
		);
		expect(state).toEqual({
			enabled: false,
			lastSyncedAt: null,
			lastError: null,
		});
		expect(deleted).toBe(1);
		const cached = await run(
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql<{
						count: number;
					}>`SELECT COUNT(*) AS count FROM usage_history_remote`,
			),
		);
		expect(cached[0]?.count).toBe(0);
	});
	it("turns the account switch on and off with the device", async () => {
		await run(
			setUsageBackup({ enabled: true }, buildSnapshot, async () => priced),
		);
		expect(accountEnabled).toBe(true);
		await run(setUsageBackup({ enabled: false }, buildSnapshot));
		expect(accountEnabled).toBe(false);
		expect(deleted).toBe(0);
	});

	it("stops on this device when backup was turned off elsewhere", async () => {
		await run(
			setUsageBackup({ enabled: true }, buildSnapshot, async () => priced),
		);
		accountEnabled = false;
		priced = {
			...priced,
			records: [
				record("2026-03-01T08:00:00.000Z", 1, { fingerprintParts: ["e"] }),
			],
		};
		await sync(true);
		expect(uploads).toHaveLength(1);
		expect((await run(usageBackupState)).enabled).toBe(false);
	});

	it("re-uploads everything after the account copy is recreated", async () => {
		await run(
			setUsageBackup({ enabled: true }, buildSnapshot, async () => priced),
		);
		expect(uploads.at(-1)).toHaveLength(2);
		accountKey = "cd".repeat(32);
		await sync(true);
		expect(uploads.at(-1)).toHaveLength(2);
		expect(uploads.at(-1)?.[0]?.session).toBe(
			opaqueKey(accountKey, "session-1"),
		);
	});

	it("uploads cloud workspace history hourly only while the owner's backup is on", async () => {
		const cloud = () =>
			run(syncCloudUsageHistory({ loadPriced: async () => priced }));
		await cloud();
		expect(workspace.requests.map((entry) => entry.method)).toEqual(["GET"]);
		expect(await run(readUsageHistory())).toHaveLength(2);

		workspace.key = SECRET;
		await cloud();
		expect(workspace.requests).toHaveLength(1);

		await run(
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql`DELETE FROM usage_backup_state WHERE key = 'cloud_synced_at'`,
			),
		);
		await cloud();
		const put = workspace.requests.at(-1);
		expect(put).toMatchObject({
			method: "PUT",
			path: "/v1/cloud/workspaces/workspace-1/runtime/usage-history",
		});
		const rows = (put?.body as { rows: UsageHistoryRow[] } | undefined)?.rows;
		expect(rows).toHaveLength(2);
		expect(JSON.stringify(rows)).not.toMatch(/session-1|private/);
		expect(uploads).toEqual([]);
	});

	it("keeps cloud upload failures out of the poller", async () => {
		workspace.key = SECRET;
		workspace.status = 503;
		await expect(
			run(syncCloudUsageHistory({ loadPriced: async () => priced })),
		).resolves.toBeUndefined();
	});
});
