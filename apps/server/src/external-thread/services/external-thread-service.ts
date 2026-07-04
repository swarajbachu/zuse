import { Context, type Effect } from "effect";

import type {
  ContinueExternalThreadInput,
  ContinueExternalThreadResult,
  ExternalThread,
} from "@zuse/wire";

export interface ExternalThreadServiceShape {
  readonly list: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ExternalThread>>;
  readonly continueThread: (
    input: ContinueExternalThreadInput,
  ) => Effect.Effect<ContinueExternalThreadResult>;
}

export class ExternalThreadService extends Context.Tag(
  "memoize/ExternalThreadService",
)<ExternalThreadService, ExternalThreadServiceShape>() {}
