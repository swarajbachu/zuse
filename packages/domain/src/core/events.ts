import { Schema } from "effect";

import { SegmentKind, SettlementOutcome } from "./commands.js";
import {
	SessionConfigurationFields,
	SessionCreatedEventFields,
} from "./session-fields.js";

export const SessionEvent = Schema.Union([
	Schema.TaggedStruct("SessionCreated", {
		...SessionCreatedEventFields,
		providerStartJson: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("SessionTitleSet", {
		title: Schema.String,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionModelSet", {
		model: Schema.String,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionProviderSet", {
		providerId: Schema.String,
		model: Schema.String,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionRuntimeModeSet", {
		runtimeMode: SessionConfigurationFields.runtimeMode,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionPermissionModeSet", {
		permissionMode: SessionConfigurationFields.permissionMode,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionWorktreeSet", {
		worktreeId: SessionConfigurationFields.worktreeId,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionStatusSet", {
		status: SessionConfigurationFields.status,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionResumeSet", {
		cursor: SessionConfigurationFields.cursor,
		resumeStrategy: SessionConfigurationFields.resumeStrategy,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionArchived", { archivedAt: Schema.Number }),
	Schema.TaggedStruct("SessionUnarchived", { unarchivedAt: Schema.Number }),
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
		decisionJson: Schema.optional(Schema.String),
		resolvedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ProviderAttached", {
		providerId: Schema.String,
		attachedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ProviderStopRequested", {
		providerId: Schema.String,
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ProviderDetached", {
		providerId: Schema.String,
		detachedAt: Schema.Number,
	}),
]);
export type SessionEvent = typeof SessionEvent.Type;
