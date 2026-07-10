import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";

import { BrowserCommandResult, type SessionId } from "@zuse/wire";

import { BrowserBridgeServiceLive } from "../src/provider/layers/browser-bridge-service.ts";
import { BrowserBridgeService } from "../src/provider/services/browser-bridge-service.ts";

const TestLayer = BrowserBridgeServiceLive;

describe("BrowserBridgeService", () => {
  it("tracks connected renderers, pending commands, and completed responses", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bridge = yield* BrowserBridgeService;
          const sessionId = "session-browser-bridge" as SessionId;
          const events = bridge.commands();
          yield* Stream.runForEach(events, (request) =>
            bridge.respond(
              BrowserCommandResult.make({
                id: request.id,
                ok: true,
                detail: "loaded",
              }),
            ),
          ).pipe(Effect.forkScoped);

          yield* Effect.sleep("10 millis");
          expect(yield* bridge.diagnostics).toMatchObject({
            connectedRendererCount: 1,
            pendingCommandCount: 0,
          });

          const result = yield* bridge.send(sessionId, {
            _tag: "Navigate",
            url: "http://localhost:3000",
          });
          expect(result.ok).toBe(true);

          expect(yield* bridge.diagnostics).toMatchObject({
            connectedRendererCount: 1,
            pendingCommandCount: 0,
            issuedCommandCount: 1,
            timeoutCount: 0,
            overloadCount: 0,
          });
        }),
      ).pipe(Effect.provide(TestLayer)),
    );
  });

  it("counts stale renderer responses without leaking command details", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bridge = yield* BrowserBridgeService;
          const error = yield* bridge
            .respond(
              BrowserCommandResult.make({
                id: "missing-command",
                ok: false,
                error: "stale",
              }),
            )
            .pipe(Effect.flip);

          expect(error._tag).toBe("BrowserCommandNotFoundError");
          expect(yield* bridge.diagnostics).toMatchObject({
            pendingCommandCount: 0,
            missingResponseCount: 1,
          });
        }),
      ).pipe(Effect.provide(TestLayer)),
    );
  });
});
