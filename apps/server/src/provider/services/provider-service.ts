import type { SessionTools } from "@zuse/agents/kernel/provider-mcp-session";
import type {
	AgentAvailability,
	AgentItemId,
	AgentSessionId,
	AgentSessionNotFoundError,
	AgentSessionStartError,
	AgentTurnId,
	AttachmentRef,
	CredentialSetResult,
	CredentialValidationError,
	FileRef,
	NativeHistoryCheckpoint,
	PermissionMode,
	PlanApprovalOutcome,
	ProviderId,
	ProviderNotAvailableError,
	QuestionAttachmentChange,
	RuntimeMode,
	SkillRef,
	StartSessionInput,
	ThreadGoal,
	ThreadGoalSetInput,
	UserQuestionAnswer,
} from "@zuse/contracts";
import { Context, type Effect, type Stream } from "effect";
import type { CredentialsError } from "../errors.ts";
import type { ProviderEventDelivery } from "../provider-event-delivery.ts";
import type { GoalCurrentCheck, GoalPublication } from "../provider-goal.ts";

/**
 * Live-read of the per-session runtime mode. Bound at start time and read by
 * the driver each time the SDK invokes `canUseTool`, so a renderer toggle
 * mid-session takes effect on the next tool call.
 */
export type GetRuntimeMode = () => RuntimeMode;

/**
 * Provider-process service used by the conversation runtime. Public RPCs bind
 * to session operations; those operations use this service to manage the
 * corresponding provider handle and event stream.
 */
export interface ProviderServiceShape {
	readonly availability: (
		refresh?: boolean,
	) => Effect.Effect<ReadonlyArray<AgentAvailability>>;

	readonly start: (
		input: StartSessionInput,
		resumeCursor?: string | null,
		getRuntimeMode?: GetRuntimeMode,
		/**
		 * Session-bound tools. `ConversationServices` passes orchestration when
		 * autonomy is enabled; server features pass their own toolsets (a review
		 * guide run). Drivers expose them through their native MCP path (Claude
		 * SDK, Codex app-server, Grok ACP) without duplicating the operations.
		 */
		sessionTools?: SessionTools | null,
		providerEventCursor?: string | null,
		/** Checked inside lifecycle serialization before replacing any handle. */
		admit?: Effect.Effect<boolean>,
		/** Durable identity reserved by the conversation runtime before acquisition. */
		providerSessionId?: string,
	) => Effect.Effect<
		{
			readonly sessionId: AgentSessionId;
			/** Ownership generation for guarded post-start publication. */
			readonly generation?: number;
			/** Unique live process residency; never reused after replacement or restart. */
			readonly providerSessionId?: string;
			/** The process started, but a newer lifecycle command invalidated it. */
			readonly superseded?: boolean;
			readonly nativeResumeFallback?: boolean;
		},
		ProviderNotAvailableError | AgentSessionStartError
	>;
	readonly hasSession: (
		sessionId: AgentSessionId,
		expectedProviderSessionId?: string,
	) => Effect.Effect<boolean>;
	/** Sessions with a live handle for this provider. */
	readonly liveSessions: (
		providerId: ProviderId,
	) => Effect.Effect<ReadonlyArray<AgentSessionId>>;
	/** Stop and verify quiescence before filesystem rollback; failed handles remain owned. */
	readonly quiesce?: (
		sessionId: AgentSessionId,
		expectedProviderSessionId?: string | null,
	) => Effect.Effect<void, Error>;
	readonly captureHistoryCheckpoint?: (
		sessionId: AgentSessionId,
	) => Effect.Effect<NativeHistoryCheckpoint | null, Error>;
	readonly restoreHistoryCheckpoint?: (
		sessionId: AgentSessionId,
		checkpoint: NativeHistoryCheckpoint,
	) => Effect.Effect<boolean, Error>;
	readonly guardCurrent: <E, R>(
		sessionId: AgentSessionId,
		generation: number,
		effect: Effect.Effect<void, E, R>,
	) => Effect.Effect<boolean, E, R>;

	readonly send: (
		sessionId: AgentSessionId,
		turnId: AgentTurnId,
		text: string,
		attachments?: ReadonlyArray<AttachmentRef>,
		fileRefs?: ReadonlyArray<FileRef>,
		skillRefs?: ReadonlyArray<SkillRef>,
		attemptId?: import("@zuse/contracts").AttemptId,
		goal?: ThreadGoalSetInput,
	) => Effect.Effect<void, AgentSessionNotFoundError>;

	readonly stopBackgroundTask?: (
		sessionId: AgentSessionId,
		turnId: AgentTurnId,
		attemptId: import("@zuse/contracts").AttemptId,
		taskId: string,
	) => Effect.Effect<void, AgentSessionNotFoundError | Error>;

	readonly interrupt: (
		sessionId: AgentSessionId,
		turnId: AgentTurnId,
		attemptId?: import("@zuse/contracts").AttemptId,
	) => Effect.Effect<void, AgentSessionNotFoundError>;

	readonly close: (
		sessionId: AgentSessionId,
		ownership?: import("@zuse/contracts").ProviderAttemptOwnership,
		/** null matches historical handles only; undefined is an administrative close. */
		expectedProviderSessionId?: string | null,
	) => Effect.Effect<void, AgentSessionNotFoundError>;

	readonly events: (
		sessionId: AgentSessionId,
	) => Stream.Stream<ProviderEventDelivery, AgentSessionNotFoundError>;

	readonly setCredential: (
		providerId: ProviderId,
		apiKey: string,
	) => Effect.Effect<
		CredentialSetResult,
		CredentialsError | CredentialValidationError
	>;

	readonly removeCredential: (
		providerId: ProviderId,
	) => Effect.Effect<void, CredentialsError>;

	/**
	 * Switch the SDK lifecycle mode on a live session. Claude only — Codex
	 * sessions accept the call but no-op.
	 */
	readonly setPermissionMode: (
		sessionId: AgentSessionId,
		mode: PermissionMode,
	) => Effect.Effect<void, AgentSessionNotFoundError>;

	/**
	 * Process-local authority for blocking question callbacks. Durable timeline
	 * rows survive a restart, but they are not actionable until the replacement
	 * provider emits the matching question and reattaches its callback.
	 */
	readonly questionAttachments: () => Stream.Stream<QuestionAttachmentChange>;
	readonly hasQuestionAttachment: (
		sessionId: AgentSessionId,
		itemId: AgentItemId,
	) => Effect.Effect<boolean>;
	readonly validateQuestionAnswer: (
		sessionId: AgentSessionId,
		itemId: AgentItemId,
		answers: ReadonlyArray<UserQuestionAnswer>,
	) => Effect.Effect<void, AgentSessionNotFoundError>;

	/** Resolve the exact pending in-process question callback by `itemId`. */
	readonly answerQuestion: (
		sessionId: AgentSessionId,
		itemId: AgentItemId,
		answers: ReadonlyArray<UserQuestionAnswer>,
	) => Effect.Effect<void, AgentSessionNotFoundError>;
	readonly cancelQuestion: (
		sessionId: AgentSessionId,
		itemId: AgentItemId,
	) => Effect.Effect<void, AgentSessionNotFoundError>;
	/** Remove callback actionability only after its durable answer receipt exists. */
	readonly acknowledgeQuestionResolution: (
		sessionId: AgentSessionId,
		itemId: AgentItemId,
	) => Effect.Effect<void>;

	readonly respondToPlan?: (
		sessionId: AgentSessionId,
		toolCallId: AgentItemId,
		outcome: PlanApprovalOutcome,
		feedback?: string,
	) => Effect.Effect<void, AgentSessionNotFoundError>;

	readonly acknowledgePlanResponse?: (
		sessionId: AgentSessionId,
		itemId: AgentItemId,
	) => Effect.Effect<void>;

	readonly getGoal: (
		sessionId: AgentSessionId,
		onResult?: GoalPublication<ThreadGoal | null>,
		verify?: GoalCurrentCheck,
	) => Effect.Effect<ThreadGoal | null, AgentSessionNotFoundError>;

	readonly setGoal: (
		sessionId: AgentSessionId,
		goal: ThreadGoalSetInput,
		onResult?: GoalPublication<ThreadGoal>,
		verify?: GoalCurrentCheck,
	) => Effect.Effect<ThreadGoal, AgentSessionNotFoundError>;

	readonly clearGoal: (
		sessionId: AgentSessionId,
		onResult?: GoalPublication<void>,
		verify?: GoalCurrentCheck,
	) => Effect.Effect<void, AgentSessionNotFoundError>;
}

export class ProviderService extends Context.Service<
	ProviderService,
	ProviderServiceShape
>()("memoize/ProviderService") {}
