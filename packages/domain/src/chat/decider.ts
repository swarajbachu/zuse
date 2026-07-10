import { Result, Schema } from "effect";

import type { ChatCommand } from "./commands.js";
import type { ChatEvent } from "./events.js";
import type { ChatState } from "./state.js";

export class ChatNotFound extends Schema.TaggedErrorClass<ChatNotFound>()(
	"ChatNotFound",
	{},
) {}
export class ChatAlreadyExists extends Schema.TaggedErrorClass<ChatAlreadyExists>()(
	"ChatAlreadyExists",
	{},
) {}
export class ChatDeletedConflict extends Schema.TaggedErrorClass<ChatDeletedConflict>()(
	"ChatDeletedConflict",
	{},
) {}
export class ChatValidationFailed extends Schema.TaggedErrorClass<ChatValidationFailed>()(
	"ChatValidationFailed",
	{ message: Schema.String },
) {}

export type ChatDomainError =
	| ChatNotFound
	| ChatAlreadyExists
	| ChatDeletedConflict
	| ChatValidationFailed;

const success = (events: readonly ChatEvent[]) => Result.succeed(events);

export const decideChat = (
	state: ChatState,
	command: ChatCommand,
): Result.Result<readonly ChatEvent[], ChatDomainError> => {
	if (command._tag === "CreateChat") {
		const title = command.title.trim();
		if (title.length === 0) {
			return Result.fail(
				new ChatValidationFailed({ message: "title cannot be empty" }),
			);
		}
		return state.exists
			? Result.fail(new ChatAlreadyExists())
			: success([{ ...command, title, _tag: "ChatCreated" }]);
	}
	if (!state.exists) return Result.fail(new ChatNotFound());
	if (state.deleted) return Result.fail(new ChatDeletedConflict());

	switch (command._tag) {
		case "RenameChat": {
			const title = command.title.trim();
			if (title.length === 0) {
				return Result.fail(
					new ChatValidationFailed({ message: "title cannot be empty" }),
				);
			}
			return state.title === title
				? success([])
				: success([{ ...command, title, _tag: "ChatRenamed" }]);
		}
		case "MarkChatRead":
			return state.lastReadAt === command.readAt
				? success([])
				: success([{ ...command, _tag: "ChatRead" }]);
		case "SetChatWorktree":
			return state.worktreeId === command.worktreeId
				? success([])
				: success([{ ...command, _tag: "ChatWorktreeSet" }]);
		case "SetActiveSession":
			return state.activeSessionId === command.sessionId
				? success([])
				: success([{ ...command, _tag: "ChatActiveSessionSet" }]);
		case "RequestArchiveChat":
			return state.archived || state.archiveRequested
				? success([])
				: success([{ ...command, _tag: "ChatArchiveRequested" }]);
		case "ArchiveChat":
			return state.archived
				? success([])
				: success([{ ...command, _tag: "ChatArchived" }]);
		case "UnarchiveChat":
			return state.archived
				? success([{ ...command, _tag: "ChatUnarchived" }])
				: success([]);
		case "DeleteChat":
			return success([{ ...command, _tag: "ChatDeleted" }]);
	}
};
