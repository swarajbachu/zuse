import { type SessionId, SessionTimelineProjection } from "@zuse/contracts";
import { Schema } from "effect";

export const SESSION_TIMELINE_CACHE_SCHEMA_VERSION = 1;

const EncodedSessionTimelineCacheEntry = Schema.Struct({
	schemaVersion: Schema.Literal(SESSION_TIMELINE_CACHE_SCHEMA_VERSION),
	sessionId: Schema.String,
	appliedVersion: Schema.Number,
	projection: SessionTimelineProjection,
	savedAt: Schema.Number,
	accessedAt: Schema.Number,
	estimatedBytes: Schema.Number,
});

export type SessionTimelineCacheEntry = Readonly<{
	schemaVersion: typeof SESSION_TIMELINE_CACHE_SCHEMA_VERSION;
	sessionId: SessionId;
	appliedVersion: number;
	projection: SessionTimelineProjection;
	savedAt: number;
	accessedAt: number;
	estimatedBytes: number;
}>;

export interface SessionTimelineCache {
	readonly load: (
		sessionId: SessionId,
	) => Promise<SessionTimelineCacheEntry | null>;
	readonly save: (entry: SessionTimelineCacheEntry) => Promise<void>;
	readonly remove: (sessionId: SessionId) => Promise<void>;
	readonly prune: (limits?: {
		readonly maxEntries?: number;
		readonly maxBytes?: number;
	}) => Promise<void>;
}

export const encodeSessionTimelineCacheEntry = (
	entry: SessionTimelineCacheEntry,
): unknown => Schema.encodeSync(EncodedSessionTimelineCacheEntry)(entry);

export const decodeSessionTimelineCacheEntry = (
	value: unknown,
): SessionTimelineCacheEntry =>
	Schema.decodeUnknownSync(EncodedSessionTimelineCacheEntry)(
		value,
	) as SessionTimelineCacheEntry;

export const makeSessionTimelineCacheEntry = (input: {
	readonly sessionId: SessionId;
	readonly appliedVersion: number;
	readonly projection: SessionTimelineProjection;
	readonly now?: number;
}): SessionTimelineCacheEntry => {
	const now = input.now ?? Date.now();
	return {
		schemaVersion: SESSION_TIMELINE_CACHE_SCHEMA_VERSION,
		sessionId: input.sessionId,
		appliedVersion: input.appliedVersion,
		projection: input.projection,
		savedAt: now,
		accessedAt: now,
		estimatedBytes: 0,
	};
};
