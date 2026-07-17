import type {
	AgentEvent,
	AgentItemId,
	AttachmentRef,
	FileRef,
	PermissionMode,
	PlanApprovalOutcome,
	SkillRef,
	ThreadGoal,
	ThreadGoalSetInput,
	UserQuestionAnswer,
} from "@zuse/contracts";
import type { Effect, Stream } from "effect";

/** Common live-session surface implemented by every provider driver. */
export interface ProviderSessionHandle {
	readonly events: Stream.Stream<AgentEvent>;
	readonly send: (
		text: string,
		attachments?: ReadonlyArray<AttachmentRef>,
		fileRefs?: ReadonlyArray<FileRef>,
		skillRefs?: ReadonlyArray<SkillRef>,
	) => Effect.Effect<void>;
	readonly interrupt: () => Effect.Effect<void>;
	readonly close: () => Effect.Effect<void>;
	readonly setPermissionMode: (mode: PermissionMode) => Effect.Effect<void>;
	readonly answerQuestion: (
		itemId: AgentItemId,
		answers: ReadonlyArray<UserQuestionAnswer>,
	) => Effect.Effect<void>;
	readonly respondToPlan?: (
		toolCallId: AgentItemId,
		outcome: PlanApprovalOutcome,
		feedback?: string,
	) => Effect.Effect<void>;
	readonly acknowledgeProviderEventCursor?: (
		cursor: string,
	) => Effect.Effect<void>;
	readonly releaseProviderEventCursor?: (cursor: string) => Effect.Effect<void>;
	readonly updateMcpServers?: (
		servers: ReadonlyArray<unknown>,
	) => Effect.Effect<void>;
}

/** Optional goal-mode extension currently implemented by two providers. */
export interface GoalCapableSessionHandle extends ProviderSessionHandle {
	readonly getGoal: () => Effect.Effect<ThreadGoal | null>;
	readonly setGoal: (goal: ThreadGoalSetInput) => Effect.Effect<ThreadGoal>;
	readonly clearGoal: () => Effect.Effect<void>;
}
