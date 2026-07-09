import { Context, type Effect, type Stream } from "effect";

import type {
  FolderId,
  ProviderId,
  SessionId,
  SessionNotFoundError,
  Skill,
} from "@zuse/wire";

/**
 * Per-session skill listing, plus a live feed that re-emits the full list
 * when discovery refreshes. Mirrors `messages.stream` semantics so the
 * renderer wires through the same Fiber pattern.
 */
export interface SkillBridgeShape {
  readonly list: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Skill>, SessionNotFoundError>;

  readonly listForProject: (
    projectId: FolderId,
    providerId: ProviderId,
  ) => Effect.Effect<ReadonlyArray<Skill>>;

  readonly stream: (
    sessionId: SessionId,
  ) => Stream.Stream<ReadonlyArray<Skill>, SessionNotFoundError>;
}

export class SkillBridge extends Context.Tag("memoize/SkillBridge")<
  SkillBridge,
  SkillBridgeShape
>() {}
