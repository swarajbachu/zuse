import { Schema } from "effect";
import { TitleProvenance } from "../naming.js";

export const ChatCommand = Schema.Union([
	Schema.TaggedStruct("CreateChat", {
		chatId: Schema.String,
		projectId: Schema.String,
		worktreeId: Schema.NullOr(Schema.String),
		title: Schema.String,
		titleProvenance: Schema.optionalKey(TitleProvenance),
		originSessionId: Schema.NullOr(Schema.String),
		lastReadAt: Schema.NullOr(Schema.Number),
		createdAt: Schema.Number,
	}),
	Schema.TaggedStruct("RenameChat", {
		title: Schema.String,
		titleProvenance: Schema.optionalKey(TitleProvenance),
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("MarkChatRead", { readAt: Schema.Number }),
	Schema.TaggedStruct("SetChatWorktree", {
		worktreeId: Schema.NullOr(Schema.String),
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetActiveSession", {
		sessionId: Schema.NullOr(Schema.String),
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("RequestArchiveChat", {
		requestedAt: Schema.Number,
		force: Schema.Boolean,
	}),
	Schema.TaggedStruct("ArchiveChat", {
		archivedAt: Schema.Number,
		archivedWorktreeJson: Schema.NullOr(Schema.String),
	}),
	Schema.TaggedStruct("UnarchiveChat", {
		unarchivedAt: Schema.Number,
		worktreeId: Schema.NullOr(Schema.String),
	}),
	Schema.TaggedStruct("RequestDeleteChat", { requestedAt: Schema.Number }),
	Schema.TaggedStruct("DeleteChat", { deletedAt: Schema.Number }),
]);
export type ChatCommand = typeof ChatCommand.Type;
