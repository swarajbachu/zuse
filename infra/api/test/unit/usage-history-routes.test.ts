import type { UsageHistoryRow } from "@zuse/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiStore, ApiStoreMemory } from "../../src/store.ts";
import { routeUsageHistoryRequest } from "../../src/usage-history-routes.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

const HOUR_MS = 60 * 60 * 1_000;
const BASE_HOUR = Date.UTC(2026, 0, 1);

const makeRow = (
	offsetHours = 0,
	overrides: Partial<UsageHistoryRow> = {},
): UsageHistoryRow => {
	const hour = BASE_HOUR + offsetHours * HOUR_MS;
	return {
		hour: new Date(hour).toISOString(),
		sourceId: "claude",
		model: "model-a",
		session: "a".repeat(32),
		project: "b".repeat(32),
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 10,
		cacheCreationTokens: 5,
		reasoningTokens: 2,
		costUsd: 1.5,
		recordCount: 3,
		firstAt: hour + 60_000,
		lastAt: hour + 120_000,
		...overrides,
	};
};

describe("usage history backup", () => {
	let runtime: ReturnType<typeof makeRuntime>;
	const makeRuntime = () =>
		ManagedRuntime.make(Layer.mergeAll(ApiStoreMemory, WorkosVerifierTest));
	beforeEach(() => {
		runtime = makeRuntime();
	});
	afterEach(async () => {
		await runtime.dispose();
	});
	const call = (
		method: string,
		account: string | null,
		path: string,
		body?: unknown,
	) =>
		runtime.runPromise(
			routeUsageHistoryRequest(
				new Request(`https://api.test${path}`, {
					method,
					headers: {
						...(account
							? { authorization: `Bearer test-token:${account}` }
							: {}),
						"content-type": "application/json",
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			),
		);
	const getJson = async (task: ReturnType<typeof call>) => {
		const response = await task;
		expect(response?.status).toBe(200);
		expect(response?.headers.get("cache-control")).toBe("no-store");
		return response?.json();
	};
	const errorCode = (task: Promise<unknown>) =>
		task.then(
			() => "ok",
			(error) => error.code ?? String(error),
		);
	/** Account uploads require backup on, as a real device enables it first. */
	const upload = async (
		rows: ReadonlyArray<UsageHistoryRow>,
		account = "alice",
	) => {
		await getJson(
			call("PUT", account, "/v1/usage-history/settings", { enabled: true }),
		);
		return getJson(call("PUT", account, "/v1/usage-history", { rows }));
	};
	const page = (account = "alice", cursor?: string) =>
		getJson(
			call(
				"GET",
				account,
				`/v1/usage-history${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
			),
		);
	const key = (account = "alice") =>
		getJson(call("GET", account, "/v1/usage-history/key"));
	const remove = (account = "alice") =>
		getJson(call("DELETE", account, "/v1/usage-history"));

	it("ignores unrelated paths", async () => {
		expect(await call("GET", "alice", "/v1/usage-profile")).toBeNull();
		expect(await call("GET", "alice", "/v1/usage-history/other")).toBeNull();
	});

	it("requires account authentication on every endpoint", async () => {
		for (const [method, path, body] of [
			["GET", "/v1/usage-history/key", undefined],
			["GET", "/v1/usage-history", undefined],
			["PUT", "/v1/usage-history", { rows: [makeRow()] }],
			["DELETE", "/v1/usage-history", undefined],
		] as const)
			expect(await errorCode(call(method, null, path, body))).toContain(
				"missing_bearer",
			);
	});

	it("rejects unsupported methods as not found", async () => {
		expect(await errorCode(call("POST", "alice", "/v1/usage-history"))).toBe(
			"usage_history_not_found",
		);
		expect(
			await errorCode(call("PUT", "alice", "/v1/usage-history/key", {})),
		).toBe("usage_history_not_found");
	});

	it("creates one stable key per account, including concurrent first calls", async () => {
		const [first, second] = await Promise.all([key(), key()]);
		expect(first.key).toMatch(/^[0-9a-f]{64}$/u);
		expect(second).toEqual(first);
		expect(await key()).toEqual(first);
		const other = await key("bob");
		expect(other.key).not.toBe(first.key);
	});

	it("starts empty and stores uploaded rows", async () => {
		expect(await page()).toEqual({ rows: [], nextCursor: null });
		expect(await upload([makeRow(0), makeRow(1)])).toEqual({ accepted: 2 });
		expect(await page()).toEqual({
			rows: [makeRow(0), makeRow(1)],
			nextCursor: null,
		});
		expect(await upload([])).toEqual({ accepted: 0 });
	});

	it("merges re-uploads monotonically", async () => {
		await upload([makeRow(0)]);
		await upload([
			makeRow(0, {
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 1,
				cacheCreationTokens: 1,
				reasoningTokens: 1,
				costUsd: null,
				recordCount: 1,
				firstAt: BASE_HOUR + 90_000,
				lastAt: BASE_HOUR + 90_000,
			}),
		]);
		expect((await page()).rows).toEqual([makeRow(0)]);
		await upload([
			makeRow(0, {
				inputTokens: 200,
				outputTokens: 60,
				cacheReadTokens: 11,
				cacheCreationTokens: 6,
				reasoningTokens: 3,
				costUsd: 2.25,
				recordCount: 4,
				firstAt: BASE_HOUR,
				lastAt: BASE_HOUR + 3 * HOUR_MS,
			}),
		]);
		expect((await page()).rows).toEqual([
			makeRow(0, {
				inputTokens: 200,
				outputTokens: 60,
				cacheReadTokens: 11,
				cacheCreationTokens: 6,
				reasoningTokens: 3,
				costUsd: 2.25,
				recordCount: 4,
				firstAt: BASE_HOUR,
				lastAt: BASE_HOUR + 3 * HOUR_MS,
			}),
		]);
	});

	it("keeps cost null only when every upload lacked a cost", async () => {
		await upload([makeRow(0, { costUsd: null })]);
		expect((await page()).rows[0].costUsd).toBeNull();
		await upload([makeRow(0, { costUsd: 0.5 })]);
		expect((await page()).rows[0].costUsd).toBe(0.5);
		await upload([makeRow(0, { costUsd: null })]);
		expect((await page()).rows[0].costUsd).toBe(0.5);
	});

	it("treats each key dimension as a separate row", async () => {
		await upload([
			makeRow(0),
			makeRow(0, { sourceId: "codex" }),
			makeRow(0, { model: "model-b" }),
			makeRow(0, { session: "" }),
			makeRow(0, { project: "" }),
		]);
		expect((await page()).rows).toHaveLength(5);
	});

	const future = Math.floor((Date.now() + 3 * HOUR_MS) / HOUR_MS) * HOUR_MS;
	it.each([
		[
			"impossible calendar hour",
			makeRow(0, { hour: "2026-02-30T01:00:00.000Z" }),
		],
		["hour out of range", makeRow(0, { hour: "2026-01-01T24:00:00.000Z" })],
		[
			"year before 2020",
			{
				...makeRow(0),
				hour: "2019-12-31T23:00:00.000Z",
				firstAt: Date.UTC(2019, 11, 31, 23, 1),
				lastAt: Date.UTC(2019, 11, 31, 23, 2),
			},
		],
		[
			"hour too far in the future",
			{
				...makeRow(0),
				hour: new Date(future).toISOString(),
				firstAt: future,
				lastAt: future,
			},
		],
		["firstAt after lastAt", makeRow(0, { lastAt: BASE_HOUR })],
		["firstAt before the hour", makeRow(0, { firstAt: BASE_HOUR - 1 })],
		["firstAt after the hour", makeRow(0, { firstAt: BASE_HOUR + HOUR_MS })],
		[
			"lastAt more than seven days after firstAt",
			makeRow(0, { lastAt: BASE_HOUR + 60_000 + 7 * 24 * HOUR_MS + 1 }),
		],
		["zero records", makeRow(0, { recordCount: 0 })],
	])("rejects the whole batch for %s", async (_, row) => {
		expect(
			await errorCode(
				call("PUT", "alice", "/v1/usage-history", { rows: [makeRow(1), row] }),
			),
		).toBe("invalid_usage_history");
		expect((await page()).rows).toEqual([]);
	});

	it("accepts boundary rows", async () => {
		const now = Math.floor((Date.now() + HOUR_MS) / HOUR_MS) * HOUR_MS;
		expect(
			await upload([
				makeRow(0, {
					firstAt: BASE_HOUR,
					lastAt: BASE_HOUR + 7 * 24 * HOUR_MS,
				}),
				makeRow(1, {
					firstAt: BASE_HOUR + 2 * HOUR_MS - 1,
					lastAt: BASE_HOUR + 2 * HOUR_MS - 1,
				}),
				{
					...makeRow(0),
					hour: new Date(now).toISOString(),
					firstAt: now,
					lastAt: now,
				},
			]),
		).toEqual({ accepted: 3 });
	});

	it("rejects duplicate keys within one batch", async () => {
		expect(
			await errorCode(
				call("PUT", "alice", "/v1/usage-history", {
					rows: [makeRow(0), makeRow(0, { inputTokens: 1 })],
				}),
			),
		).toBe("invalid_usage_history");
	});

	it.each([
		["unknown source", makeRow(0, { sourceId: "unknown" as "claude" })],
		["raw session id", makeRow(0, { session: "session-1" })],
		["non-integer tokens", makeRow(0, { inputTokens: 1.5 })],
		["negative cost", makeRow(0, { costUsd: -1 })],
		["non-canonical hour", makeRow(0, { hour: "2026-01-01T00:30:00.000Z" })],
	])("rejects schema-invalid rows: %s", async (_, row) => {
		expect(
			await errorCode(
				call("PUT", "alice", "/v1/usage-history", { rows: [row] }),
			),
		).toBe("invalid_request");
	});

	it("rejects batches above the row limit", async () => {
		expect(
			await errorCode(
				call("PUT", "alice", "/v1/usage-history", {
					rows: Array.from({ length: 2_001 }, (_, index) => makeRow(index)),
				}),
			),
		).toBe("invalid_request");
	});

	it("pages through history in a stable order across uploads", async () => {
		const first = Array.from({ length: 2_000 }, (_, index) => makeRow(index));
		const second = Array.from({ length: 500 }, (_, index) =>
			makeRow(2_000 + index),
		);
		await upload(first);
		await upload(second);
		await upload([makeRow(0, { inputTokens: 999 })]);
		const one = await page();
		expect(one.rows).toHaveLength(2_000);
		expect(one.nextCursor).toEqual(expect.any(String));
		const two = await page("alice", one.nextCursor);
		expect(two).toEqual({ rows: second, nextCursor: null });
		expect(one.rows[0]).toEqual(makeRow(0, { inputTokens: 999 }));
		expect(one.rows.slice(1)).toEqual(first.slice(1));
	});

	it("omits the cursor when the last page is exactly full", async () => {
		await upload(Array.from({ length: 2_000 }, (_, index) => makeRow(index)));
		expect((await page()).nextCursor).toBeNull();
	});

	it.each([
		"",
		"abc",
		"0",
		"-1",
		"1.5",
		"99999999999999999",
	])("rejects invalid cursor %j", async (cursor) => {
		expect(
			await errorCode(
				call(
					"GET",
					"alice",
					`/v1/usage-history?cursor=${encodeURIComponent(cursor)}`,
				),
			),
		).toBe("invalid_usage_history_cursor");
	});

	it("deletes all rows and rotates the key", async () => {
		const before = await key();
		await upload([makeRow(0), makeRow(1)]);
		expect(await remove()).toEqual({ accepted: 2 });
		expect(await page()).toEqual({ rows: [], nextCursor: null });
		expect((await key()).key).not.toBe(before.key);
		expect(await remove()).toEqual({ accepted: 0 });
	});

	it("isolates accounts", async () => {
		await upload([makeRow(0)], "alice");
		await upload([makeRow(0, { inputTokens: 7 })], "bob");
		expect((await page("alice")).rows).toEqual([makeRow(0)]);
		expect((await page("bob")).rows).toEqual([makeRow(0, { inputTokens: 7 })]);
		await remove("bob");
		expect((await page("alice")).rows).toEqual([makeRow(0)]);
	});

	it("removes history and the key with account deletion", async () => {
		const before = await key();
		await upload([makeRow(0)]);
		await upload([makeRow(0)], "bob");
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* ApiStore).deleteAccountData("alice");
			}),
		);
		expect(await page()).toEqual({ rows: [], nextCursor: null });
		expect((await key()).key).not.toBe(before.key);
		expect((await page("bob")).rows).toHaveLength(1);
	});

	const settings = (account = "alice") =>
		getJson(call("GET", account, "/v1/usage-history/settings"));
	const setBackup = (enabled: boolean, account = "alice") =>
		getJson(call("PUT", account, "/v1/usage-history/settings", { enabled }));

	it("keeps backup off by default and toggles it per account", async () => {
		expect(await settings()).toEqual({ enabled: false });
		expect(await setBackup(false)).toEqual({ enabled: false });
		expect(await settings()).toEqual({ enabled: false });
		expect(await setBackup(true)).toEqual({ enabled: true });
		expect(await settings()).toEqual({ enabled: true });
		expect(await settings("bob")).toEqual({ enabled: false });
		expect(await setBackup(false)).toEqual({ enabled: false });
		expect(await settings()).toEqual({ enabled: false });
	});

	it("validates settings requests", async () => {
		expect(
			await errorCode(call("PUT", null, "/v1/usage-history/settings", {})),
		).toContain("missing_bearer");
		expect(
			await errorCode(
				call("PUT", "alice", "/v1/usage-history/settings", { enabled: "yes" }),
			),
		).toBe("invalid_request");
		expect(
			await errorCode(call("DELETE", "alice", "/v1/usage-history/settings")),
		).toBe("usage_history_not_found");
	});

	it("enabling reuses the existing key and fetching the key leaves backup off", async () => {
		const before = await key();
		expect(await settings()).toEqual({ enabled: false });
		await setBackup(true);
		expect(await key()).toEqual(before);
		const [first, second] = await Promise.all([
			setBackup(true, "bob"),
			setBackup(true, "bob"),
		]);
		expect(first).toEqual({ enabled: true });
		expect(second).toEqual({ enabled: true });
		expect((await key("bob")).key).toMatch(/^[0-9a-f]{64}$/u);
	});

	it("turning backup off keeps the key and rows; delete resets it", async () => {
		await setBackup(true);
		const before = await key();
		await upload([makeRow(0)]);
		await setBackup(false);
		expect(await key()).toEqual(before);
		expect((await page()).rows).toEqual([makeRow(0)]);
		await setBackup(true);
		expect(await remove()).toEqual({ accepted: 1 });
		expect(await settings()).toEqual({ enabled: false });
	});

	it("refuses account uploads while backup is off, even after it was on", async () => {
		expect(
			await errorCode(
				call("PUT", "alice", "/v1/usage-history", { rows: [makeRow(0)] }),
			),
		).toBe("usage_history_backup_disabled");
		await upload([makeRow(0)]);
		await setBackup(false);
		expect(
			await errorCode(
				call("PUT", "alice", "/v1/usage-history", {
					rows: [makeRow(1)],
				}),
			),
		).toBe("usage_history_backup_disabled");
		expect((await page()).rows).toEqual([makeRow(0)]);
	});

	it("account deletion resets the backup switch", async () => {
		await setBackup(true);
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* ApiStore).deleteAccountData("alice");
			}),
		);
		expect(await settings()).toEqual({ enabled: false });
	});

	it("refuses writes that would exceed the per-account row cap", async () => {
		const store = await runtime.runPromise(ApiStore);
		const upsert = (rows: ReadonlyArray<UsageHistoryRow>) =>
			runtime.runPromise(
				store.upsertUsageHistory("alice", rows, {
					maxAccountRows: 3,
					requireBackupEnabled: false,
				}),
			);
		expect(await upsert([makeRow(0), makeRow(1)])).toBe("stored");
		expect(await upsert([makeRow(2), makeRow(3)])).toBe("full");
		expect(await upsert([makeRow(0, { inputTokens: 500 }), makeRow(2)])).toBe(
			"stored",
		);
		expect(await upsert([makeRow(4)])).toBe("full");
		expect(await upsert([makeRow(1, { inputTokens: 600 })])).toBe("stored");
		const stored = await runtime.runPromise(
			store.pageUsageHistory("alice", 0, 10),
		);
		expect(stored.rows.map((row) => row.inputTokens)).toEqual([500, 600, 100]);
	});
});
