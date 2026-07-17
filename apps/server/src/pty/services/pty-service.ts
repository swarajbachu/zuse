import type {
  PtyCommand,
  PtyEvent,
  PtyId,
  PtyNotFoundError,
  PtySpawnError,
} from "@zuse/contracts";
import { Context, type Effect, type Stream } from "effect";

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
    afterSequence?: number,
  ) => Stream.Stream<typeof PtyEvent.Type, PtyNotFoundError>;
}

export class PtyService extends Context.Service<PtyService, PtyServiceShape>()(
  "memoize/PtyService",
) {}
