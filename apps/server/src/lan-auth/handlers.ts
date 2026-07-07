import { Effect, Layer } from "effect";

import {
  ConnectAuthError,
  EnvironmentDescriptor,
  EnvironmentEndpoint,
  MemoizeRpcs,
  PairingError,
} from "@zuse/wire";

import { buildAdvertisedEndpoints } from "./advertised-endpoints.ts";
import { LanAuthConfig } from "./services/lan-auth-service.ts";
import { LanAuthService } from "./services/lan-auth-service.ts";

const toPairingError = (cause: unknown): PairingError =>
  new PairingError({
    reason:
      cause instanceof Error && cause.message.length > 0
        ? cause.message
        : String(cause),
  });

const PairingStart = MemoizeRpcs.toLayerHandler("pairing.start", () =>
  Effect.gen(function* () {
    const auth = yield* LanAuthService;
    const result = yield* auth.createPairingCode();
    return {
      ...result,
      expiresAt: result.expiresAt,
    };
  }).pipe(Effect.mapError(toPairingError)),
);

const PairingListTokens = MemoizeRpcs.toLayerHandler("pairing.listTokens", () =>
  Effect.gen(function* () {
    const auth = yield* LanAuthService;
    return yield* auth.listTokens();
  }).pipe(Effect.mapError(toPairingError)),
);

const PairingRevokeToken = MemoizeRpcs.toLayerHandler(
  "pairing.revokeToken",
  ({ tokenId }) =>
    Effect.gen(function* () {
      const auth = yield* LanAuthService;
      yield* auth.revokeToken(tokenId);
    }).pipe(Effect.mapError(toPairingError)),
);

const ConnectDescribe = MemoizeRpcs.toLayerHandler("connect.describe", () =>
  Effect.gen(function* () {
    const auth = yield* LanAuthService;
    const config = yield* LanAuthConfig;
    const relayConfig = yield* auth.getRelayConfig();
    const endpoint =
      relayConfig?.tunnelHostname !== undefined
        ? EnvironmentEndpoint.make({
            httpBaseUrl: `https://${relayConfig.tunnelHostname}`,
            wsBaseUrl: `wss://${relayConfig.tunnelHostname}/rpc`,
          })
        : config.advertisedHost !== null && config.port !== null
          ? EnvironmentEndpoint.make({
              httpBaseUrl: `http://${config.advertisedHost}:${config.port}`,
              wsBaseUrl: `ws://${config.advertisedHost}:${config.port}`,
            })
          : null;

    if (endpoint === null) {
      return yield* Effect.fail(
        new ConnectAuthError({ reason: "no_endpoint_configured" }),
      );
    }

    return EnvironmentDescriptor.make({
      environmentId: yield* auth.environmentId(),
      providerKind: "desktop",
      endpoint,
      advertisedEndpoints: buildAdvertisedEndpoints({
        lan: config,
        relay:
          relayConfig === null
            ? null
            : {
                linked: true,
                heartbeatActive: true,
                tunnelHostname: relayConfig.tunnelHostname,
              },
      }),
    });
  }).pipe(
    Effect.mapError((error) =>
      error instanceof ConnectAuthError
        ? error
        : new ConnectAuthError({ reason: "describe_failed" }),
    ),
  ),
);

const ConnectLinkProof = MemoizeRpcs.toLayerHandler(
  "connect.linkProof",
  (input) =>
    Effect.gen(function* () {
      const auth = yield* LanAuthService;
      return yield* auth.linkProof(input);
    }).pipe(
      Effect.mapError(
        (error) =>
          new ConnectAuthError({
            reason:
              error instanceof Error ? error.message : "link_proof_failed",
          }),
      ),
    ),
);

const ConnectRelayConfig = MemoizeRpcs.toLayerHandler(
  "connect.relayConfig",
  (input) =>
    Effect.gen(function* () {
      const auth = yield* LanAuthService;
      yield* auth.saveRelayConfig(input);
    }).pipe(
      Effect.mapError(
        (error) =>
          new ConnectAuthError({
            reason:
              error instanceof Error ? error.message : "relay_config_failed",
          }),
      ),
    ),
);

export const LanAuthHandlersLayer = Layer.mergeAll(
  PairingStart,
  PairingListTokens,
  PairingRevokeToken,
  ConnectDescribe,
  ConnectLinkProof,
  ConnectRelayConfig,
);
