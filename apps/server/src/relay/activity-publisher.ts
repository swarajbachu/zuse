import { Context, Data, Effect, Layer } from "effect";

import { RelayPaths, type EnvironmentId, type SessionId } from "@zuse/wire";

import { LanAuthService } from "../lan-auth/services/lan-auth-service.ts";

export type RelayActivityKind =
  | "approval-needed"
  | "question-needed"
  | "completed"
  | "error"
  | "running";

export class RelayActivityPublishError extends Data.TaggedError(
  "RelayActivityPublishError",
)<{
  readonly reason: string;
}> {}

export interface RelayActivityPublisherApi {
  readonly publish: (input: {
    readonly sessionId: SessionId;
    readonly kind: RelayActivityKind;
  }) => Effect.Effect<void, RelayActivityPublishError>;
}

export class RelayActivityPublisher extends Context.Service<RelayActivityPublisher, RelayActivityPublisherApi>()(
  "zuse/RelayActivityPublisher",
) {}

const fail = (cause: unknown) =>
  new RelayActivityPublishError({
    reason: cause instanceof Error ? cause.message : String(cause),
  });

export const RelayActivityPublisherLive: Layer.Layer<
  RelayActivityPublisher,
  never,
  LanAuthService
> = Layer.effect(
  RelayActivityPublisher,
  Effect.gen(function* () {
    const lanAuth = yield* LanAuthService;

    return RelayActivityPublisher.of({
      publish: (input) =>
        Effect.gen(function* () {
          const config = yield* lanAuth
            .getRelayConfig()
            .pipe(Effect.mapError((error) => fail(error.reason)));
          if (config === null) return;

          yield* Effect.tryPromise({
            try: async () => {
              const response = await fetch(
                `${config.relayUrl}${RelayPaths.agentActivity(
                  config.environmentId as EnvironmentId,
                )}`,
                {
                  method: "POST",
                  headers: {
                    authorization: `Bearer ${config.environmentCredential}`,
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({
                    sessionId: input.sessionId,
                    kind: input.kind,
                    ...(config.label === undefined
                      ? {}
                      : { title: config.label }),
                  }),
                },
              );
              if (!response.ok) {
                throw new Error(`relay_activity_${response.status}`);
              }
            },
            catch: fail,
          });
        }),
    });
  }),
);
