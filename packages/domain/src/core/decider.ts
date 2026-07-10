import { Result, Schema } from "effect";

import type { SessionCommand } from "./commands.js";
import type { SessionEvent } from "./events.js";
import type { SessionState } from "./state.js";

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()(
	"SessionNotFound",
	{},
) {}
export class SessionAlreadyExists extends Schema.TaggedErrorClass<SessionAlreadyExists>()(
	"SessionAlreadyExists",
	{},
) {}
export class SessionDeletedConflict extends Schema.TaggedErrorClass<SessionDeletedConflict>()(
	"SessionDeletedConflict",
	{},
) {}
export class ValidationFailed extends Schema.TaggedErrorClass<ValidationFailed>()(
	"ValidationFailed",
	{ message: Schema.String },
) {}
export class TurnAlreadyRunning extends Schema.TaggedErrorClass<TurnAlreadyRunning>()(
	"TurnAlreadyRunning",
	{ turnId: Schema.String },
) {}
export class TurnNotRunning extends Schema.TaggedErrorClass<TurnNotRunning>()(
	"TurnNotRunning",
	{ turnId: Schema.String },
) {}
export class SegmentNotOpen extends Schema.TaggedErrorClass<SegmentNotOpen>()(
	"SegmentNotOpen",
	{ segmentId: Schema.String },
) {}
export class PermissionNotPending extends Schema.TaggedErrorClass<PermissionNotPending>()(
	"PermissionNotPending",
	{ requestId: Schema.String },
) {}

export type DomainError =
	| SessionNotFound
	| SessionAlreadyExists
	| SessionDeletedConflict
	| ValidationFailed
	| TurnAlreadyRunning
	| TurnNotRunning
	| SegmentNotOpen
	| PermissionNotPending;

const success = (events: readonly SessionEvent[]) => Result.succeed(events);

export const decide = (
	state: SessionState,
	command: SessionCommand,
): Result.Result<readonly SessionEvent[], DomainError> => {
	if (command._tag === "CreateSession") {
		return state.exists
			? Result.fail(new SessionAlreadyExists())
			: success([{ ...command, _tag: "SessionCreated" }]);
	}
	if (!state.exists) return Result.fail(new SessionNotFound());
	if (state.deleted) return Result.fail(new SessionDeletedConflict());

	switch (command._tag) {
		case "SetTitle": {
			const title = command.title.trim();
			if (title.length === 0) {
				return Result.fail(
					new ValidationFailed({ message: "title cannot be empty" }),
				);
			}
			return state.title === title
				? success([])
				: success([{ _tag: "SessionTitleSet", title }]);
		}
		case "ArchiveSession":
			return state.archived
				? success([])
				: success([
						{ _tag: "SessionArchived", archivedAt: command.archivedAt },
					]);
		case "DeleteSession":
			return success([
				{ _tag: "SessionDeleted", deletedAt: command.deletedAt },
			]);
		case "StartTurn":
			return state.currentTurnId === null
				? success([
						{
							_tag: "TurnStarted",
							turnId: command.turnId,
							startedAt: command.startedAt,
						},
					])
				: Result.fail(new TurnAlreadyRunning({ turnId: state.currentTurnId }));
		case "SettleTurn": {
			if (state.currentTurnId !== command.turnId) {
				return Result.fail(new TurnNotRunning({ turnId: command.turnId }));
			}
			const events: SessionEvent[] = [];
			for (const [segmentId, segment] of state.openSegments) {
				if (segment.turnId !== command.turnId) continue;
				events.push({
					_tag: "SegmentSettled",
					turnId: command.turnId,
					segmentId,
					outcome: command.outcome,
					settledAt: command.settledAt,
				});
			}
			events.push({
				_tag: "TurnSettled",
				turnId: command.turnId,
				outcome: command.outcome,
				settledAt: command.settledAt,
			});
			return success(events);
		}
		case "PersistMessage":
			return state.messageIds.has(command.messageId)
				? success([])
				: success([{ ...command, _tag: "MessagePersisted" }]);
		case "OpenSegment":
			if (state.currentTurnId !== command.turnId) {
				return Result.fail(new TurnNotRunning({ turnId: command.turnId }));
			}
			return state.openSegments.has(command.segmentId)
				? success([])
				: success([{ ...command, _tag: "SegmentOpened" }]);
		case "SettleSegment": {
			const segment = state.openSegments.get(command.segmentId);
			return segment?.turnId === command.turnId
				? success([{ ...command, _tag: "SegmentSettled" }])
				: Result.fail(new SegmentNotOpen({ segmentId: command.segmentId }));
		}
		case "RequestPermission":
			return state.pendingPermissionIds.has(command.requestId)
				? success([])
				: success([{ ...command, _tag: "PermissionRequested" }]);
		case "ResolvePermission":
			return state.pendingPermissionIds.has(command.requestId)
				? success([{ ...command, _tag: "PermissionResolved" }])
				: Result.fail(
						new PermissionNotPending({ requestId: command.requestId }),
					);
		case "AttachProvider":
			if (state.providerId === command.providerId) return success([]);
			return success([
				...(state.providerId === null
					? []
					: [
							{
								_tag: "ProviderDetached" as const,
								providerId: state.providerId,
								detachedAt: command.attachedAt,
							},
						]),
				{ ...command, _tag: "ProviderAttached" },
			]);
		case "DetachProvider":
			return state.providerId === null
				? success([])
				: success([
						{
							_tag: "ProviderDetached",
							providerId: state.providerId,
							detachedAt: command.detachedAt,
						},
					]);
		case "RecordCheckpoint":
			return state.checkpointIds.has(command.checkpointId)
				? success([])
				: success([{ ...command, _tag: "CheckpointRecorded" }]);
		case "RequestWorktreeArchive":
			return state.archiveWorktreeIds.has(command.worktreeId)
				? success([])
				: success([{ ...command, _tag: "WorktreeArchiveRequested" }]);
	}
};
