import { Clock, Context, Data, Effect, Fiber, Layer, Ref } from "effect";

import { RelayPaths, type EnvironmentId } from "@zuse/wire";

import { AuthService } from "../auth/services/auth-service.ts";
import { buildAdvertisedEndpoints } from "../lan-auth/advertised-endpoints.ts";
import {
  LanAuthConfig,
  LanAuthService,
  type LanAuthConfigShape,
} from "../lan-auth/services/lan-auth-service.ts";
import { signEnvironmentLinkProof } from "./link-proof.ts";
import { ManagedTunnelRuntime } from "./managed-tunnel-runtime.ts";

const HEARTBEAT_INTERVAL = "30 seconds";

export class RelayLinkError extends Data.TaggedError("RelayLinkError")<{
  readonly reason: string;
}> {}

export interface RelayLinkStatusValue {
  readonly linked: boolean;
  readonly relayUrl?: string;
  readonly environmentId?: EnvironmentId;
  readonly label?: string;
  readonly heartbeatActive: boolean;
  readonly advertisedEndpoints?: ReturnType<typeof buildAdvertisedEndpoints>;
}

/**
 * Server-side orchestration of the account-relay link. The desktop is already
 * WorkOS-signed-in and holds the environment's Ed25519 identity, so it links
 * itself directly: get a challenge, sign the Ed25519 proof, submit it, persist
 * the returned credential, and heartbeat so the relay reports presence. The
 * renderer just calls `relay.*` RPCs.
 */
export class RelayLinkService extends Context.Tag("zuse/RelayLinkService")<
  RelayLinkService,
  {
    readonly link: (input: {
      readonly relayUrl: string;
      readonly label?: string;
    }) => Effect.Effect<RelayLinkStatusValue, RelayLinkError>;
    readonly status: () => Effect.Effect<RelayLinkStatusValue, RelayLinkError>;
    readonly unlink: () => Effect.Effect<void, RelayLinkError>;
  }
>() {}

const failRelay = (reason: string) => new RelayLinkError({ reason });

const relayHttpErrorReason = async (response: Response): Promise<string> => {
  const fallback = `relay_${response.status}`;
  const text = await response.text().catch(() => "");
  if (text.trim().length === 0) return fallback;
  try {
    const body = JSON.parse(text) as { readonly error?: unknown };
    if (typeof body.error === "string") {
      if (response.status === 401 && body.error === "invalid_workos_token") {
        return "relay_auth_rejected";
      }
      return `relay_${response.status}:${body.error}`;
    }
  } catch {
    // Fall through to the status-only reason; relay bodies should be JSON.
  }
  return fallback;
};

const postJson = <A>(
  url: string,
  opts: { readonly bearer: string; readonly body?: unknown },
): Effect.Effect<A, RelayLinkError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.bearer}`,
          ...(opts.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      if (!response.ok) {
        throw new Error(await relayHttpErrorReason(response));
      }
      return (await response.json()) as A;
    },
    catch: (cause) =>
      failRelay(cause instanceof Error ? cause.message : String(cause)),
  });

const computeEndpoint = (config: LanAuthConfigShape) => {
  const host = config.advertisedHost ?? "127.0.0.1";
  const port = config.port ?? 8787;
  return {
    httpBaseUrl: `http://${host}:${port}`,
    wsBaseUrl: `ws://${host}:${port}`,
  };
};

const computeOrigin = (config: LanAuthConfigShape) => ({
  localHttpHost: "127.0.0.1",
  localHttpPort: config.port ?? 8787,
});

export const RelayLinkServiceLive: Layer.Layer<
  RelayLinkService,
  never,
  LanAuthService | LanAuthConfig | AuthService | ManagedTunnelRuntime
> = Layer.scoped(
  RelayLinkService,
  Effect.gen(function* () {
    const auth = yield* LanAuthService;
    const config = yield* LanAuthConfig;
    const authService = yield* AuthService;
    const tunnel = yield* ManagedTunnelRuntime;
    const heartbeatRef = yield* Ref.make<Fiber.RuntimeFiber<void> | null>(null);

    const heartbeatLoop = (input: {
      readonly relayUrl: string;
      readonly environmentId: EnvironmentId;
      readonly credential: string;
    }) =>
      postJson(
        `${input.relayUrl}${RelayPaths.heartbeat(input.environmentId)}`,
        { bearer: input.credential },
      ).pipe(
        Effect.ignore,
        Effect.zipRight(Effect.sleep(HEARTBEAT_INTERVAL)),
        Effect.forever,
      );

    const startHeartbeat = (input: {
      readonly relayUrl: string;
      readonly environmentId: EnvironmentId;
      readonly credential: string;
    }) =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(heartbeatRef);
        if (existing !== null) yield* Fiber.interrupt(existing);
        const fiber = yield* Effect.forkDaemon(heartbeatLoop(input));
        yield* Ref.set(heartbeatRef, fiber);
      });

    const stopHeartbeat = Effect.gen(function* () {
      const existing = yield* Ref.get(heartbeatRef);
      if (existing !== null) yield* Fiber.interrupt(existing);
      yield* Ref.set(heartbeatRef, null);
    });

    // Resume heartbeating (and the managed-tunnel connector) on boot if linked.
    const existing = yield* auth
      .getRelayConfig()
      .pipe(Effect.orElseSucceed(() => null));
    if (existing !== null) {
      yield* startHeartbeat({
        relayUrl: existing.relayUrl,
        environmentId: existing.environmentId,
        credential: existing.environmentCredential,
      });
      if (existing.connectorToken !== undefined) {
        // Non-fatal on boot: if cloudflared is missing the desktop still works
        // on LAN; the tunnel just won't come up until relinked.
        yield* tunnel.start(existing.connectorToken).pipe(Effect.ignore);
      }
    }

    return RelayLinkService.of({
      link: (input) =>
        Effect.gen(function* () {
          const token = yield* authService
            .getAccessToken()
            .pipe(Effect.mapError(() => failRelay("not_signed_in")));
          const keys = yield* auth
            .environmentKeys()
            .pipe(Effect.mapError((error) => failRelay(error.reason)));

          const challenge = yield* postJson<{
            readonly challengeId: string;
            readonly challenge: string;
            readonly relayIssuer: string;
          }>(`${input.relayUrl}${RelayPaths.linkChallenges}`, {
            bearer: token,
          });

          const nowMs = yield* Clock.currentTimeMillis;
          const proof = yield* signEnvironmentLinkProof({
            privateJwk: keys.privateJwk,
            challenge: challenge.challenge,
            environmentId: keys.envId,
            relayIssuer: challenge.relayIssuer,
            nowMs,
          });

          const linked = yield* postJson<{
            readonly environmentCredential: string;
            readonly relayIssuer: string;
            readonly tunnelHostname?: string;
            readonly connectorToken?: string;
          }>(`${input.relayUrl}${RelayPaths.links}`, {
            bearer: token,
            body: {
              challengeId: challenge.challengeId,
              proof,
              environmentId: keys.envId,
              environmentPublicKey: keys.publicJwk,
              providerKind: "desktop",
              endpoint: computeEndpoint(config),
              label: input.label,
              // Ask the relay to provision a managed Cloudflare tunnel so the
              // phone can reach this Mac from anywhere. If the relay has tunnels
              // disabled it simply returns no connector token and we stay on LAN.
              managedTunnel: true,
              origin: computeOrigin(config),
            },
          });

          // Launch the connector before persisting so a missing `cloudflared`
          // surfaces as a link error rather than a silently-dead tunnel.
          if (linked.connectorToken !== undefined) {
            yield* tunnel
              .start(linked.connectorToken)
              .pipe(Effect.mapError((error) => failRelay(error.reason)));
          }

          yield* auth
            .saveRelayConfig({
              relayUrl: input.relayUrl,
              relayIssuer: linked.relayIssuer,
              environmentId: keys.envId,
              environmentCredential: linked.environmentCredential,
              label: input.label,
              connectorToken: linked.connectorToken,
              tunnelHostname: linked.tunnelHostname,
            })
            .pipe(Effect.mapError((error) => failRelay(error.reason)));

          yield* startHeartbeat({
            relayUrl: input.relayUrl,
            environmentId: keys.envId,
            credential: linked.environmentCredential,
          });

          return {
            linked: true,
            relayUrl: input.relayUrl,
            environmentId: keys.envId,
            label: input.label,
            heartbeatActive: true,
            advertisedEndpoints: buildAdvertisedEndpoints({
              lan: config,
              relay: {
                linked: true,
                heartbeatActive: true,
                tunnelHostname: linked.tunnelHostname,
              },
            }),
          } satisfies RelayLinkStatusValue;
        }),
      status: () =>
        Effect.gen(function* () {
          const cfg = yield* auth
            .getRelayConfig()
            .pipe(Effect.mapError((error) => failRelay(error.reason)));
          const active = (yield* Ref.get(heartbeatRef)) !== null;
          if (cfg === null) {
            return {
              linked: false,
              heartbeatActive: false,
              advertisedEndpoints: buildAdvertisedEndpoints({ lan: config }),
            } satisfies RelayLinkStatusValue;
          }
          return {
            linked: true,
            relayUrl: cfg.relayUrl,
            environmentId: cfg.environmentId,
            label: cfg.label,
            heartbeatActive: active,
            advertisedEndpoints: buildAdvertisedEndpoints({
              lan: config,
              relay: {
                linked: true,
                heartbeatActive: active,
                tunnelHostname: cfg.tunnelHostname,
              },
            }),
          } satisfies RelayLinkStatusValue;
        }),
      unlink: () =>
        Effect.gen(function* () {
          const cfg = yield* auth
            .getRelayConfig()
            .pipe(Effect.orElseSucceed(() => null));
          yield* stopHeartbeat;
          yield* tunnel.stop();
          // Best-effort relay deprovision (tears down the Cloudflare tunnel +
          // removes the environment from the account). Local unlink proceeds
          // even if the relay is unreachable or we're signed out.
          if (cfg !== null) {
            yield* authService.getAccessToken().pipe(
              Effect.flatMap((token) =>
                postJson<unknown>(`${cfg.relayUrl}${RelayPaths.unlink}`, {
                  bearer: token,
                  body: { environmentId: cfg.environmentId },
                }),
              ),
              Effect.ignore,
            );
          }
          yield* auth
            .clearRelayConfig()
            .pipe(Effect.mapError((error) => failRelay(error.reason)));
        }),
    });
  }),
);
