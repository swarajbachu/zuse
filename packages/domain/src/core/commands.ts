import { Schema } from "effect";

export const SegmentKind = Schema.Literals(["assistant", "reasoning", "tool"]);
export type SegmentKind = typeof SegmentKind.Type;

export const SettlementOutcome = Schema.Literals([
	"completed",
	"interrupted",
	"error",
]);
export type SettlementOutcome = typeof SettlementOutcome.Type;

export const SessionCommand = Schema.Union([
	Schema.TaggedStruct("CreateSession", {
		sessionId: Schema.String,
		chatId: Schema.String,
		projectId: Schema.String,
		createdAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetTitle", { title: Schema.String }),
	Schema.TaggedStruct("ArchiveSession", { archivedAt: Schema.Number }),
	Schema.TaggedStruct("DeleteSession", { deletedAt: Schema.Number }),
	Schema.TaggedStruct("StartTurn", {
		turnId: Schema.String,
		startedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SettleTurn", {
		turnId: Schema.String,
		outcome: SettlementOutcome,
		settledAt: Schema.Number,
	}),
	Schema.TaggedStruct("PersistMessage", {
		messageId: Schema.String,
		turnId: Schema.NullOr(Schema.String),
		role: Schema.String,
		kind: Schema.String,
		contentJson: Schema.String,
		parentItemId: Schema.NullOr(Schema.String),
		createdAt: Schema.Number,
	}),
	Schema.TaggedStruct("OpenSegment", {
		turnId: Schema.String,
		segmentId: Schema.String,
		kind: SegmentKind,
		openedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SettleSegment", {
		turnId: Schema.String,
		segmentId: Schema.String,
		outcome: SettlementOutcome,
		settledAt: Schema.Number,
	}),
	Schema.TaggedStruct("RequestPermission", {
		requestId: Schema.String,
		turnId: Schema.String,
		payloadJson: Schema.String,
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ResolvePermission", {
		requestId: Schema.String,
		decision: Schema.String,
		resolvedAt: Schema.Number,
	}),
	Schema.TaggedStruct("AttachProvider", {
		providerId: Schema.String,
		attachedAt: Schema.Number,
	}),
	Schema.TaggedStruct("DetachProvider", { detachedAt: Schema.Number }),
	Schema.TaggedStruct("RecordCheckpoint", {
		checkpointId: Schema.String,
		payloadJson: Schema.String,
		recordedAt: Schema.Number,
	}),
	Schema.TaggedStruct("RequestWorktreeArchive", {
		worktreeId: Schema.String,
		requestedAt: Schema.Number,
	}),
]);
export type SessionCommand = typeof SessionCommand.Type;
