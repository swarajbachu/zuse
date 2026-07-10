import { Deferred, Effect, Layer, Option, PubSub, Ref, Stream } from "effect";

import {
  BrowserCommandNotFoundError,
  BrowserCommandRequest,
  BrowserCommandResult,
  type BrowserCommand,
  type SessionId,
} from "@zuse/wire";

import {
  type BrowserBridgeDiagnostics,
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
const COMMAND_QUEUE_CAPACITY = 64;
const COMMAND_OFFER_TIMEOUT = "100 millis";

let commandCounter = 0;
const nextCommandId = (): string => `bc_${Date.now()}_${++commandCounter}`;

const emptyDiagnostics: BrowserBridgeDiagnostics = {
  connectedRendererCount: 0,
  pendingCommandCount: 0,
  issuedCommandCount: 0,
  timeoutCount: 0,
  overloadCount: 0,
  disconnectCount: 0,
  missingResponseCount: 0,
};

export const BrowserBridgeServiceLive = Layer.effect(
  BrowserBridgeService,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.bounded<BrowserCommandRequest>(
      COMMAND_QUEUE_CAPACITY,
    );
    const pending = yield* Ref.make<
      ReadonlyMap<string, Deferred.Deferred<BrowserCommandResult>>
    >(new Map());
    const diagnostics =
      yield* Ref.make<BrowserBridgeDiagnostics>(emptyDiagnostics);

    const updateDiagnostics = (
      f: (current: BrowserBridgeDiagnostics) => BrowserBridgeDiagnostics,
    ): Effect.Effect<void> => Ref.update(diagnostics, f);

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
        yield* updateDiagnostics((current) => ({
          ...current,
          pendingCommandCount: current.pendingCommandCount + 1,
          issuedCommandCount: current.issuedCommandCount + 1,
        }));
        const published = yield* PubSub.publish(pubsub, req).pipe(
          Effect.timeoutOption(COMMAND_OFFER_TIMEOUT),
        );
        if (Option.isNone(published) || !published.value) {
          yield* forget(id);
          yield* updateDiagnostics((current) => ({
            ...current,
            pendingCommandCount: Math.max(0, current.pendingCommandCount - 1),
            overloadCount: current.overloadCount + 1,
          }));
          return BrowserCommandResult.make({
            id,
            ok: false,
            error:
              "The in-app browser command queue is overloaded. Try again after the current browser action finishes.",
          });
        }
        // Await the renderer's reply, but never longer than COMMAND_TIMEOUT.
        // On timeout we synthesize a failure result rather than failing the
        // effect, so the tool reports a clean error to the agent. `ensuring`
        // guarantees the pending entry is cleared on every exit path.
        const result = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOption(COMMAND_TIMEOUT),
          Effect.flatMap((maybeResult) => {
            if (Option.isSome(maybeResult)) {
              return Effect.succeed(maybeResult.value);
            }
            return updateDiagnostics((current) => ({
              ...current,
              timeoutCount: current.timeoutCount + 1,
            })).pipe(
              Effect.as(
                BrowserCommandResult.make({
                  id,
                  ok: false,
                  error:
                    "The in-app browser did not respond. Open the Browser tab in the right pane and try again.",
                }),
              ),
            );
          }),
          Effect.ensuring(
            forget(id).pipe(
              Effect.andThen(
                updateDiagnostics((current) => ({
                  ...current,
                  pendingCommandCount: Math.max(
                    0,
                    current.pendingCommandCount - 1,
                  ),
                })),
              ),
            ),
          ),
        );
        return result;
      });

    const respond: BrowserBridgeServiceShape["respond"] = (result) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(pending);
        const deferred = map.get(result.id);
        if (deferred === undefined) {
          yield* updateDiagnostics((current) => ({
            ...current,
            missingResponseCount: current.missingResponseCount + 1,
          }));
          return yield* Effect.fail(
            new BrowserCommandNotFoundError({ id: result.id }),
          );
        }
        yield* Deferred.succeed(deferred, result);
      });

    const commands: BrowserBridgeServiceShape["commands"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const dequeue = yield* PubSub.subscribe(pubsub);
          yield* updateDiagnostics((current) => ({
            ...current,
            connectedRendererCount: current.connectedRendererCount + 1,
          }));
          return Stream.fromSubscription(dequeue).pipe(
            Stream.ensuring(
              updateDiagnostics((current) => ({
                ...current,
                connectedRendererCount: Math.max(
                  0,
                  current.connectedRendererCount - 1,
                ),
                disconnectCount: current.disconnectCount + 1,
              })),
            ),
          );
        }),
      );

    return {
      send,
      respond,
      commands,
      diagnostics: Ref.get(diagnostics),
    } as const;
  }),
);
