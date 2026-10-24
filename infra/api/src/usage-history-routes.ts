import {
	ApiPaths,
	USAGE_HISTORY_MAX_ROWS,
	type UsageHistoryRow,
	UsageHistorySettings,
	UsageHistoryUpload,
} from "@zuse/contracts";
import { validUsageHistoryRow } from "@zuse/utils/usage-history";
import { Clock, Effect } from "effect";
import { requireWorkos } from "./auth.ts";
import { randomHex } from "./crypto.ts";
import { ApiError, badRequest, conflict, notFound } from "./errors.ts";
import { decodeBody, json } from "./http.ts";
import { ApiStore, usageHistoryRowKey } from "./store.ts";

/** A full upload of max-size rows is ~700 KiB; leave headroom for formatting. */
const MAX_UPLOAD_BYTES = 1.5 * 1024 * 1024;
export const USAGE_HISTORY_MAX_ACCOUNT_ROWS = 1_000_000;
const CURSOR_PATTERN = /^[1-9]\d{0,15}$/u;

const privateJson = (body: unknown, status = 200) => {
	const response = json(body, status);
	response.headers.set("cache-control", "no-store");
	response.headers.set("x-robots-tag", "noindex");
	return response;
};

/** Every row must be valid and unique within the batch; one bad row rejects all. */
const validUpload = (
	rows: ReadonlyArray<UsageHistoryRow>,
	now: number,
): boolean => {
	const keys = new Set<string>();
	for (const row of rows) {
		if (!validUsageHistoryRow(row, now)) return false;
		const key = usageHistoryRowKey(row);
		if (keys.has(key)) return false;
		keys.add(key);
	}
	return true;
};

const parseCursor = (cursor: string | null): number | null => {
	if (cursor === null) return 0;
	if (!CURSOR_PATTERN.test(cursor)) return null;
	const id = Number(cursor);
	return Number.isSafeInteger(id) ? id : null;
};

/**
 * Validate and store one upload for `accountId`. Shared by the account route
 * and cloud workspace runtimes, which also require the owner's backup switch.
 */
export const putUsageHistory = Effect.fn("putUsageHistory")(function* (
	request: Request,
	accountId: string,
	options: { readonly requireBackupEnabled: boolean },
) {
	const upload = yield* decodeBody(
		UsageHistoryUpload,
		request,
		MAX_UPLOAD_BYTES,
	);
	const now = yield* Clock.currentTimeMillis;
	if (!validUpload(upload.rows, now))
		return yield* badRequest("invalid_usage_history");
	const store = yield* ApiStore;
	const result = yield* store.upsertUsageHistory(accountId, upload.rows, {
		maxAccountRows: USAGE_HISTORY_MAX_ACCOUNT_ROWS,
		requireBackupEnabled: options.requireBackupEnabled,
	});
	switch (result) {
		case "backup_disabled":
			return yield* conflict("usage_history_backup_disabled");
		case "full":
			return yield* new ApiError({ code: "usage_history_full", status: 413 });
		case "stored":
			return privateJson({ accepted: upload.rows.length });
	}
});

/** The owner's key for a cloud workspace runtime; null while backup is off. */
export const getUsageHistoryRuntimeKey = Effect.fn("getUsageHistoryRuntimeKey")(
	function* (accountId: string) {
		const store = yield* ApiStore;
		return privateJson({
			key: yield* store.getUsageHistoryRuntimeKey(accountId),
		});
	},
);

export const routeUsageHistoryRequest = Effect.fn("routeUsageHistoryRequest")(
	function* (request: Request) {
		const url = new URL(request.url);
		const path = url.pathname;
		if (
			path !== ApiPaths.usageHistory &&
			path !== ApiPaths.usageHistoryKey &&
			path !== ApiPaths.usageHistorySettings
		)
			return null;
		const principal = yield* requireWorkos(request);
		const accountId = principal.accountId;
		const store = yield* ApiStore;
		if (path === ApiPaths.usageHistorySettings) {
			if (request.method === "GET")
				return privateJson({
					enabled: yield* store.getUsageHistoryBackupEnabled(accountId),
				});
			if (request.method !== "PUT")
				return yield* notFound("usage_history_not_found");
			const settings = yield* decodeBody(UsageHistorySettings, request, 1024);
			const candidate = yield* randomHex(32);
			return privateJson({
				enabled: yield* store.setUsageHistoryBackupEnabled(
					accountId,
					settings.enabled,
					candidate,
				),
			});
		}
		if (path === ApiPaths.usageHistoryKey) {
			if (request.method !== "GET")
				return yield* notFound("usage_history_not_found");
			const candidate = yield* randomHex(32);
			const key = yield* store.getOrCreateUsageHistoryKey(accountId, candidate);
			return privateJson({ key });
		}
		switch (request.method) {
			case "GET": {
				const afterId = parseCursor(url.searchParams.get("cursor"));
				if (afterId === null)
					return yield* badRequest("invalid_usage_history_cursor");
				return privateJson(
					yield* store.pageUsageHistory(
						accountId,
						afterId,
						USAGE_HISTORY_MAX_ROWS,
					),
				);
			}
			// Checked inside the write, so a device that read "on" earlier
			// cannot recreate history after another device turns backup off.
			case "PUT":
				return yield* putUsageHistory(request, accountId, {
					requireBackupEnabled: true,
				});
			case "DELETE":
				return privateJson({
					accepted: yield* store.deleteUsageHistory(accountId),
				});
			default:
				return yield* notFound("usage_history_not_found");
		}
	},
);
