import { Deferred, Effect, Layer, PubSub, Ref, Stream } from "effect";

import {
  BrowserCommandNotFoundError,
  BrowserCommandRequest,
  BrowserCommandResult,
  type BrowserCommand,
  type SessionId,
} from "@zuse/wire";

import {
  BrowserBridgeService,
  type BrowserBridgeServiceShape,
} from "../services/browser-bridge-service.ts";

/**
 * How long a single browser command may wait for the renderer before the
 * bridge gives up and reports the webview as unavailable. The webview lives
 * in the renderer — if the Browser pane isn't mounted (no project selected)
 * or the renderer is wedged, the command would otherwise block the agent
 * turn forever. 30s comfortably covers a real page load + screenshot.
 */
const COMMAND_TIMEOUT = "30 seconds";

let commandCounter = 0;
const nextCommandId = (): string => `bc_${Date.now()}_${++commandCounter}`;

export const BrowserBridgeServiceLive = Layer.scoped(
  BrowserBridgeService,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<BrowserCommandRequest>();
    const pending = yield* Ref.make<
      ReadonlyMap<string, Deferred.Deferred<BrowserCommandResult>>
    >(new Map());

    const forget = (id: string): Effect.Effect<void> =>
      Ref.update(pending, (m) => {
        const next = new Map(m);
        next.delete(id);
        return next;
      });

    const send: BrowserBridgeServiceShape["send"] = (
      sessionId: SessionId,
      command: BrowserCommand,
    ) =>
      Effect.gen(function* () {
        const id = nextCommandId();
        const req = BrowserCommandRequest.make({ id, sessionId, command });
        const deferred = yield* Deferred.make<BrowserCommandResult>();
        yield* Ref.update(pending, (m) => {
          const next = new Map(m);
          next.set(id, deferred);
          return next;
        });
        yield* PubSub.publish(pubsub, req);
        // Await the renderer's reply, but never longer than COMMAND_TIMEOUT.
        // On timeout we synthesize a failure result rather than failing the
        // effect, so the tool reports a clean error to the agent. `ensuring`
        // guarantees the pending entry is cleared on every exit path.
        const result = yield* Deferred.await(deferred).pipe(
          Effect.timeoutTo({
            duration: COMMAND_TIMEOUT,
            onTimeout: () =>
              BrowserCommandResult.make({
                id,
                ok: false,
                error:
                  "The in-app browser did not respond. Open the Browser tab in the right pane and try again.",
              }),
            onSuccess: (r: BrowserCommandResult) => r,
          }),
          Effect.ensuring(forget(id)),
        );
        return result;
      });

    const respond: BrowserBridgeServiceShape["respond"] = (result) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(pending);
        const deferred = map.get(result.id);
        if (deferred === undefined) {
          return yield* Effect.fail(
            new BrowserCommandNotFoundError({ id: result.id }),
          );
        }
        yield* Deferred.succeed(deferred, result);
      });

    const commands: BrowserBridgeServiceShape["commands"] = () =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const dequeue = yield* pubsub.subscribe;
          return Stream.fromQueue(dequeue);
        }),
      );

    return { send, respond, commands } as const;
  }),
);
