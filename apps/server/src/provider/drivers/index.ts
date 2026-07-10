import type { Effect, Stream } from "effect";

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
 * Static descriptor every driver provides — the registry uses these to render
 * the launcher menu before any session has been started. `create` is invoked
 * lazily when a session is opened so we don't pay SDK init cost at boot.
 */
export interface ProviderDriver {
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly cliBinary: string;
  readonly create: () => Effect.Effect<ProviderDriverInstance, ProviderAdapterError>;
}

/**
 * What a driver instance must expose. SDK adapters (PR 5/6) implement this;
 * spawn-CLI is not a driver — it's a special PTY launch handled in
 * `provider/spawn.ts`.
 */
export interface ProviderDriverInstance {
  readonly start: (
    input: StartSessionInput,
  ) => Effect.Effect<
    {
      readonly sessionId: AgentSessionId;
      readonly events: Stream.Stream<AgentEvent, AgentSessionStartError>;
    },
    AgentSessionStartError
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
