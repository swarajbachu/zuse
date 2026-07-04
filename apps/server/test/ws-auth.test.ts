import { describe, expect, it } from "bun:test";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { RpcGroup, RpcServer } from "@effect/rpc";
import { Effect, Layer, ManagedRuntime } from "effect";
import { randomBytes } from "node:crypto";
import { Socket, createServer } from "node:net";

import { PingResult, PingRpc } from "@zuse/wire";

import { LanAuthServiceLive } from "../src/lan-auth/layers/lan-auth-service.ts";
import {
  LanAuthConfig,
  LanAuthService,
} from "../src/lan-auth/services/lan-auth-service.ts";
import type { LanAuthPolicy } from "../src/lan-auth/policy.ts";
import { Migration0021AuthTokens } from "../src/persistence/migrations/0021_auth_tokens.ts";
import { wsServerProtocolLayer } from "../src/transports/ws.ts";

const TestRpcs = RpcGroup.make(PingRpc);

const PingHandler = TestRpcs.toLayerHandler("ping.ping", () =>
  Effect.succeed(PingResult.make({ message: "pong", receivedAt: new Date() })),
);

const freePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("no tcp port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });

const makeRuntime = (opts: {
  readonly policy: LanAuthPolicy;
  readonly port: number;
  readonly pairingBootstrap?: boolean;
}) => {
  const SqlLive = SqliteClient.layer({ filename: ":memory:" });
  const Migrated = Layer.effectDiscard(Migration0021AuthTokens).pipe(
    Layer.provideMerge(SqlLive),
  );
  const ConfigLive = Layer.succeed(LanAuthConfig, {
    policy: opts.policy,
    advertisedHost: "127.0.0.1",
    port: opts.port,
    pairingBootstrap: opts.pairingBootstrap ?? false,
  });
  const LanAuthLayer = LanAuthServiceLive.pipe(
    Layer.provideMerge(Migrated),
    Layer.provide(ConfigLive),
  );
  const ProtocolLayer = wsServerProtocolLayer({
    port: opts.port,
    host: "127.0.0.1",
  }).pipe(Layer.provide(LanAuthLayer));
  const ServerLayer = RpcServer.layer(TestRpcs).pipe(
    Layer.provide(PingHandler),
    Layer.provide(ProtocolLayer),
  );
  return ManagedRuntime.make(Layer.mergeAll(LanAuthLayer, ServerLayer));
};

const disposeRuntime = async (runtime: ManagedRuntime.ManagedRuntime<any, any>) => {
  await Promise.race([
    runtime.dispose(),
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
};

const upgradeStatus = (
  port: number,
  path: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = new Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("upgrade timeout"));
    }, 2_000);
    let data = "";
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (!data.includes("\r\n\r\n")) return;
      clearTimeout(timeout);
      socket.destroy();
      const status = Number(data.split(" ")[1]);
      resolve(status);
    });
    socket.connect(port, "127.0.0.1", () => {
      const requestHeaders = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        "",
        "",
      ].join("\r\n");
      socket.write(requestHeaders);
    });
  });

describe("WS LAN auth", () => {
  it("rejects unauthenticated protected requests before upgrade", async () => {
    const port = await freePort();
    const runtime = makeRuntime({
      policy: "protected",
      port,
      pairingBootstrap: true,
    });
    try {
      await runtime.runPromise(Effect.void);
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(401);
      await expect(upgradeStatus(port, "/")).resolves.toBe(401);
    } finally {
      await disposeRuntime(runtime);
    }
  });

  it("redeems pairing codes and accepts query-token WebSockets", async () => {
    const port = await freePort();
    const runtime = makeRuntime({
      policy: "protected",
      port,
      pairingBootstrap: true,
    });
    try {
      const pairing = await runtime.runPromise(
        Effect.gen(function* () {
          const auth = yield* LanAuthService;
          return yield* auth.createPairingCode();
        }),
      );

      const bad = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "zp_bad" }),
      });
      expect(bad.status).toBe(401);

      const response = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: pairing.code }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        readonly token: string;
        readonly environmentId: string;
      };
      expect(body.token.startsWith("zt_")).toBe(true);
      expect(body.environmentId.startsWith("env_")).toBe(true);

      const second = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: pairing.code }),
      });
      expect(second.status).toBe(401);

      await expect(
        upgradeStatus(port, `/?token=${encodeURIComponent(body.token)}`),
      ).resolves.toBe(101);
    } finally {
      await disposeRuntime(runtime);
    }
  });

  it("accepts Authorization header bearer tokens where the client supports headers", async () => {
    const port = await freePort();
    const runtime = makeRuntime({
      policy: "protected",
      port,
      pairingBootstrap: true,
    });
    try {
      const token = await runtime.runPromise(
        Effect.gen(function* () {
          const auth = yield* LanAuthService;
          const minted = yield* auth.mintToken("header client");
          return minted.token;
        }),
      );

      await expect(
        upgradeStatus(port, "/", { Authorization: `Bearer ${token}` }),
      ).resolves.toBe(101);
    } finally {
      await disposeRuntime(runtime);
    }
  });

  it("preserves unauthenticated local loopback connections", async () => {
    const port = await freePort();
    const runtime = makeRuntime({ policy: "local", port });
    try {
      await runtime.runPromise(Effect.void);
      await expect(upgradeStatus(port, "/")).resolves.toBe(101);
    } finally {
      await disposeRuntime(runtime);
    }
  });

  it("fails closed for protected boot with no token and no bootstrap", async () => {
    const port = await freePort();
    const runtime = makeRuntime({ policy: "protected", port });
    try {
      await expect(
        runtime.runPromise(Effect.void),
      ).rejects.toThrow(/refusing to bind non-loopback without auth/);
    } finally {
      await disposeRuntime(runtime);
    }
  });
});
