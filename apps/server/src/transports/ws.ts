import * as http from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import {
  LanAuthService,
  type LanAuthServiceShape,
  PairingRedeemError,
} from "../lan-auth/services/lan-auth-service.ts";

const PairRequest = Schema.Struct({ code: Schema.String });

type WsDiagnostic = (event: string, fields?: Record<string, unknown>) => void;

const json = (body: unknown, status: number) =>
  HttpServerResponse.json(body, { status }).pipe(Effect.orDie);

const bearerFromRequest = (
  request: HttpServerRequest.HttpServerRequest,
): string | null => {
  const auth = request.headers.authorization;
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }

  const url = new URL(request.url, "http://localhost");
  return url.searchParams.get("token");
};

const pairApp = (auth: LanAuthServiceShape, log: WsDiagnostic) =>
  Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(PairRequest).pipe(
      Effect.catch(() => Effect.fail("bad_request" as const)),
    );
    yield* Effect.sync(() => log("ws.pair.redeem.start"));
    const redeemed = yield* auth
      .redeemPairingCode(body.code)
      .pipe(
        Effect.mapError((error) =>
          error instanceof PairingRedeemError ? error.reason : "internal",
        ),
      );
    yield* Effect.sync(() =>
      log("ws.pair.redeem.ok", { environmentId: redeemed.environmentId }),
    );
    return yield* json(redeemed, 200);
  }).pipe(
    Effect.catch((error) => {
      log("ws.pair.redeem.fail", { reason: error });
      if (error === "expired_code") {
        return json({ error }, 410);
      }
      if (error === "bad_request") {
        return json({ error }, 400);
      }
      if (error === "invalid_code") {
        return json({ error }, 401);
      }
      return json({ error: "internal_error" }, 500);
    }),
  );

/**
 * WebSocket RPC transport for the headless server.
 *
 * Protected mode owns the HTTP upgrade path so an unauthenticated client gets
 * a plain 401 response and never receives a live socket. Local mode preserves
 * the existing loopback developer behavior.
 */
export const wsServerProtocolLayer = (opts: {
  readonly port: number;
  readonly host?: string;
  readonly onDiagnostic?: WsDiagnostic;
}): Layer.Layer<RpcServer.Protocol, never, LanAuthService> =>
  Layer.effect(
    RpcServer.Protocol,
    Effect.gen(function* () {
      const auth = yield* LanAuthService;
      const log = opts.onDiagnostic ?? (() => {});
      yield* Effect.sync(() =>
        log("ws.bind.start", {
          host: opts.host ?? "127.0.0.1",
          port: opts.port,
          policy: auth.policy,
          pairingBootstrap: auth.pairingBootstrap,
        }),
      );

      const { protocol, httpEffect } =
        yield* RpcServer.makeProtocolWithHttpEffectWebsocket;

      const guarded = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = bearerFromRequest(request);
        yield* Effect.sync(() =>
          log("ws.request", {
            url: request.url,
            protected: auth.policy === "protected",
            hasToken: token !== null,
          }),
        );
        if (auth.policy === "protected") {
          const ok =
            token !== null &&
            (yield* auth
              .verifyToken(token)
              .pipe(Effect.orElseSucceed(() => false)));
          yield* Effect.sync(() =>
            log(ok ? "ws.auth.ok" : "ws.auth.fail", {
              url: request.url,
              hasToken: token !== null,
            }),
          );
          if (!ok) return yield* json({ error: "unauthorized" }, 401);
        }
        const requestUrl = new URL(request.url, "http://localhost");
        const receivedVersion = Number(
          requestUrl.searchParams.get("wireVersion"),
        );
        if (receivedVersion !== WIRE_PROTOCOL_VERSION) {
          log("ws.protocol.reject", {
            expectedVersion: WIRE_PROTOCOL_VERSION,
            receivedVersion: Number.isFinite(receivedVersion)
              ? receivedVersion
              : null,
          });
          return yield* json(
            {
              error: "wire_protocol_mismatch",
              expectedVersion: WIRE_PROTOCOL_VERSION,
            },
            426,
          );
        }
        return yield* httpEffect;
      });

      const router = yield* HttpRouter.make;
      yield* router.add("GET", "/", guarded);
      // Existing relay deployments and previously linked environments may
      // still advertise `/rpc`. Keep accepting it while newer links use `/`.
      yield* router.add("GET", "/rpc", guarded);
      yield* router.add("POST", "/pair", pairApp(auth, log));

      yield* HttpServer.serveEffect(router.asHttpEffect()).pipe(
        Effect.forkScoped,
      );
      yield* Effect.sync(() =>
        log("ws.bind.ok", {
          host: opts.host ?? "127.0.0.1",
          port: opts.port,
          policy: auth.policy,
        }),
      );

      if (auth.policy === "protected" && auth.pairingBootstrap) {
        const pairing = yield* auth.createPairingCode();
        const redeemUrl = pairing.pairingUrl.replace(/^ws:/, "http:");
        yield* Effect.sync(() => {
          console.log("Zuse LAN pairing enabled");
          console.log(`QR: ${pairing.qrText}`);
          console.log(
            `Redeem with: POST ${redeemUrl}/pair {"code":"${pairing.code}"}`,
          );
        });
      }

      return protocol;
    }),
  ).pipe(
    Layer.provide(
      NodeHttpServer.layer(() => http.createServer(), {
        port: opts.port,
        host: opts.host ?? "127.0.0.1",
      }),
    ),
    Layer.provide(RpcSerialization.layerJson),
    Layer.orDie,
  );
