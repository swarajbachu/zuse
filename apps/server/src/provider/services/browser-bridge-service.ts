import { Context, type Effect, type Stream } from "effect";

import type {
  BrowserCommand,
  BrowserCommandNotFoundError,
  BrowserCommandRequest,
  BrowserCommandResult,
  SessionId,
} from "@zuse/wire";

export interface BrowserBridgeDiagnostics {
  readonly connectedRendererCount: number;
  readonly pendingCommandCount: number;
  readonly issuedCommandCount: number;
  readonly timeoutCount: number;
  readonly overloadCount: number;
  readonly disconnectCount: number;
  readonly missingResponseCount: number;
}

/**
 * Bridge between the in-process browser MCP tools (which call `send` from
 * inside the Claude SDK tool handler) and the renderer (which subscribes to
 * `commands`, drives the `<webview>`, then calls `respond`).
 *
 * `send` blocks the tool until the renderer replies or a 30s safety timeout
 * fires (a hidden/closed webview can never hang the agent turn). `respond`
 * resolves whichever Deferred is keyed by `result.id`. `commands` is the
 * server→renderer broadcast every BrowserPane consumes.
 *
 * Deliberately ephemeral — no SQLite. A browser command only matters while
 * its agent turn is live; nothing survives a restart.
 */
export interface BrowserBridgeServiceShape {
  /**
   * Issue a command to the renderer and await its result. Never fails: a
   * timeout (or absent webview) returns a `{ ok: false, error }` result so
   * the tool can report it to the agent as a normal tool outcome.
   */
  readonly send: (
    sessionId: SessionId,
    command: BrowserCommand,
  ) => Effect.Effect<BrowserCommandResult>;

  readonly respond: (
    result: BrowserCommandResult,
  ) => Effect.Effect<void, BrowserCommandNotFoundError>;

  readonly commands: () => Stream.Stream<BrowserCommandRequest>;

  readonly diagnostics: Effect.Effect<BrowserBridgeDiagnostics>;
}

export class BrowserBridgeService extends Context.Service<BrowserBridgeService, BrowserBridgeServiceShape>()(
  "memoize/BrowserBridgeService",
) {}
