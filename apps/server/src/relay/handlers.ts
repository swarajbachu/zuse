import { Effect, Layer } from "effect";

import { ConnectAuthError, MemoizeRpcs, RelayLinkStatus } from "@zuse/wire";

import {
  RelayLinkService,
  type RelayLinkStatusValue,
} from "./relay-link-service.ts";

const toStatus = (value: RelayLinkStatusValue): RelayLinkStatus =>
  RelayLinkStatus.make({
    linked: value.linked,
    relayUrl: value.relayUrl,
    environmentId: value.environmentId,
    label: value.label,
    heartbeatActive: value.heartbeatActive,
    advertisedEndpoints: value.advertisedEndpoints,
  });

const toConnectError = (reason: string): ConnectAuthError =>
  new ConnectAuthError({ reason });

const RelayLink = MemoizeRpcs.toLayerHandler("relay.link", (input) =>
  Effect.gen(function* () {
    const service = yield* RelayLinkService;
    return toStatus(yield* service.link(input));
  }).pipe(Effect.mapError((error) => toConnectError(error.reason))),
);

const RelayStatus = MemoizeRpcs.toLayerHandler("relay.status", () =>
  Effect.gen(function* () {
    const service = yield* RelayLinkService;
    return toStatus(yield* service.status());
  }).pipe(Effect.mapError((error) => toConnectError(error.reason))),
);

const RelayUnlink = MemoizeRpcs.toLayerHandler("relay.unlink", () =>
  Effect.gen(function* () {
    const service = yield* RelayLinkService;
    yield* service.unlink();
  }).pipe(Effect.mapError((error) => toConnectError(error.reason))),
);

export const RelayHandlersLayer = Layer.mergeAll(
  RelayLink,
  RelayStatus,
  RelayUnlink,
);
