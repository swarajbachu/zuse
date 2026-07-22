import { Schema } from "effect";
import { SessionCreatedFields } from "./session-fields.js";

export const SegmentKind = Schema.Literals(["assistant", "reasoning", "tool"]);
export type SegmentKind = typeof SegmentKind.Type;

export const SettlementOutcome = Schema.Literals([
	"completed",
	"interrupted",
	"error",
]);
export type SettlementOutcome = typeof SettlementOutcome.Type;

export const TurnPhase = Schema.Literals([
	"running",
	"interrupt-requested",
	"interrupt-acknowledged",
]);
export type TurnPhase = typeof TurnPhase.Type;

export const SessionCommand = Schema.Union([
	Schema.TaggedStruct("CreateSession", {
		...SessionCreatedFields,
		providerStartJson: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("CreateSessionWithInitialTurn", {
		...SessionCreatedFields,
		providerStartJson: Schema.String,
		turnId: Schema.String,
		messageId: Schema.String,
		messageContentJson: Schema.String,
	}),
	Schema.TaggedStruct("SetTitle", {
		title: Schema.String,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetModel", {
		model: Schema.String,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetProvider", {
		providerId: Schema.String,
		model: Schema.String,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetRuntimeMode", {
		runtimeMode: SessionCreatedFields.runtimeMode,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetPermissionMode", {
		permissionMode: SessionCreatedFields.permissionMode,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetWorktree", {
		worktreeId: SessionCreatedFields.worktreeId,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetStatus", {
		status: SessionCreatedFields.status,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetQueuePaused", {
		paused: Schema.Boolean,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetResume", {
		cursor: SessionCreatedFields.cursor,
		resumeStrategy: SessionCreatedFields.resumeStrategy,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ArchiveSession", { archivedAt: Schema.Number }),
	Schema.TaggedStruct("UnarchiveSession", { unarchivedAt: Schema.Number }),
	Schema.TaggedStruct("DeleteSession", { deletedAt: Schema.Number }),
	Schema.TaggedStruct("StartTurn", {
		turnId: Schema.String,
		startedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SubmitTurn", {
		turnId: Schema.String,
		messageId: Schema.String,
		role: Schema.String,
		kind: Schema.String,
		contentJson: Schema.String,
		parentItemId: Schema.NullOr(Schema.String),
		providerInputJson: Schema.String,
		createdAt: Schema.Number,
	}),
	Schema.TaggedStruct("SettleTurn", {
		turnId: Schema.String,
		outcome: SettlementOutcome,
		settledAt: Schema.Number,
	}),
	Schema.TaggedStruct("RequestTurnInterrupt", {
		turnId: Schema.String,
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("AcknowledgeTurnInterrupt", {
		turnId: Schema.String,
		acknowledgedAt: Schema.Number,
	}),
	Schema.TaggedStruct("FailTurnInterrupt", {
		turnId: Schema.String,
		reason: Schema.String,
		failedAt: Schema.Number,
	}),
	Schema.TaggedStruct("EnqueueTurn", {
		queueId: Schema.String,
		inputJson: Schema.String,
		position: Schema.Number,
		createdAt: Schema.Number,
		ready: Schema.Boolean,
	}),
	Schema.TaggedStruct("UpdateQueuedTurn", {
		queueId: Schema.String,
		inputJson: Schema.String,
		updatedAt: Schema.Number,
		ready: Schema.Boolean,
	}),
	Schema.TaggedStruct("ClaimQueuedTurn", {
		queueId: Schema.String,
		claimedAt: Schema.Number,
	}),
	Schema.TaggedStruct("RemoveQueuedTurn", {
		queueId: Schema.String,
		removedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ReorderQueuedTurns", {
		queueIds: Schema.Array(Schema.String),
		reorderedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SteerQueuedTurn", {
		expectedTurnId: Schema.String,
		queueId: Schema.String,
		successorTurnId: Schema.String,
		requestedAt: Schema.Number,
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
		decisionJson: Schema.optional(Schema.String),
		resolvedAt: Schema.Number,
	}),
	Schema.TaggedStruct("AttachProvider", {
		providerId: Schema.String,
		attachedAt: Schema.Number,
	}),
	Schema.TaggedStruct("RequestProviderStop", { requestedAt: Schema.Number }),
	Schema.TaggedStruct("DetachProvider", { detachedAt: Schema.Number }),
]);
export type SessionCommand = typeof SessionCommand.Type;
