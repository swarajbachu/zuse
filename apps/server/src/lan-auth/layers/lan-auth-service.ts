import { SqlClient } from "@effect/sql";
import { Clock, Effect, Layer, Ref } from "effect";
import { createHash, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

import {
  AuthTokenSummary,
  type AuthTokenId,
  type EnvironmentId,
} from "@zuse/wire";

import {
  LanAuthConfig,
  LanAuthError,
  LanAuthService,
  PairingRedeemError,
} from "../services/lan-auth-service.ts";
import {
  generateEnvironmentKeypair,
  signEnvironmentLinkProof,
} from "../../relay/link-proof.ts";

const PAIRING_TTL_MS = 5 * 60 * 1000;

interface TokenRow {
  readonly id: string;
  readonly label: string | null;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

interface EnvironmentIdentityRow {
  readonly id: string;
  readonly signing_secret: string | null;
}

interface EnvironmentKeyRow {
  readonly private_key_jwk: string | null;
  readonly public_key_jwk: string | null;
}

interface PairingCodeState {
  readonly expiresAtMs: number;
}

const randomBase64Url = (bytes: number): Effect.Effect<string> =>
  Effect.sync(() => randomBytes(bytes).toString("base64url"));

const tokenHash = (token: string): Effect.Effect<string> =>
  Effect.sync(() => createHash("sha256").update(token).digest("hex"));

const nowIso = Effect.map(Clock.currentTimeMillis, (ms) =>
  new Date(ms).toISOString(),
);

const toLanAuthError = (cause: unknown): LanAuthError =>
  new LanAuthError({
    reason: cause instanceof Error ? cause.message : String(cause),
  });

const firstNonInternalIpv4 = (): string | null => {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return null;
};

const configuredHost = (
  advertisedHost: string | null,
): Effect.Effect<string, LanAuthError> =>
  Effect.sync(() => advertisedHost ?? firstNonInternalIpv4()).pipe(
    Effect.flatMap((host) =>
      host === null
        ? Effect.fail(new LanAuthError({ reason: "no_advertised_host" }))
        : Effect.succeed(host),
    ),
  );

export const LanAuthServiceLive = Layer.effect(
  LanAuthService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* LanAuthConfig;
    const pairingCodes = yield* Ref.make(new Map<string, PairingCodeState>());

    const mintToken = (label?: string) =>
      Effect.gen(function* () {
        const id = `auth_${yield* randomBase64Url(16)}` as AuthTokenId;
        const token = `zt_${yield* randomBase64Url(32)}`;
        const hash = yield* tokenHash(token);
        const createdAt = yield* nowIso;
        yield* sql`
          INSERT INTO auth_tokens
            (id, token_hash, label, created_at, last_used_at, revoked_at)
          VALUES
            (${id}, ${hash}, ${label ?? null}, ${createdAt}, NULL, NULL)
        `;
        return { id, token } as const;
      }).pipe(Effect.mapError(toLanAuthError));

    const environmentId = () =>
      Effect.gen(function* () {
        const existing = yield* sql<EnvironmentIdentityRow>`
          SELECT id, signing_secret
          FROM environment_identity
          ORDER BY created_at ASC
          LIMIT 1
        `;
        if (existing[0]?.id !== undefined) {
          if (existing[0].signing_secret === null) {
            const secret = yield* randomBase64Url(32);
            yield* sql`
              UPDATE environment_identity
              SET signing_secret = ${secret}
              WHERE id = ${existing[0].id}
            `;
          }
          return existing[0].id as EnvironmentId;
        }

        const id = `env_${yield* randomBase64Url(16)}` as EnvironmentId;
        const signingSecret = yield* randomBase64Url(32);
        const createdAt = yield* nowIso;
        yield* sql`
          INSERT INTO environment_identity (id, created_at, signing_secret)
          VALUES (${id}, ${createdAt}, ${signingSecret})
        `;
        return id;
      }).pipe(Effect.mapError(toLanAuthError));

    const environmentKeys = () =>
      Effect.gen(function* () {
        const envId = yield* environmentId();
        const rows = yield* sql<EnvironmentKeyRow>`
          SELECT private_key_jwk, public_key_jwk
          FROM environment_identity
          WHERE id = ${envId}
          LIMIT 1
        `;
        if (
          rows[0]?.private_key_jwk != null &&
          rows[0]?.public_key_jwk != null
        ) {
          return {
            envId,
            privateJwk: rows[0].private_key_jwk,
            publicJwk: rows[0].public_key_jwk,
          } as const;
        }
        const keypair = yield* generateEnvironmentKeypair();
        yield* sql`
          UPDATE environment_identity
          SET private_key_jwk = ${keypair.privateJwk},
              public_key_jwk = ${keypair.publicJwk}
          WHERE id = ${envId}
        `;
        return { envId, ...keypair } as const;
      }).pipe(Effect.mapError(toLanAuthError));

    const makePairingUrls = (code: string) =>
      Effect.gen(function* () {
        if (config.port === null) {
          return yield* Effect.fail(
            new LanAuthError({ reason: "no_pairing_endpoint" }),
          );
        }
        const host = yield* configuredHost(config.advertisedHost);
        const pairingUrl = `ws://${host}:${config.port}`;
        const qrText = `zuse://?pairingUrl=${encodeURIComponent(
          pairingUrl,
        )}#token=${code}`;
        return { pairingUrl, qrText } as const;
      });

    const service = LanAuthService.of({
      policy: config.policy,
      pairingBootstrap: config.pairingBootstrap,
      mintToken,
      verifyToken: (token) =>
        Effect.gen(function* () {
          const hash = yield* tokenHash(token);
          const rows = yield* sql<{ readonly id: string }>`
            SELECT id
            FROM auth_tokens
            WHERE token_hash = ${hash}
              AND revoked_at IS NULL
            LIMIT 1
          `;
          if (rows.length === 0) return false;
          const usedAt = yield* nowIso;
          yield* sql`
            UPDATE auth_tokens
            SET last_used_at = ${usedAt}
            WHERE id = ${rows[0]!.id}
          `;
          return true;
        }).pipe(Effect.mapError(toLanAuthError)),
      listTokens: () =>
        Effect.gen(function* () {
          const rows = yield* sql<TokenRow>`
            SELECT id, label, created_at, last_used_at, revoked_at
            FROM auth_tokens
            ORDER BY created_at DESC
          `;
          return rows.map((row) =>
            AuthTokenSummary.make({
              id: row.id as AuthTokenId,
              label: row.label ?? undefined,
              createdAt: new Date(row.created_at),
              lastUsedAt:
                row.last_used_at === null
                  ? undefined
                  : new Date(row.last_used_at),
              revokedAt:
                row.revoked_at === null ? undefined : new Date(row.revoked_at),
            }),
          );
        }).pipe(Effect.mapError(toLanAuthError)),
      revokeToken: (id) =>
        Effect.gen(function* () {
          const revokedAt = yield* nowIso;
          yield* sql`
            UPDATE auth_tokens
            SET revoked_at = COALESCE(revoked_at, ${revokedAt})
            WHERE id = ${id}
          `;
        }).pipe(Effect.asVoid, Effect.mapError(toLanAuthError)),
      hasActiveTokens: () =>
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly id: string }>`
            SELECT id
            FROM auth_tokens
            WHERE revoked_at IS NULL
            LIMIT 1
          `;
          return rows.length > 0;
        }).pipe(Effect.mapError(toLanAuthError)),
      createPairingCode: () =>
        Effect.gen(function* () {
          const code = `zp_${yield* randomBase64Url(16)}`;
          const now = yield* Clock.currentTimeMillis;
          const expiresAtMs = now + PAIRING_TTL_MS;
          const urls = yield* makePairingUrls(code);
          yield* Ref.update(pairingCodes, (codes) => {
            const next = new Map(codes);
            next.set(code, { expiresAtMs });
            return next;
          });
          return {
            code,
            expiresAt: new Date(expiresAtMs),
            pairingUrl: urls.pairingUrl,
            qrText: urls.qrText,
          } as const;
        }).pipe(Effect.mapError(toLanAuthError)),
      redeemPairingCode: (code) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const status = yield* Ref.modify(pairingCodes, (codes) => {
            const entry = codes.get(code);
            if (entry === undefined) return ["invalid" as const, codes];
            const next = new Map(codes);
            next.delete(code);
            if (entry.expiresAtMs <= now) return ["expired" as const, next];
            return ["valid" as const, next];
          });

          if (status === "invalid") {
            return yield* Effect.fail(
              new PairingRedeemError({ reason: "invalid_code" }),
            );
          }
          if (status === "expired") {
            return yield* Effect.fail(
              new PairingRedeemError({ reason: "expired_code" }),
            );
          }

          const minted = yield* mintToken("paired device");
          const envId = yield* environmentId();
          return { token: minted.token, environmentId: envId } as const;
        }),
      environmentId,
      environmentKeys,
      linkProof: (input) =>
        Effect.gen(function* () {
          const { envId, privateJwk } = yield* environmentKeys();
          const nowMs = yield* Clock.currentTimeMillis;
          const proof = yield* signEnvironmentLinkProof({
            privateJwk,
            challenge: input.challenge,
            environmentId: envId,
            relayIssuer: input.relayIssuer,
            nowMs,
          });
          return { proof } as const;
        }).pipe(Effect.mapError(toLanAuthError)),
      saveRelayConfig: (input) =>
        Effect.gen(function* () {
          const actualEnvironmentId = yield* environmentId();
          if (input.environmentId !== actualEnvironmentId) {
            return yield* Effect.fail(
              new LanAuthError({ reason: "environment_id_mismatch" }),
            );
          }
          const updatedAt = yield* nowIso;
          yield* sql`
            INSERT INTO relay_config
              (environment_id, relay_url, relay_issuer, environment_credential, label, connector_token, updated_at)
            VALUES
              (${input.environmentId}, ${input.relayUrl}, ${input.relayIssuer},
               ${input.environmentCredential}, ${input.label ?? null},
               ${input.connectorToken ?? null}, ${updatedAt})
            ON CONFLICT(environment_id) DO UPDATE SET
              relay_url = excluded.relay_url,
              relay_issuer = excluded.relay_issuer,
              environment_credential = excluded.environment_credential,
              label = excluded.label,
              connector_token = excluded.connector_token,
              updated_at = excluded.updated_at
          `;
        }).pipe(Effect.asVoid, Effect.mapError(toLanAuthError)),
      getRelayConfig: () =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly relay_url: string;
            readonly relay_issuer: string;
            readonly environment_id: string;
            readonly environment_credential: string;
            readonly label: string | null;
            readonly connector_token: string | null;
          }>`
            SELECT relay_url, relay_issuer, environment_id, environment_credential, label, connector_token
            FROM relay_config
            LIMIT 1
          `;
          const row = rows[0];
          if (row === undefined) return null;
          return {
            relayUrl: row.relay_url,
            relayIssuer: row.relay_issuer,
            environmentId: row.environment_id as EnvironmentId,
            environmentCredential: row.environment_credential,
            label: row.label ?? undefined,
            connectorToken: row.connector_token ?? undefined,
          };
        }).pipe(Effect.mapError(toLanAuthError)),
      clearRelayConfig: () =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM relay_config`;
        }).pipe(Effect.asVoid, Effect.mapError(toLanAuthError)),
    });

    return service;
  }),
);
