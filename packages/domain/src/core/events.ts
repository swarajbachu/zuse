import { Schema } from "effect";

import { SegmentKind, SettlementOutcome } from "./commands.js";

export const SessionEvent = Schema.Union([
	Schema.TaggedStruct("SessionCreated", {
		sessionId: Schema.String,
		chatId: Schema.String,
		projectId: Schema.String,
		createdAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionTitleSet", { title: Schema.String }),
	Schema.TaggedStruct("SessionArchived", { archivedAt: Schema.Number }),
	Schema.TaggedStruct("SessionDeleted", { deletedAt: Schema.Number }),
	Schema.TaggedStruct("TurnStarted", {
		turnId: Schema.String,
		startedAt: Schema.Number,
	}),
	Schema.TaggedStruct("TurnSettled", {
		turnId: Schema.String,
		outcome: SettlementOutcome,
		settledAt: Schema.Number,
	}),
	Schema.TaggedStruct("MessagePersisted", {
		messageId: Schema.String,
		turnId: Schema.NullOr(Schema.String),
		role: Schema.String,
		kind: Schema.String,
		contentJson: Schema.String,
		parentItemId: Schema.NullOr(Schema.String),
		createdAt: Schema.Number,
	}),
	Schema.TaggedStruct("SegmentOpened", {
		turnId: Schema.String,
		segmentId: Schema.String,
		kind: SegmentKind,
		openedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SegmentSettled", {
		turnId: Schema.String,
		segmentId: Schema.String,
		outcome: SettlementOutcome,
		settledAt: Schema.Number,
	}),
	Schema.TaggedStruct("PermissionRequested", {
		requestId: Schema.String,
		turnId: Schema.String,
		payloadJson: Schema.String,
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("PermissionResolved", {
		requestId: Schema.String,
		decision: Schema.String,
		resolvedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ProviderAttached", {
		providerId: Schema.String,
		attachedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ProviderDetached", {
		providerId: Schema.String,
		detachedAt: Schema.Number,
	}),
	Schema.TaggedStruct("CheckpointRecorded", {
		checkpointId: Schema.String,
		payloadJson: Schema.String,
		recordedAt: Schema.Number,
	}),
	Schema.TaggedStruct("WorktreeArchiveRequested", {
		worktreeId: Schema.String,
		requestedAt: Schema.Number,
	}),
]);
export type SessionEvent = typeof SessionEvent.Type;
