import { Schema } from "effect";

export const ChatEvent = Schema.Union([
	Schema.TaggedStruct("ChatCreated", {
		chatId: Schema.String,
		projectId: Schema.String,
		worktreeId: Schema.NullOr(Schema.String),
		title: Schema.String,
		originSessionId: Schema.NullOr(Schema.String),
		lastReadAt: Schema.NullOr(Schema.Number),
		createdAt: Schema.Number,
	}),
	Schema.TaggedStruct("ChatRenamed", {
		title: Schema.String,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ChatRead", { readAt: Schema.Number }),
	Schema.TaggedStruct("ChatWorktreeSet", {
		worktreeId: Schema.NullOr(Schema.String),
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ChatActiveSessionSet", {
		sessionId: Schema.String,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ChatArchiveRequested", {
		force: Schema.Boolean,
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ChatArchived", {
		archivedAt: Schema.Number,
		archivedWorktreeJson: Schema.NullOr(Schema.String),
	}),
	Schema.TaggedStruct("ChatUnarchived", {
		unarchivedAt: Schema.Number,
		worktreeId: Schema.NullOr(Schema.String),
	}),
	Schema.TaggedStruct("ChatDeleted", { deletedAt: Schema.Number }),
]);
export type ChatEvent = typeof ChatEvent.Type;
