import { Context, type Effect } from "effect";

import type { SessionStoreError } from "../errors.ts";
import type { SessionBundle } from "../layers/workos.ts";

export interface SessionStoreShape {
  readonly read: () => Effect.Effect<SessionBundle | null, SessionStoreError>;
  readonly write: (
    bundle: SessionBundle,
  ) => Effect.Effect<SessionBundle, SessionStoreError>;
  readonly clear: () => Effect.Effect<void, SessionStoreError>;
  readonly withLock: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SessionStoreError, R>;
}

export class SessionStore extends Context.Tag("memoize/SessionStore")<
  SessionStore,
  SessionStoreShape
>() {}
