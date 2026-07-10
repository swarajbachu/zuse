import { Context, type Effect } from "effect";

import type {
  DiagnosticsExportError,
  DiagnosticsExportResult,
} from "@zuse/contracts";

export interface DiagnosticsServiceShape {
  readonly exportBundle: (payload: {
    readonly clientContext?: unknown;
  }) => Effect.Effect<
    DiagnosticsExportResult,
    DiagnosticsExportError
  >;
}

export class DiagnosticsService extends Context.Service<DiagnosticsService, DiagnosticsServiceShape>()(
  "memoize/DiagnosticsService",
) {}
