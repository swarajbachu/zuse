import {
	SessionStreamCursor,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { Result, Schema } from "effect";
import { resourceRefKey, type SessionRef } from "./resource-ref.js";

export const SESSION_TIMELINE_CACHE_SCHEMA_VERSION = 3;

const EncodedSessionRef = Schema.Struct({
	environmentId: Schema.String,
	sessionId: Schema.String,
});

const EncodedSessionTimelineCacheEntryV2 = Schema.Struct({
	schemaVersion: Schema.Literal(2),
	sessionId: Schema.String,
	ref: EncodedSessionRef,
	appliedVersion: Schema.Number,
	projection: SessionTimelineProjection,
	savedAt: Schema.Number,
	accessedAt: Schema.Number,
	estimatedBytes: Schema.Number,
});

const EncodedSessionTimelineCacheEntry = Schema.Struct({
	schemaVersion: Schema.Literal(SESSION_TIMELINE_CACHE_SCHEMA_VERSION),
	/** IndexedDB keyPath retained across cache schema upgrades. */
	sessionId: Schema.String,
	ref: EncodedSessionRef,
	cursor: SessionStreamCursor,
	projection: SessionTimelineProjection,
	savedAt: Schema.Number,
	accessedAt: Schema.Number,
	estimatedBytes: Schema.Number,
});

export type SessionTimelineCacheEntry = Readonly<{
	schemaVersion: typeof SESSION_TIMELINE_CACHE_SCHEMA_VERSION;
	ref: SessionRef;
	cursor: SessionStreamCursor;
	projection: SessionTimelineProjection;
	savedAt: number;
	accessedAt: number;
	estimatedBytes: number;
}>;

export interface SessionTimelineCache {
	readonly load: (ref: SessionRef) => Promise<SessionTimelineCacheEntry | null>;
	readonly save: (entry: SessionTimelineCacheEntry) => Promise<void>;
	readonly remove: (ref: SessionRef) => Promise<void>;
	readonly prune: (limits?: {
		readonly maxEntries?: number;
		readonly maxBytes?: number;
	}) => Promise<void>;
}

export const encodeSessionTimelineCacheEntry = (
	entry: SessionTimelineCacheEntry,
): unknown =>
	Schema.encodeSync(EncodedSessionTimelineCacheEntry)({
		...entry,
		sessionId: resourceRefKey(entry.ref),
	});

export const decodeSessionTimelineCacheEntry = (
	value: unknown,
): SessionTimelineCacheEntry => {
	const current = Schema.decodeUnknownResult(EncodedSessionTimelineCacheEntry)(
		value,
	);
	if (Result.isSuccess(current)) {
		const { sessionId: _storageKey, ...entry } = current.success;
		return entry as SessionTimelineCacheEntry;
	}
	const {
		sessionId: _storageKey,
		appliedVersion,
		...legacy
	} = Schema.decodeUnknownSync(EncodedSessionTimelineCacheEntryV2)(value);
	return {
		...legacy,
		schemaVersion: SESSION_TIMELINE_CACHE_SCHEMA_VERSION,
		cursor: { epoch: "legacy", version: appliedVersion },
	} as SessionTimelineCacheEntry;
};

export const makeSessionTimelineCacheEntry = (input: {
	readonly ref: SessionRef;
	readonly cursor: SessionStreamCursor;
	readonly projection: SessionTimelineProjection;
	readonly now?: number;
}): SessionTimelineCacheEntry => {
	const now = input.now ?? Date.now();
	return {
		schemaVersion: SESSION_TIMELINE_CACHE_SCHEMA_VERSION,
		ref: input.ref,
		cursor: input.cursor,
		projection: input.projection,
		savedAt: now,
		accessedAt: now,
		estimatedBytes: 0,
	};
};
