import { Context, Effect, Layer } from "effect";

import type { ActivityKind } from "./store.ts";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export interface PushNotification {
  readonly to: string;
  readonly environmentId: string;
  readonly kind: ActivityKind;
  readonly title?: string;
  readonly target: string;
}

export interface PushDeliveryApi {
  readonly send: (
    notifications: ReadonlyArray<PushNotification>,
  ) => Effect.Effect<void, unknown>;
}

export class PushDelivery extends Context.Service<
  PushDelivery,
  PushDeliveryApi
>()("@zuse/relay/PushDelivery") {}

const notificationBody = (kind: ActivityKind): string => {
  switch (kind) {
    case "approval-needed":
      return "Approval needed";
    case "question-needed":
      return "Question needed";
    case "completed":
      return "Agent completed";
    case "error":
      return "Agent needs attention";
    case "running":
      return "Agent is running";
  }
};

const toExpoMessage = (notification: PushNotification) => ({
  to: notification.to,
  sound: "default",
  title: notification.title ?? "Zuse",
  body: notificationBody(notification.kind),
  data: {
    environmentId: notification.environmentId,
    kind: notification.kind,
    ...(notification.title === undefined ? {} : { title: notification.title }),
    target: notification.target,
  },
});

export const makePushDeliveryLayer = (
  fetchImpl: typeof fetch,
): Layer.Layer<PushDelivery> =>
  Layer.succeed(
    PushDelivery,
    PushDelivery.of({
      send: (notifications) =>
        notifications.length === 0
          ? Effect.void
          : Effect.tryPromise({
              try: async () => {
                const response = await fetchImpl(EXPO_PUSH_URL, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(notifications.map(toExpoMessage)),
                });
                if (!response.ok) {
                  throw new Error(`expo_push_${response.status}`);
                }
              },
              catch: (cause) => cause,
            }),
    }),
  );

export const PushDeliveryLive: Layer.Layer<PushDelivery> =
  makePushDeliveryLayer(globalThis.fetch.bind(globalThis));
