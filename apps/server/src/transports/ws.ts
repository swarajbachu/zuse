import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { Effect, Layer, Schema } from "effect";
import * as http from "node:http";

import {
  LanAuthService,
  type LanAuthServiceShape,
  PairingRedeemError,
} from "../lan-auth/services/lan-auth-service.ts";

const PairRequest = Schema.Struct({ code: Schema.String });

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

const pairApp = (auth: LanAuthServiceShape) =>
  Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(PairRequest).pipe(
      Effect.catchAll(() => Effect.fail("bad_request" as const)),
    );
    const redeemed = yield* auth.redeemPairingCode(body.code).pipe(
      Effect.mapError((error) =>
        error instanceof PairingRedeemError ? error.reason : "internal",
      ),
    );
    return yield* json(redeemed, 200);
  }).pipe(
    Effect.catchAll((error) => {
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
}): Layer.Layer<RpcServer.Protocol, never, LanAuthService> =>
  Layer.scoped(
    RpcServer.Protocol,
    Effect.gen(function* () {
      const auth = yield* LanAuthService;
      if (auth.policy === "protected") {
        const ok = (yield* auth.hasActiveTokens()) || auth.pairingBootstrap;
        if (!ok) {
          return yield* Effect.dieMessage(
            "refusing to bind non-loopback without auth: mint a token or set ZUSE_ENABLE_PAIRING=1",
          );
        }
      }

      const { protocol, httpApp } =
        yield* RpcServer.makeProtocolWithHttpAppWebsocket;

      const guarded = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (auth.policy === "protected") {
          const token = bearerFromRequest(request);
          const ok = token !== null && (yield* auth.verifyToken(token));
          if (!ok) return yield* json({ error: "unauthorized" }, 401);
        }
        return yield* httpApp;
      });

      const router = HttpRouter.empty.pipe(
        HttpRouter.get("/", guarded),
        HttpRouter.post("/pair", pairApp(auth)),
      );

      yield* HttpServer.serveEffect(router).pipe(Effect.forkScoped);

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
