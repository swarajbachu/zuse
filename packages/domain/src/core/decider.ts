import { Result, Schema } from "effect";
import { titleProvenanceOrManual } from "../naming.js";
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
export class TurnConflict extends Schema.TaggedErrorClass<TurnConflict>()(
	"TurnConflict",
	{ expectedTurnId: Schema.String, actualTurnId: Schema.NullOr(Schema.String) },
) {}
export class QueuedTurnNotFound extends Schema.TaggedErrorClass<QueuedTurnNotFound>()(
	"QueuedTurnNotFound",
	{ queueId: Schema.String },
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
	| TurnConflict
	| QueuedTurnNotFound
	| SegmentNotOpen
	| PermissionNotPending;

const success = (events: readonly SessionEvent[]) => Result.succeed(events);

export const decide = (
	state: SessionState,
	command: SessionCommand,
): Result.Result<readonly SessionEvent[], DomainError> => {
	if (command._tag === "CreateSession") {
		const titleProvenance = titleProvenanceOrManual(command.titleProvenance);
		return state.exists
			? Result.fail(new SessionAlreadyExists())
			: success([{ ...command, titleProvenance, _tag: "SessionCreated" }]);
	}
	if (command._tag === "CreateSessionWithInitialTurn") {
		if (state.exists) return Result.fail(new SessionAlreadyExists());
		const { turnId, messageId, messageContentJson, ...created } = command;
		return success([
			{
				...created,
				_tag: "SessionCreated",
			},
			{
				_tag: "MessagePersisted",
				messageId: command.messageId,
				turnId: command.turnId,
				role: "user",
				kind: "user",
				contentJson: command.messageContentJson,
				parentItemId: null,
				createdAt: command.createdAt,
			},
			{
				_tag: "TurnStarted",
				turnId: command.turnId,
				startedAt: command.createdAt,
			},
		]);
	}
	if (!state.exists) return Result.fail(new SessionNotFound());
	if (state.deleted) return Result.fail(new SessionDeletedConflict());

	switch (command._tag) {
		case "SetTitle": {
			const title = command.title.trim();
			const titleProvenance = titleProvenanceOrManual(command.titleProvenance);
			if (title.length === 0) {
				return Result.fail(
					new ValidationFailed({ message: "title cannot be empty" }),
				);
			}
			if (
				titleProvenance === "automatic" &&
				state.titleProvenance !== "pending"
			) {
				return success([]);
			}
			return state.title === title && state.titleProvenance === titleProvenance
				? success([])
				: success([
						{
							_tag: "SessionTitleSet",
							title,
							titleProvenance,
							updatedAt: command.updatedAt,
						},
					]);
		}
		case "SetModel":
			return state.model === command.model
				? success([])
				: success([{ ...command, _tag: "SessionModelSet" }]);
		case "SetProvider":
			return state.providerId === command.providerId &&
				state.model === command.model
				? success([])
				: success([{ ...command, _tag: "SessionProviderSet" }]);
		case "SetRuntimeMode":
			return state.runtimeMode === command.runtimeMode
				? success([])
				: success([{ ...command, _tag: "SessionRuntimeModeSet" }]);
		case "SetPermissionMode":
			return state.permissionMode === command.permissionMode
				? success([])
				: success([{ ...command, _tag: "SessionPermissionModeSet" }]);
		case "SetWorktree":
			return state.worktreeId === command.worktreeId
				? success([])
				: success([{ ...command, _tag: "SessionWorktreeSet" }]);
		case "SetStatus":
			return state.status === command.status
				? success([])
				: success([{ ...command, _tag: "SessionStatusSet" }]);
		case "SetQueuePaused":
			return state.queuePaused === command.paused
				? success([])
				: success([{ ...command, _tag: "SessionQueuePausedSet" }]);
		case "SetResume":
			return state.cursor === command.cursor &&
				state.resumeStrategy === command.resumeStrategy
				? success([])
				: success([{ ...command, _tag: "SessionResumeSet" }]);
		case "ArchiveSession":
			return state.archived
				? success([])
				: success([
						{ _tag: "SessionArchived", archivedAt: command.archivedAt },
					]);
		case "UnarchiveSession":
			return state.archived
				? success([
						{
							_tag: "SessionUnarchived",
							unarchivedAt: command.unarchivedAt,
						},
					])
				: success([]);
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
				if (state.settledTurnIds.has(command.turnId)) return success([]);
				return Result.fail(
					new TurnConflict({
						expectedTurnId: command.turnId,
						actualTurnId: state.currentTurnId,
					}),
				);
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
			events.push({
				_tag: "SessionStatusSet",
				status:
					state.scheduledSuccessor?.predecessorTurnId === command.turnId
						? "running"
						: command.outcome === "error"
							? "error"
							: "idle",
				updatedAt: command.settledAt,
			});
			if (state.scheduledSuccessor?.predecessorTurnId === command.turnId) {
				events.push({
					_tag: "ScheduledSuccessorReady",
					...state.scheduledSuccessor,
					readyAt: command.settledAt,
				});
			}
			return success(events);
		}
		case "RequestTurnInterrupt":
			if (state.currentTurnId !== command.turnId) {
				if (state.settledTurnIds.has(command.turnId)) return success([]);
				return Result.fail(
					new TurnConflict({
						expectedTurnId: command.turnId,
						actualTurnId: state.currentTurnId,
					}),
				);
			}
			return state.currentTurnPhase === "interrupt-requested" ||
				state.currentTurnPhase === "interrupt-acknowledged"
				? success([])
				: success([{ ...command, _tag: "TurnInterruptRequested" }]);
		case "AcknowledgeTurnInterrupt":
			if (state.currentTurnId !== command.turnId) {
				return Result.fail(
					new TurnConflict({
						expectedTurnId: command.turnId,
						actualTurnId: state.currentTurnId,
					}),
				);
			}
			return state.currentTurnPhase === "interrupt-acknowledged"
				? success([])
				: success([{ ...command, _tag: "TurnInterruptAcknowledged" }]);
		case "FailTurnInterrupt":
			return state.currentTurnId === command.turnId
				? success([{ ...command, _tag: "TurnInterruptFailed" }])
				: Result.fail(
						new TurnConflict({
							expectedTurnId: command.turnId,
							actualTurnId: state.currentTurnId,
						}),
					);
		case "EnqueueTurn":
			return state.queuedTurns.has(command.queueId)
				? success([])
				: success([{ ...command, _tag: "QueuedTurnEnqueued" }]);
		case "UpdateQueuedTurn":
			return state.queuedTurns.has(command.queueId)
				? success([{ ...command, _tag: "QueuedTurnUpdated" }])
				: Result.fail(new QueuedTurnNotFound({ queueId: command.queueId }));
		case "ClaimQueuedTurn": {
			const queued = state.queuedTurns.get(command.queueId);
			return queued?.ready === true
				? success([
						{
							_tag: "QueuedTurnClaimed",
							queueId: command.queueId,
							claimedAt: command.claimedAt,
						},
					])
				: success([]);
		}
		case "RemoveQueuedTurn":
			return state.queuedTurns.has(command.queueId)
				? success([{ ...command, _tag: "QueuedTurnRemoved" }])
				: success([]);
		case "ReorderQueuedTurns": {
			const known = command.queueIds.filter((id) => state.queuedTurns.has(id));
			const remaining = state.queueOrder.filter((id) => !known.includes(id));
			return success([
				{
					_tag: "QueuedTurnsReordered",
					queueIds: [...known, ...remaining],
					reorderedAt: command.reorderedAt,
				},
			]);
		}
		case "SubmitTurn":
			if (state.currentTurnId !== null) {
				return Result.fail(
					new TurnAlreadyRunning({ turnId: state.currentTurnId }),
				);
			}
			return success([
				{
					_tag: "MessagePersisted",
					messageId: command.messageId,
					turnId: command.turnId,
					role: command.role,
					kind: command.kind,
					contentJson: command.contentJson,
					parentItemId: command.parentItemId,
					createdAt: command.createdAt,
				},
				{
					_tag: "TurnStarted",
					turnId: command.turnId,
					startedAt: command.createdAt,
				},
				{
					_tag: "SessionStatusSet",
					status: "running",
					updatedAt: command.createdAt,
				},
				{
					_tag: "ProviderTurnRequested",
					turnId: command.turnId,
					providerInputJson: command.providerInputJson,
					requestedAt: command.createdAt,
				},
			]);
		case "SteerQueuedTurn": {
			if (state.currentTurnId !== command.expectedTurnId) {
				if (
					state.currentTurnId === null &&
					state.settledTurnIds.has(command.expectedTurnId)
				) {
					const queued = state.queuedTurns.get(command.queueId);
					if (queued === undefined) {
						return Result.fail(
							new QueuedTurnNotFound({ queueId: command.queueId }),
						);
					}
					return success([
						{
							_tag: "QueuedTurnClaimed",
							queueId: command.queueId,
							claimedAt: command.requestedAt,
						},
						{
							_tag: "SuccessorTurnScheduled",
							predecessorTurnId: command.expectedTurnId,
							turnId: command.successorTurnId,
							queueId: command.queueId,
							inputJson: queued.inputJson,
							scheduledAt: command.requestedAt,
						},
						{
							_tag: "ScheduledSuccessorReady",
							predecessorTurnId: command.expectedTurnId,
							turnId: command.successorTurnId,
							queueId: command.queueId,
							inputJson: queued.inputJson,
							readyAt: command.requestedAt,
						},
					]);
				}
				return Result.fail(
					new TurnConflict({
						expectedTurnId: command.expectedTurnId,
						actualTurnId: state.currentTurnId,
					}),
				);
			}
			const queued = state.queuedTurns.get(command.queueId);
			if (queued === undefined) {
				return Result.fail(
					new QueuedTurnNotFound({ queueId: command.queueId }),
				);
			}
			return success([
				{
					_tag: "QueuedTurnClaimed",
					queueId: command.queueId,
					claimedAt: command.requestedAt,
				},
				...(state.currentTurnPhase === "interrupt-requested" ||
				state.currentTurnPhase === "interrupt-acknowledged"
					? []
					: [
							{
								_tag: "TurnInterruptRequested" as const,
								turnId: command.expectedTurnId,
								requestedAt: command.requestedAt,
							},
						]),
				{
					_tag: "SuccessorTurnScheduled",
					predecessorTurnId: command.expectedTurnId,
					turnId: command.successorTurnId,
					queueId: command.queueId,
					inputJson: queued.inputJson,
					scheduledAt: command.requestedAt,
				},
			]);
		}
		case "PersistMessage":
			return success([{ ...command, _tag: "MessagePersisted" }]);
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
			if (state.attachedProviderId === command.providerId) return success([]);
			return success([
				...(state.attachedProviderId === null
					? []
					: [
							{
								_tag: "ProviderDetached" as const,
								providerId: state.attachedProviderId,
								detachedAt: command.attachedAt,
							},
						]),
				{ ...command, _tag: "ProviderAttached" },
			]);
		case "RequestProviderStop":
			return state.attachedProviderId === null
				? success([])
				: success([
						{
							_tag: "ProviderStopRequested",
							providerId: state.attachedProviderId,
							requestedAt: command.requestedAt,
						},
					]);
		case "DetachProvider":
			return state.attachedProviderId === null
				? success([])
				: success([
						{
							_tag: "ProviderDetached",
							providerId: state.attachedProviderId,
							detachedAt: command.detachedAt,
						},
					]);
	}
};
