import { describe, expect, it } from "bun:test";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
  Duration,
  Effect,
  Either,
  Layer,
  ManagedRuntime,
  TestClock,
  TestContext,
} from "effect";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { LanAuthServiceLive } from "../src/lan-auth/layers/lan-auth-service.ts";
import { resolveAuthPolicy } from "../src/lan-auth/policy.ts";
import {
  LanAuthConfig,
  LanAuthService,
} from "../src/lan-auth/services/lan-auth-service.ts";
import { Migration0021AuthTokens } from "../src/persistence/migrations/0021_auth_tokens.ts";
import { Migration0024RemoteConnectState } from "../src/persistence/migrations/0024_remote_connect_state.ts";
import { Migration0025RelayEnvironmentKeys } from "../src/persistence/migrations/0025_relay_environment_keys.ts";
import { Migration0026RelayConnectorToken } from "../src/persistence/migrations/0026_relay_connector_token.ts";
import { Migration0027RelayTunnelHostname } from "../src/persistence/migrations/0027_relay_tunnel_hostname.ts";
import { Migration0028RelayMintPublicKey } from "../src/persistence/migrations/0028_relay_mint_public_key.ts";
import { buildAdvertisedEndpoints } from "../src/lan-auth/advertised-endpoints.ts";

const makeRuntime = () => {
  const SqlLive = SqliteClient.layer({ filename: ":memory:" });
  const Migrated = Layer.effectDiscard(
    Migration0021AuthTokens.pipe(
      Effect.zipRight(Migration0024RemoteConnectState),
      Effect.zipRight(Migration0025RelayEnvironmentKeys),
      Effect.zipRight(Migration0026RelayConnectorToken),
      Effect.zipRight(Migration0027RelayTunnelHostname),
      Effect.zipRight(Migration0028RelayMintPublicKey),
    ),
  ).pipe(Layer.provideMerge(SqlLive));
  const ConfigLive = Layer.succeed(LanAuthConfig, {
    policy: "protected" as const,
    advertisedHost: "192.168.1.10",
    port: 8787,
    pairingBootstrap: false,
  });
  const TestLayer = LanAuthServiceLive.pipe(
    Layer.provideMerge(Migrated),
    Layer.provide(ConfigLive),
    Layer.provide(TestContext.TestContext),
  );
  return ManagedRuntime.make(TestLayer);
};

const withRuntime = async <A>(
  fn: (
    run: <X>(
      effect: Effect.Effect<X, unknown, LanAuthService | SqlClient.SqlClient>,
    ) => Promise<X>,
  ) => Promise<A>,
): Promise<A> => {
  const runtime = makeRuntime();
  const run = <X>(
    effect: Effect.Effect<X, unknown, LanAuthService | SqlClient.SqlClient>,
  ): Promise<X> =>
    runtime.runPromise(effect as Effect.Effect<X, unknown, never>);
  try {
    return await fn(run);
  } finally {
    await runtime.dispose();
  }
};

describe("LanAuthService", () => {
  it("mints hashed bearer tokens and verifies active tokens", async () => {
    await withRuntime(async (run) => {
      const minted = await run(
        Effect.gen(function* () {
          const auth = yield* LanAuthService;
          return yield* auth.mintToken("phone");
        }),
      );

      expect(minted.token.startsWith("zt_")).toBe(true);
      await expect(
        run(
          Effect.gen(function* () {
            const auth = yield* LanAuthService;
            return yield* auth.verifyToken(minted.token);
          }),
        ),
      ).resolves.toBe(true);

      const rows = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly token_hash: string }>`
            SELECT token_hash
            FROM auth_tokens
          `;
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_hash).not.toBe(minted.token);
      expect(JSON.stringify(rows)).not.toContain(minted.token);
    });
  });

  it("revokes tokens and never exposes token hashes in summaries", async () => {
    await withRuntime(async (run) => {
      const minted = await run(
        Effect.gen(function* () {
          const auth = yield* LanAuthService;
          return yield* auth.mintToken("tablet");
        }),
      );

      const summaries = await run(
        Effect.gen(function* () {
          const auth = yield* LanAuthService;
          yield* auth.revokeToken(minted.id);
          return yield* auth.listTokens();
        }),
      );

      expect(
        await run(
          Effect.gen(function* () {
            const auth = yield* LanAuthService;
            return yield* auth.verifyToken(minted.token);
          }),
        ),
      ).toBe(false);
      expect(JSON.stringify(summaries)).not.toContain("token_hash");
      expect(JSON.stringify(summaries)).not.toContain(minted.token);
      expect(summaries[0]!.revokedAt).toBeInstanceOf(Date);
    });
  });

  it("redeems pairing codes once and returns a usable bearer", async () => {
    await withRuntime(async (run) => {
      const result = await run(
        Effect.gen(function* () {
          const auth = yield* LanAuthService;
          const pairing = yield* auth.createPairingCode();
          const redeemed = yield* auth.redeemPairingCode(pairing.code);
          const verified = yield* auth.verifyToken(redeemed.token);
          const second = yield* Effect.either(
            auth.redeemPairingCode(pairing.code),
          );
          return { pairing, redeemed, verified, second };
        }),
      );

      expect(result.pairing.code.startsWith("zp_")).toBe(true);
      expect(result.pairing.qrText).toContain("#token=zp_");
      expect(result.redeemed.token.startsWith("zt_")).toBe(true);
      expect(result.verified).toBe(true);
      expect(Either.isLeft(result.second)).toBe(true);
      if (Either.isLeft(result.second)) {
        expect(result.second.left.reason).toBe("invalid_code");
      }
    });
  });

  it("expires pairing codes using the Effect clock", async () => {
    await withRuntime(async (run) => {
      const result = await run(
        Effect.gen(function* () {
          const auth = yield* LanAuthService;
          const pairing = yield* auth.createPairingCode();
          yield* TestClock.adjust(Duration.minutes(6));
          return yield* Effect.either(auth.redeemPairingCode(pairing.code));
        }),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.reason).toBe("expired_code");
      }
    });
  });

  it("rejects unknown pairing codes", async () => {
    await withRuntime(async (run) => {
      const result = await run(
        Effect.gen(function* () {
          const auth = yield* LanAuthService;
          return yield* Effect.either(auth.redeemPairingCode("zp_missing"));
        }),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.reason).toBe("invalid_code");
      }
    });
  });

  it("creates Ed25519 link proofs and persists relay config for the local environment", async () => {
    await withRuntime(async (run) => {
      const result = await run(
        Effect.gen(function* () {
          const auth = yield* LanAuthService;
          const environmentId = yield* auth.environmentId();
          const keys = yield* auth.environmentKeys();
          const proof = yield* auth.linkProof({
            challenge: "challenge",
            relayIssuer: "https://relay.test",
            endpoint: {
              httpBaseUrl: "http://192.168.1.10:8787",
              wsBaseUrl: "ws://192.168.1.10:8787",
            },
          });
          yield* auth.saveRelayConfig({
            relayUrl: "https://relay.test",
            relayIssuer: "https://relay.test",
            environmentId,
            environmentCredential: "zec_secret",
            label: "Test Mac",
            connectorToken: "connector-token",
            tunnelHostname: "env.example.test",
          });
          const relayConfig = yield* auth.getRelayConfig();
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            readonly relay_url: string;
            readonly label: string | null;
            readonly tunnel_hostname: string | null;
          }>`
            SELECT relay_url, label, tunnel_hostname FROM relay_config WHERE environment_id = ${environmentId}
          `;
          return { proof, rows, keys, relayConfig };
        }),
      );

      // Proof is now an Ed25519 JWT (header.payload.signature), not an HMAC.
      expect(result.proof.proof.split(".")).toHaveLength(3);
      expect(JSON.parse(result.keys.publicJwk).crv).toBe("Ed25519");
      expect(result.rows).toEqual([
        {
          relay_url: "https://relay.test",
          label: "Test Mac",
          tunnel_hostname: "env.example.test",
        },
      ]);
      expect(result.relayConfig?.tunnelHostname).toBe("env.example.test");
    });
  });

  it("verifies relay-issued connect tokens with persisted relay mint key", async () => {
    await withRuntime(async (run) => {
      const mintKey = await generateKeyPair("EdDSA", { extractable: true });
      const mintPublicKey = JSON.stringify(await exportJWK(mintKey.publicKey));
      const environmentId = await run(
        Effect.gen(function* () {
          const auth = yield* LanAuthService;
          const environmentId = yield* auth.environmentId();
          yield* auth.saveRelayConfig({
            relayUrl: "https://relay.test",
            relayIssuer: "https://relay.test",
            environmentId,
            environmentCredential: "zec_secret",
            mintPublicKey,
          });
          return environmentId;
        }),
      );

      const nowSec = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({
        environmentId,
        cnf: { jkt: "thumbprint" },
      })
        .setProtectedHeader({ alg: "EdDSA", typ: "connect+jwt" })
        .setIssuer("https://relay.test")
        .setAudience(`zuse-env:${environmentId}`)
        .setSubject("acct_test")
        .setIssuedAt(nowSec)
        .setExpirationTime(nowSec + 60)
        .sign(mintKey.privateKey);

      await expect(
        run(
          Effect.gen(function* () {
            const auth = yield* LanAuthService;
            return yield* auth.verifyToken(token);
          }),
        ),
      ).resolves.toBe(true);
    });
  });

  it("builds LAN, loopback, and managed tunnel advertised endpoints", () => {
    const endpoints = buildAdvertisedEndpoints({
      lan: {
        policy: "protected",
        advertisedHost: "192.168.1.10",
        port: 8787,
        pairingBootstrap: false,
      },
      relay: {
        linked: true,
        heartbeatActive: true,
        tunnelHostname: "env.example.test",
      },
    });

    expect(endpoints.map((endpoint) => endpoint.id)).toEqual([
      "core:lan",
      "core:loopback",
      "tunnel:managed-relay",
    ]);
    expect(endpoints.find((endpoint) => endpoint.isDefault)?.id).toBe(
      "tunnel:managed-relay",
    );
    expect(
      endpoints.find((endpoint) => endpoint.id === "core:lan"),
    ).toMatchObject({
      httpBaseUrl: "http://192.168.1.10:8787",
      wsBaseUrl: "ws://192.168.1.10:8787",
      reachability: "lan",
      compatibility: { hostedHttpsApp: "mixed-content-blocked" },
    });
    expect(
      endpoints.find((endpoint) => endpoint.id === "tunnel:managed-relay"),
    ).toMatchObject({
      httpBaseUrl: "https://env.example.test",
      wsBaseUrl: "wss://env.example.test",
      reachability: "tunnel",
      compatibility: { hostedHttpsApp: "compatible" },
      status: "available",
    });
  });

  it("falls back to LAN before loopback when no tunnel is advertised", () => {
    const endpoints = buildAdvertisedEndpoints({
      lan: {
        policy: "protected",
        advertisedHost: "192.168.1.10",
        port: 8787,
        pairingBootstrap: false,
      },
    });

    expect(endpoints.find((endpoint) => endpoint.isDefault)?.id).toBe(
      "core:lan",
    );
  });
});

describe("resolveAuthPolicy", () => {
  it("keeps loopback local and protects non-loopback binds", () => {
    expect(resolveAuthPolicy("127.0.0.1")).toBe("local");
    expect(resolveAuthPolicy("::1")).toBe("local");
    expect(resolveAuthPolicy("localhost")).toBe("local");
    expect(resolveAuthPolicy("0.0.0.0")).toBe("protected");
    expect(resolveAuthPolicy("::")).toBe("protected");
    expect(resolveAuthPolicy("192.168.1.12")).toBe("protected");
    expect(resolveAuthPolicy("devbox.local")).toBe("protected");
  });
});
