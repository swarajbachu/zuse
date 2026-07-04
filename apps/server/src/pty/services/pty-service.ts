import { Context, type Effect, type Stream } from "effect";

import {
  type PtyCommand,
  type PtyEvent,
  type PtyId,
  type PtyNotFoundError,
  type PtySpawnError,
} from "@zuse/wire";

export interface PtyServiceShape {
  readonly open: (
    cwd: string,
    cols: number,
    rows: number,
    command?: PtyCommand,
  ) => Effect.Effect<{ readonly ptyId: PtyId }, PtySpawnError>;
  readonly write: (
    ptyId: PtyId,
    data: string,
  ) => Effect.Effect<void, PtyNotFoundError>;
  readonly resize: (
    ptyId: PtyId,
    cols: number,
    rows: number,
  ) => Effect.Effect<void, PtyNotFoundError>;
  readonly close: (ptyId: PtyId) => Effect.Effect<void, PtyNotFoundError>;
  readonly closeByCwdPrefix: (cwdPrefix: string) => Effect.Effect<void>;
  readonly subscribe: (
    ptyId: PtyId,
  ) => Stream.Stream<typeof PtyEvent.Type, PtyNotFoundError>;
}

export class PtyService extends Context.Tag("memoize/PtyService")<
  PtyService,
  PtyServiceShape
>() {}
