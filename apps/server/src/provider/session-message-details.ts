import {
	SESSION_MESSAGE_DETAIL_CHUNK_BYTES,
	SESSION_MESSAGE_DETAIL_MAX_BYTES,
} from "@zuse/contracts";
import { readSessionMessageContent } from "@zuse/domain/queries/session-timeline-wire";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

/** Bounded, short-lived download buffers avoid scanning a large row per chunk. */
export const makeSessionMessageDetailReader = (
	read: (
		sessionId: string,
		messageId: string,
	) => ReturnType<typeof readSessionMessageContent>,
	now = Date.now,
) => {
	type Row = NonNullable<Effect.Success<ReturnType<typeof read>>>;
	const downloads = new Map<string, { row: Row; touched: number }>();
	let retainedBytes = 0;
	const remove = (key: string) => {
		const entry = downloads.get(key);
		if (entry) retainedBytes -= entry.row.content.byteLength;
		downloads.delete(key);
	};
	return Effect.fn("readSessionMessageDetailChunk")(function* (
		sessionId: string,
		messageId: string,
		offset: number,
	) {
		for (const [key, entry] of downloads)
			if (now() - entry.touched > 60_000) remove(key);
		const key = JSON.stringify([sessionId, messageId]);
		if (offset === 0) {
			const row = yield* read(sessionId, messageId);
			if (
				row === null ||
				row.content.byteLength > SESSION_MESSAGE_DETAIL_MAX_BYTES
			)
				return null;
			remove(key);
			while (
				downloads.size >= 32 ||
				retainedBytes + row.content.byteLength >
					SESSION_MESSAGE_DETAIL_MAX_BYTES
			) {
				const oldest = downloads.keys().next().value;
				if (oldest === undefined) break;
				remove(oldest);
			}
			downloads.set(key, { row, touched: now() });
			retainedBytes += row.content.byteLength;
		}
		const entry = downloads.get(key);
		if (!entry || offset >= entry.row.content.byteLength) return null;
		entry.touched = now();
		const content = entry.row.content.subarray(
			offset,
			offset + SESSION_MESSAGE_DETAIL_CHUNK_BYTES,
		);
		return {
			...entry.row,
			content,
			total: entry.row.content.byteLength,
			nextOffset:
				offset + content.byteLength < entry.row.content.byteLength
					? offset + content.byteLength
					: null,
		};
	});
};

const readers = new WeakMap<
	SqlClient.SqlClient,
	ReturnType<typeof makeSessionMessageDetailReader>
>();
export const sessionMessageDetailReader = (sql: SqlClient.SqlClient) => {
	let reader = readers.get(sql);
	if (!reader) {
		reader = makeSessionMessageDetailReader((sessionId, messageId) =>
			readSessionMessageContent(sql, sessionId, messageId),
		);
		readers.set(sql, reader);
	}
	return reader;
};
