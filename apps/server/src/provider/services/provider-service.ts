import { Context, type Effect, type Stream } from "effect";

import type {
  AgentAvailability,
  AgentEvent,
  AgentItemId,
  AgentSessionId,
  AgentSessionNotFoundError,
  AgentSessionStartError,
  AgentTurnId,
  AttachmentRef,
  FileRef,
  PermissionMode,
  ProviderId,
  ProviderNotAvailableError,
  RuntimeMode,
  SkillRef,
  StartSessionInput,
  ThreadGoal,
  ThreadGoalSetInput,
  UserQuestionAnswer,
} from "@zuse/wire";

import type { CredentialsError } from "../errors.ts";

/**
 * Live-read of the per-session runtime mode. Bound at start time and read by
 * the driver each time the SDK invokes `canUseTool`, so a renderer toggle
 * mid-session takes effect on the next tool call.
 */
export type GetRuntimeMode = () => RuntimeMode;

/**
 * Public-facing service that the RPC handlers bind to. Every wire RPC
 * (`agent.availability`, `agent.start`, `agent.send`, …) maps to one method
 * here. The live impl (PR 5+) composes `ProviderRegistry`, `Credentials`, and
 * the spawn-CLI helper to satisfy these.
 */
export interface ProviderServiceShape {
  readonly availability: () => Effect.Effect<ReadonlyArray<AgentAvailability>>;

  readonly start: (
    input: StartSessionInput,
    resumeCursor?: string | null,
    getRuntimeMode?: GetRuntimeMode,
    /**
     * Extra in-process Claude-SDK tool definitions to register in the
     * `memoize` MCP server for this session, alongside the built-in index
     * and browser tools. In-process only (not part of the wire
     * `StartSessionInput`) — `MessageStore` passes the control-plane
     * orchestration tools here when the session's autonomy level is not
     * `"off"`. Ignored by non-Claude drivers. Typed loosely because SDK
     * tool objects aren't part of the wire schema.
     */
    extraTools?: ReadonlyArray<unknown>,
  ) => Effect.Effect<
    { readonly sessionId: AgentSessionId },
    ProviderNotAvailableError | AgentSessionStartError
  >;

  readonly send: (
    sessionId: AgentSessionId,
    text: string,
    attachments?: ReadonlyArray<AttachmentRef>,
    fileRefs?: ReadonlyArray<FileRef>,
    skillRefs?: ReadonlyArray<SkillRef>,
  ) => Effect.Effect<void, AgentSessionNotFoundError>;

  readonly interrupt: (
    sessionId: AgentSessionId,
    turnId?: AgentTurnId,
  ) => Effect.Effect<void, AgentSessionNotFoundError>;

  readonly close: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<void, AgentSessionNotFoundError>;

  readonly events: (
    sessionId: AgentSessionId,
  ) => Stream.Stream<AgentEvent, AgentSessionNotFoundError>;

  readonly setCredential: (
    providerId: ProviderId,
    apiKey: string,
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
   * Resolve the pending in-process AskUserQuestion call identified by
   * `itemId`. Claude only — Codex sessions accept the call but no-op.
   */
  readonly answerQuestion: (
    sessionId: AgentSessionId,
    itemId: AgentItemId,
    answers: ReadonlyArray<UserQuestionAnswer>,
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

export class ProviderService extends Context.Tag("memoize/ProviderService")<
  ProviderService,
  ProviderServiceShape
>() {}
