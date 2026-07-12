import { Context, type Effect, type Stream } from "effect";

import type {
  AgentEvent,
  AgentSessionId,
  AgentSessionNotFoundError,
  AgentSessionStartError,
  AgentTurnId,
  ProviderId,
  StartSessionInput,
} from "@zuse/contracts";

import type { ProviderAdapterError } from "../errors.ts";

/**
 * Per-provider live binding. The registry looks one of these up by
 * `providerId` and delegates session lifecycle to it. SDK adapters (Claude,
 * Codex) provide a Layer that contributes a `ProviderAdapter` keyed by their
 * `providerId`.
 */
export interface ProviderAdapterShape {
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly start: (
    input: StartSessionInput,
  ) => Effect.Effect<
    {
      readonly sessionId: AgentSessionId;
      readonly events: Stream.Stream<AgentEvent, AgentSessionStartError>;
    },
    AgentSessionStartError | ProviderAdapterError
  >;
  readonly send: (
    sessionId: AgentSessionId,
    text: string,
  ) => Effect.Effect<void, AgentSessionNotFoundError>;
  readonly interrupt: (
    sessionId: AgentSessionId,
    turnId?: AgentTurnId,
  ) => Effect.Effect<void, AgentSessionNotFoundError>;
  readonly close: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<void, AgentSessionNotFoundError>;
}

export class ProviderAdapter extends Context.Service<
  ProviderAdapter,
  ProviderAdapterShape
>()("memoize/ProviderAdapter") {}
