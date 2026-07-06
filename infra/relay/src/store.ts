import { SqlClient } from "@effect/sql";
import { Context, Effect, Layer, Ref } from "effect";

export type ProviderKind = "desktop" | "ssh" | "cloud";
export type DevicePlatform = "ios" | "android" | "web";
export type ActivityKind =
  | "approval-needed"
  | "question-needed"
  | "completed"
  | "error"
  | "running";

export interface LinkChallengeRecord {
  readonly challengeId: string;
  readonly accountId: string;
  readonly challenge: string;
  readonly relayIssuer: string;
  readonly expiresAtMs: number;
}

export interface EnvironmentRecord {
  readonly environmentId: string;
  readonly accountId: string;
  readonly orgId?: string;
  readonly providerKind: ProviderKind;
  readonly label?: string;
  readonly environmentPublicKey: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly tunnelHostname?: string;
  readonly tunnelId?: string;
  readonly dnsRecordId?: string;
  readonly tunnelStatus?: "reserved" | "ready";
  readonly linkedAtMs: number;
  readonly lastSeenAtMs?: number;
}

export interface TunnelAllocation {
  readonly tunnelHostname: string;
  readonly tunnelId: string;
  readonly dnsRecordId?: string;
  readonly tunnelStatus: "reserved" | "ready";
}

export interface CredentialRecord {
  readonly credentialId: string;
  readonly environmentId: string;
  readonly accountId: string;
  readonly credentialHash: string;
  readonly createdAtMs: number;
  readonly revokedAtMs?: number;
}

export interface DeviceRecord {
  readonly deviceId: string;
  readonly accountId: string;
  readonly platform: DevicePlatform;
  readonly pushToken?: string;
  readonly dpopJwk?: unknown;
  readonly updatedAtMs: number;
}

export interface ActivityRecord {
  readonly environmentId: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly kind: ActivityKind;
  readonly title?: string;
  readonly occurredAtMs: number;
}

export interface RelayStoreApi {
  readonly createChallenge: (challenge: LinkChallengeRecord) => Effect.Effect<void>;
  /** Single-use: returns the challenge and deletes it, only if it belongs to `accountId`. */
  readonly consumeChallenge: (
    challengeId: string,
    accountId: string,
  ) => Effect.Effect<LinkChallengeRecord | null>;
  readonly upsertEnvironment: (environment: EnvironmentRecord) => Effect.Effect<void>;
  readonly listEnvironments: (
    accountId: string,
  ) => Effect.Effect<ReadonlyArray<EnvironmentRecord>>;
  readonly getEnvironment: (
    environmentId: string,
  ) => Effect.Effect<EnvironmentRecord | null>;
  readonly touchEnvironment: (
    environmentId: string,
    lastSeenAtMs: number,
  ) => Effect.Effect<void>;
  /** Persist the managed-tunnel allocation for an environment. */
  readonly setTunnelAllocation: (
    environmentId: string,
    allocation: TunnelAllocation,
  ) => Effect.Effect<void>;
  /** Clear the managed-tunnel allocation (on unlink / deprovision). */
  readonly clearTunnelAllocation: (
    environmentId: string,
  ) => Effect.Effect<void>;
  /** Delete an environment (and cascade its credentials) — on unlink. */
  readonly deleteEnvironment: (
    environmentId: string,
    accountId: string,
  ) => Effect.Effect<void>;
  readonly insertCredential: (credential: CredentialRecord) => Effect.Effect<void>;
  readonly findActiveCredentialByHash: (
    credentialHash: string,
  ) => Effect.Effect<CredentialRecord | null>;
  readonly upsertDevice: (device: DeviceRecord) => Effect.Effect<void>;
  readonly listDevices: (
    accountId: string,
  ) => Effect.Effect<ReadonlyArray<DeviceRecord>>;
  /** Returns true if the (thumbprint, jti) was fresh; false if it was a replay. */
  readonly consumeDpopProof: (input: {
    readonly thumbprint: string;
    readonly jti: string;
    readonly issuedAtMs: number;
    readonly expiresAtMs: number;
  }) => Effect.Effect<boolean>;
  readonly recordActivity: (activity: ActivityRecord) => Effect.Effect<void>;
}

export class RelayStore extends Context.Tag("@zuse/relay/RelayStore")<
  RelayStore,
  RelayStoreApi
>() {}

// ---------------------------------------------------------------------------
// In-memory implementation (tests + local dev).
// ---------------------------------------------------------------------------

export const RelayStoreMemory: Layer.Layer<RelayStore> = Layer.effect(
  RelayStore,
  Effect.gen(function* () {
    const challenges = yield* Ref.make(new Map<string, LinkChallengeRecord>());
    const environments = yield* Ref.make(new Map<string, EnvironmentRecord>());
    const credentials = yield* Ref.make(new Map<string, CredentialRecord>());
    const devices = yield* Ref.make(new Map<string, DeviceRecord>());
    const dpop = yield* Ref.make(new Set<string>());
    const activities = yield* Ref.make<ActivityRecord[]>([]);

    return RelayStore.of({
      createChallenge: (challenge) =>
        Ref.update(challenges, (map) =>
          new Map(map).set(challenge.challengeId, challenge),
        ),
      consumeChallenge: (challengeId, accountId) =>
        Ref.modify(challenges, (map) => {
          const found = map.get(challengeId) ?? null;
          if (found === null || found.accountId !== accountId) return [null, map];
          const next = new Map(map);
          next.delete(challengeId);
          return [found, next];
        }),
      upsertEnvironment: (environment) =>
        Ref.update(environments, (map) =>
          new Map(map).set(environment.environmentId, environment),
        ),
      listEnvironments: (accountId) =>
        Ref.get(environments).pipe(
          Effect.map((map) =>
            [...map.values()].filter((env) => env.accountId === accountId),
          ),
        ),
      getEnvironment: (environmentId) =>
        Ref.get(environments).pipe(
          Effect.map((map) => map.get(environmentId) ?? null),
        ),
      touchEnvironment: (environmentId, lastSeenAtMs) =>
        Ref.update(environments, (map) => {
          const found = map.get(environmentId);
          if (found === undefined) return map;
          return new Map(map).set(environmentId, { ...found, lastSeenAtMs });
        }),
      setTunnelAllocation: (environmentId, allocation) =>
        Ref.update(environments, (map) => {
          const found = map.get(environmentId);
          if (found === undefined) return map;
          return new Map(map).set(environmentId, {
            ...found,
            tunnelHostname: allocation.tunnelHostname,
            tunnelId: allocation.tunnelId,
            dnsRecordId: allocation.dnsRecordId,
            tunnelStatus: allocation.tunnelStatus,
          });
        }),
      clearTunnelAllocation: (environmentId) =>
        Ref.update(environments, (map) => {
          const found = map.get(environmentId);
          if (found === undefined) return map;
          return new Map(map).set(environmentId, {
            ...found,
            tunnelHostname: undefined,
            tunnelId: undefined,
            dnsRecordId: undefined,
            tunnelStatus: undefined,
          });
        }),
      deleteEnvironment: (environmentId, accountId) =>
        Effect.zipRight(
          Ref.update(environments, (map) => {
            const found = map.get(environmentId);
            if (found === undefined || found.accountId !== accountId) return map;
            const next = new Map(map);
            next.delete(environmentId);
            return next;
          }),
          Ref.update(credentials, (map) => {
            const next = new Map(map);
            for (const [id, cred] of map) {
              if (cred.environmentId === environmentId) next.delete(id);
            }
            return next;
          }),
        ),
      insertCredential: (credential) =>
        Ref.update(credentials, (map) =>
          new Map(map).set(credential.credentialId, credential),
        ),
      findActiveCredentialByHash: (credentialHash) =>
        Ref.get(credentials).pipe(
          Effect.map(
            (map) =>
              [...map.values()].find(
                (cred) =>
                  cred.credentialHash === credentialHash &&
                  cred.revokedAtMs === undefined,
              ) ?? null,
          ),
        ),
      upsertDevice: (device) =>
        Ref.update(devices, (map) => new Map(map).set(device.deviceId, device)),
      listDevices: (accountId) =>
        Ref.get(devices).pipe(
          Effect.map((map) =>
            [...map.values()].filter((device) => device.accountId === accountId),
          ),
        ),
      consumeDpopProof: (input) =>
        Ref.modify(dpop, (set) => {
          const key = `${input.thumbprint}|${input.jti}`;
          if (set.has(key)) return [false, set];
          const next = new Set(set);
          next.add(key);
          return [true, next];
        }),
      recordActivity: (activity) =>
        Ref.update(activities, (list) => [...list, activity]),
    });
  }),
);

// ---------------------------------------------------------------------------
// Postgres implementation (production, via @effect/sql-pg + Hyperdrive).
// ---------------------------------------------------------------------------

interface EnvironmentRow {
  readonly environment_id: string;
  readonly account_id: string;
  readonly org_id: string | null;
  readonly provider_kind: ProviderKind;
  readonly label: string | null;
  readonly environment_public_key: string;
  readonly http_base_url: string;
  readonly ws_base_url: string;
  readonly tunnel_hostname: string | null;
  readonly tunnel_id: string | null;
  readonly dns_record_id: string | null;
  readonly tunnel_status: "reserved" | "ready" | null;
  readonly linked_at: number;
  readonly last_seen_at: number | null;
}

const toEnvironment = (row: EnvironmentRow): EnvironmentRecord => ({
  environmentId: row.environment_id,
  accountId: row.account_id,
  orgId: row.org_id ?? undefined,
  providerKind: row.provider_kind,
  label: row.label ?? undefined,
  environmentPublicKey: row.environment_public_key,
  httpBaseUrl: row.http_base_url,
  wsBaseUrl: row.ws_base_url,
  tunnelHostname: row.tunnel_hostname ?? undefined,
  tunnelId: row.tunnel_id ?? undefined,
  dnsRecordId: row.dns_record_id ?? undefined,
  tunnelStatus: row.tunnel_status ?? undefined,
  linkedAtMs: Number(row.linked_at),
  lastSeenAtMs: row.last_seen_at === null ? undefined : Number(row.last_seen_at),
});

export const RelayStorePg: Layer.Layer<RelayStore, never, SqlClient.SqlClient> =
  Layer.effect(
    RelayStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const orDie = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A> =>
        effect.pipe(Effect.orDie);

      return RelayStore.of({
        createChallenge: (challenge) =>
          orDie(sql`
            INSERT INTO relay_link_challenges
              (challenge_id, account_id, challenge, relay_issuer, expires_at)
            VALUES (
              ${challenge.challengeId}, ${challenge.accountId}, ${challenge.challenge},
              ${challenge.relayIssuer}, ${challenge.expiresAtMs}
            )
          `.pipe(Effect.asVoid)),
        consumeChallenge: (challengeId, accountId) =>
          orDie(
            sql<{
              readonly challenge_id: string;
              readonly account_id: string;
              readonly challenge: string;
              readonly relay_issuer: string;
              readonly expires_at: number;
            }>`
              DELETE FROM relay_link_challenges
              WHERE challenge_id = ${challengeId} AND account_id = ${accountId}
              RETURNING challenge_id, account_id, challenge, relay_issuer, expires_at
            `.pipe(
              Effect.map((rows) => {
                const row = rows[0];
                if (row === undefined) return null;
                return {
                  challengeId: row.challenge_id,
                  accountId: row.account_id,
                  challenge: row.challenge,
                  relayIssuer: row.relay_issuer,
                  expiresAtMs: Number(row.expires_at),
                } satisfies LinkChallengeRecord;
              }),
            ),
          ),
        upsertEnvironment: (env) =>
          orDie(sql`
            INSERT INTO relay_environments
              (environment_id, account_id, org_id, provider_kind, label,
               environment_public_key, http_base_url, ws_base_url, tunnel_hostname,
               linked_at, last_seen_at)
            VALUES (
              ${env.environmentId}, ${env.accountId}, ${env.orgId ?? null},
              ${env.providerKind}, ${env.label ?? null}, ${env.environmentPublicKey},
              ${env.httpBaseUrl}, ${env.wsBaseUrl}, ${env.tunnelHostname ?? null},
              ${env.linkedAtMs}, ${env.lastSeenAtMs ?? null}
            )
            ON CONFLICT (environment_id) DO UPDATE SET
              account_id = EXCLUDED.account_id,
              org_id = EXCLUDED.org_id,
              provider_kind = EXCLUDED.provider_kind,
              label = EXCLUDED.label,
              environment_public_key = EXCLUDED.environment_public_key,
              http_base_url = EXCLUDED.http_base_url,
              ws_base_url = EXCLUDED.ws_base_url,
              linked_at = EXCLUDED.linked_at
          `.pipe(Effect.asVoid)),
        listEnvironments: (accountId) =>
          orDie(
            sql<EnvironmentRow>`
              SELECT * FROM relay_environments
              WHERE account_id = ${accountId}
              ORDER BY linked_at DESC
            `.pipe(Effect.map((rows) => rows.map(toEnvironment))),
          ),
        getEnvironment: (environmentId) =>
          orDie(
            sql<EnvironmentRow>`
              SELECT * FROM relay_environments WHERE environment_id = ${environmentId}
            `.pipe(
              Effect.map((rows) => (rows[0] ? toEnvironment(rows[0]) : null)),
            ),
          ),
        touchEnvironment: (environmentId, lastSeenAtMs) =>
          orDie(sql`
            UPDATE relay_environments SET last_seen_at = ${lastSeenAtMs}
            WHERE environment_id = ${environmentId}
          `.pipe(Effect.asVoid)),
        setTunnelAllocation: (environmentId, allocation) =>
          orDie(sql`
            UPDATE relay_environments SET
              tunnel_hostname = ${allocation.tunnelHostname},
              tunnel_id = ${allocation.tunnelId},
              dns_record_id = ${allocation.dnsRecordId ?? null},
              tunnel_status = ${allocation.tunnelStatus}
            WHERE environment_id = ${environmentId}
          `.pipe(Effect.asVoid)),
        clearTunnelAllocation: (environmentId) =>
          orDie(sql`
            UPDATE relay_environments SET
              tunnel_hostname = NULL,
              tunnel_id = NULL,
              dns_record_id = NULL,
              tunnel_status = NULL
            WHERE environment_id = ${environmentId}
          `.pipe(Effect.asVoid)),
        deleteEnvironment: (environmentId, accountId) =>
          orDie(sql`
            DELETE FROM relay_environments
            WHERE environment_id = ${environmentId} AND account_id = ${accountId}
          `.pipe(Effect.asVoid)),
        insertCredential: (cred) =>
          orDie(sql`
            INSERT INTO relay_environment_credentials
              (credential_id, environment_id, account_id, credential_hash, created_at)
            VALUES (
              ${cred.credentialId}, ${cred.environmentId}, ${cred.accountId},
              ${cred.credentialHash}, ${cred.createdAtMs}
            )
          `.pipe(Effect.asVoid)),
        findActiveCredentialByHash: (credentialHash) =>
          orDie(
            sql<{
              readonly credential_id: string;
              readonly environment_id: string;
              readonly account_id: string;
              readonly credential_hash: string;
              readonly created_at: number;
              readonly revoked_at: number | null;
            }>`
              SELECT * FROM relay_environment_credentials
              WHERE credential_hash = ${credentialHash} AND revoked_at IS NULL
            `.pipe(
              Effect.map((rows) => {
                const row = rows[0];
                if (row === undefined) return null;
                return {
                  credentialId: row.credential_id,
                  environmentId: row.environment_id,
                  accountId: row.account_id,
                  credentialHash: row.credential_hash,
                  createdAtMs: Number(row.created_at),
                  revokedAtMs:
                    row.revoked_at === null ? undefined : Number(row.revoked_at),
                } satisfies CredentialRecord;
              }),
            ),
          ),
        upsertDevice: (device) =>
          orDie(sql`
            INSERT INTO relay_devices
              (device_id, account_id, platform, push_token, dpop_jwk, updated_at)
            VALUES (
              ${device.deviceId}, ${device.accountId}, ${device.platform},
              ${device.pushToken ?? null},
              ${device.dpopJwk === undefined ? null : JSON.stringify(device.dpopJwk)},
              ${device.updatedAtMs}
            )
            ON CONFLICT (device_id) DO UPDATE SET
              account_id = EXCLUDED.account_id,
              platform = EXCLUDED.platform,
              push_token = EXCLUDED.push_token,
              dpop_jwk = EXCLUDED.dpop_jwk,
              updated_at = EXCLUDED.updated_at
          `.pipe(Effect.asVoid)),
        listDevices: (accountId) =>
          orDie(
            sql<{
              readonly device_id: string;
              readonly account_id: string;
              readonly platform: DevicePlatform;
              readonly push_token: string | null;
              readonly dpop_jwk: unknown;
              readonly updated_at: number;
            }>`
              SELECT * FROM relay_devices WHERE account_id = ${accountId}
            `.pipe(
              Effect.map((rows) =>
                rows.map((row) => ({
                  deviceId: row.device_id,
                  accountId: row.account_id,
                  platform: row.platform,
                  pushToken: row.push_token ?? undefined,
                  dpopJwk: row.dpop_jwk ?? undefined,
                  updatedAtMs: Number(row.updated_at),
                })),
              ),
            ),
          ),
        consumeDpopProof: (input) =>
          orDie(
            sql<{ readonly jti: string }>`
              INSERT INTO relay_dpop_proofs (thumbprint, jti, issued_at, expires_at)
              VALUES (${input.thumbprint}, ${input.jti}, ${input.issuedAtMs}, ${input.expiresAtMs})
              ON CONFLICT (thumbprint, jti) DO NOTHING
              RETURNING jti
            `.pipe(Effect.map((rows) => rows.length > 0)),
          ),
        recordActivity: (activity) =>
          orDie(sql`
            INSERT INTO relay_agent_activity
              (environment_id, account_id, session_id, kind, title, occurred_at)
            VALUES (
              ${activity.environmentId}, ${activity.accountId}, ${activity.sessionId},
              ${activity.kind}, ${activity.title ?? null}, ${activity.occurredAtMs}
            )
          `.pipe(Effect.asVoid)),
      });
    }),
  );
