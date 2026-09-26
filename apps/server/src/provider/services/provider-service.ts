import type { OrchestrationSessionTools } from "@zuse/agents/drivers/orchestration-tools";

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
	PermissionMode,
	PlanApprovalOutcome,
	ProviderEventEnvelope,
	ProviderId,
	ProviderNotAvailableError,
	QuestionAttachmentChange,
	RuntimeMode,
	SessionModeUnsupportedError,
	SessionOperationUnsupportedError,
	SkillRef,
	StartSessionInput,
	ThreadGoal,
	ThreadGoalSetInput,
	UserQuestionAnswer,
} from "@zuse/contracts";
import { Context, type Effect, type Stream } from "effect";
import type { CredentialsError } from "../errors.ts";

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
		 * Session-bound orchestration tools. `ConversationServices` owns the actual
		 * operations and passes this bundle when autonomy is enabled. Drivers
		 * expose it through their native MCP path (Claude SDK, Codex app-server,
		 * Grok ACP) without duplicating worktree/chat persistence logic.
		 */
		orchestrationTools?: OrchestrationSessionTools | null,
		providerEventCursor?: string | null,
	) => Effect.Effect<
		{
			readonly sessionId: AgentSessionId;
			/** Ownership generation for guarded post-start publication. */
			readonly generation?: number;
			/** The process started, but a newer lifecycle command invalidated it. */
			readonly superseded?: boolean;
		},
		ProviderNotAvailableError | AgentSessionStartError
	>;
	readonly hasSession: (sessionId: AgentSessionId) => Effect.Effect<boolean>;
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
	) => Effect.Effect<void, AgentSessionNotFoundError>;

	readonly interrupt: (
		sessionId: AgentSessionId,
		turnId: AgentTurnId,
	) => Effect.Effect<void, AgentSessionNotFoundError>;

	readonly close: (
		sessionId: AgentSessionId,
	) => Effect.Effect<void, AgentSessionNotFoundError>;

	readonly events: (
		sessionId: AgentSessionId,
	) => Stream.Stream<ProviderEventEnvelope, AgentSessionNotFoundError>;

	readonly acknowledgeProviderEventCursor?: (
		sessionId: AgentSessionId,
		cursor: string,
	) => Effect.Effect<void, AgentSessionNotFoundError>;
	readonly releaseProviderEventCursor?: (
		sessionId: AgentSessionId,
		cursor: string,
	) => Effect.Effect<void, AgentSessionNotFoundError>;
	readonly updateMcpServers?: (
		sessionId: AgentSessionId,
		servers: ReadonlyArray<unknown>,
	) => Effect.Effect<void, AgentSessionNotFoundError>;

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
	) => Effect.Effect<
		void,
		AgentSessionNotFoundError | SessionModeUnsupportedError
	>;

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
	) => Effect.Effect<
		void,
		AgentSessionNotFoundError | SessionOperationUnsupportedError
	>;
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

	readonly getGoal: (
		sessionId: AgentSessionId,
	) => Effect.Effect<ThreadGoal | null, AgentSessionNotFoundError>;

	readonly setGoal: (
		sessionId: AgentSessionId,
		goal: ThreadGoalSetInput,
	) => Effect.Effect<ThreadGoal, AgentSessionNotFoundError>;

	readonly clearGoal: (
		sessionId: AgentSessionId,
	) => Effect.Effect<void, AgentSessionNotFoundError>;
}

export class ProviderService extends Context.Service<
	ProviderService,
	ProviderServiceShape
>()("memoize/ProviderService") {}
