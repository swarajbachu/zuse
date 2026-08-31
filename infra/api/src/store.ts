import { Context, Effect, Layer, Ref } from "effect";
import { SqlClient } from "effect/unstable/sql";

export type ProviderKind = "desktop" | "ssh" | "cloud";
export type DevicePlatform = "ios" | "android" | "web" | "desktop";
export type ServiceState =
	| "starting"
	| "healthy"
	| "degraded"
	| "stopped"
	| "updating";
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
	readonly apiIssuer: string;
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
	readonly privateHttpBaseUrl?: string;
	readonly privateWsBaseUrl?: string;
	readonly tunnelHostname?: string;
	readonly tunnelId?: string;
	readonly dnsRecordId?: string;
	readonly tunnelStatus?: "reserved" | "ready";
	readonly linkedAtMs: number;
	readonly lastSeenAtMs?: number;
	readonly runtimeVersion?: string;
	readonly wireProtocolVersion?: number;
	readonly capabilities?: unknown;
	readonly serviceState?: ServiceState;
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
	readonly dpopThumbprint: string;
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

export type EnvironmentRegistrationMode =
	| "replace-same-account"
	| "preserve-identity";

export interface ApiStoreApi {
	readonly createChallenge: (
		challenge: LinkChallengeRecord,
	) => Effect.Effect<void>;
	/** Single-use: returns the challenge and deletes it, only if it belongs to `accountId`. */
	readonly consumeChallenge: (
		challengeId: string,
		accountId: string,
	) => Effect.Effect<LinkChallengeRecord | null>;
	readonly registerEnvironment: (
		environment: EnvironmentRecord,
		maxEnvironmentsPerAccount: number | null,
		mode: EnvironmentRegistrationMode,
	) => Effect.Effect<boolean>;
	readonly listEnvironments: (
		accountId: string,
	) => Effect.Effect<ReadonlyArray<EnvironmentRecord>>;
	readonly getEnvironment: (
		environmentId: string,
	) => Effect.Effect<EnvironmentRecord | null>;
	readonly touchEnvironment: (
		environmentId: string,
		lastSeenAtMs: number,
		metadata?: {
			readonly runtimeVersion?: string;
			readonly wireProtocolVersion?: number;
			readonly capabilities?: unknown;
			readonly serviceState?: ServiceState;
		},
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
	readonly setPrivateEndpoint: (
		environmentId: string,
		endpoint:
			| {
					readonly httpBaseUrl: string;
					readonly wsBaseUrl: string;
			  }
			| undefined,
	) => Effect.Effect<void>;
	/** Delete an environment (and cascade its credentials) — on unlink. */
	readonly deleteEnvironment: (
		environmentId: string,
		accountId: string,
	) => Effect.Effect<void>;
	readonly insertCredential: (
		credential: CredentialRecord,
	) => Effect.Effect<void>;
	readonly findActiveCredentialByHash: (
		credentialHash: string,
	) => Effect.Effect<CredentialRecord | null>;
	readonly revokeEnvironmentCredentials: (
		environmentId: string,
		revokedAtMs: number,
	) => Effect.Effect<void>;
	readonly upsertDevice: (device: DeviceRecord) => Effect.Effect<boolean>;
	readonly listDevices: (
		accountId: string,
	) => Effect.Effect<ReadonlyArray<DeviceRecord>>;
	readonly revokeDevice: (
		deviceId: string,
		accountId: string,
	) => Effect.Effect<boolean>;
	readonly isDpopThumbprintRevoked: (
		thumbprint: string,
	) => Effect.Effect<boolean>;
	/** Returns true if the (thumbprint, jti) was fresh; false if it was a replay. */
	readonly consumeDpopProof: (input: {
		readonly thumbprint: string;
		readonly jti: string;
		readonly issuedAtMs: number;
		readonly expiresAtMs: number;
	}) => Effect.Effect<boolean>;
	readonly recordActivity: (activity: ActivityRecord) => Effect.Effect<void>;
	/** Delete every api-owned record for an account. Safe to call repeatedly. */
	readonly deleteAccountData: (accountId: string) => Effect.Effect<void>;
}

export class ApiStore extends Context.Service<ApiStore, ApiStoreApi>()(
	"@zuse/api/ApiStore",
) {}

// ---------------------------------------------------------------------------
// In-memory implementation (tests + local dev).
// ---------------------------------------------------------------------------

export const ApiStoreMemory: Layer.Layer<ApiStore> = Layer.effect(
	ApiStore,
	Effect.gen(function* () {
		const challenges = yield* Ref.make(new Map<string, LinkChallengeRecord>());
		const environments = yield* Ref.make(new Map<string, EnvironmentRecord>());
		const credentials = yield* Ref.make(new Map<string, CredentialRecord>());
		const devices = yield* Ref.make(new Map<string, DeviceRecord>());
		const revokedDpopThumbprints = yield* Ref.make(new Set<string>());
		const dpop = yield* Ref.make(new Set<string>());
		const activities = yield* Ref.make<ActivityRecord[]>([]);

		return ApiStore.of({
			createChallenge: (challenge) =>
				Ref.update(challenges, (map) =>
					new Map(map).set(challenge.challengeId, challenge),
				),
			consumeChallenge: (challengeId, accountId) =>
				Ref.modify(challenges, (map) => {
					const found = map.get(challengeId) ?? null;
					if (found === null || found.accountId !== accountId)
						return [null, map];
					const next = new Map(map);
					next.delete(challengeId);
					return [found, next];
				}),
			registerEnvironment: (environment, maxEnvironmentsPerAccount, mode) =>
				Ref.modify(environments, (map) => {
					const current = map.get(environment.environmentId);
					if (
						current !== undefined &&
						(current.accountId !== environment.accountId ||
							(mode === "preserve-identity" &&
								(current.providerKind !== environment.providerKind ||
									current.environmentPublicKey !==
										environment.environmentPublicKey)))
					) {
						return [false, map];
					}
					const accountCount = [...map.values()].filter(
						(candidate) => candidate.accountId === environment.accountId,
					).length;
					if (
						current === undefined &&
						maxEnvironmentsPerAccount !== null &&
						accountCount >= maxEnvironmentsPerAccount
					) {
						return [false, map];
					}
					return [
						true,
						new Map(map).set(environment.environmentId, {
							...current,
							...environment,
							privateHttpBaseUrl: current?.privateHttpBaseUrl,
							privateWsBaseUrl: current?.privateWsBaseUrl,
							tunnelHostname: current?.tunnelHostname,
							tunnelId: current?.tunnelId,
							dnsRecordId: current?.dnsRecordId,
							tunnelStatus: current?.tunnelStatus,
							lastSeenAtMs: current?.lastSeenAtMs,
						}),
					];
				}),
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
			touchEnvironment: (environmentId, lastSeenAtMs, metadata) =>
				Ref.update(environments, (map) => {
					const found = map.get(environmentId);
					if (found === undefined) return map;
					return new Map(map).set(environmentId, {
						...found,
						...metadata,
						lastSeenAtMs,
					});
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
			setPrivateEndpoint: (environmentId, endpoint) =>
				Ref.update(environments, (map) => {
					const found = map.get(environmentId);
					if (found === undefined) return map;
					return new Map(map).set(environmentId, {
						...found,
						privateHttpBaseUrl: endpoint?.httpBaseUrl,
						privateWsBaseUrl: endpoint?.wsBaseUrl,
					});
				}),
			deleteEnvironment: (environmentId, accountId) =>
				Effect.andThen(
					Ref.update(environments, (map) => {
						const found = map.get(environmentId);
						if (found === undefined || found.accountId !== accountId)
							return map;
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
			revokeEnvironmentCredentials: (environmentId, revokedAtMs) =>
				Ref.update(credentials, (map) => {
					const next = new Map(map);
					for (const [id, credential] of map) {
						if (
							credential.environmentId === environmentId &&
							credential.revokedAtMs === undefined
						) {
							next.set(id, { ...credential, revokedAtMs });
						}
					}
					return next;
				}),
			upsertDevice: (device) =>
				Ref.modify(devices, (map) => {
					const current = map.get(device.deviceId);
					if (current !== undefined && current.accountId !== device.accountId) {
						return [false, map];
					}
					return [true, new Map(map).set(device.deviceId, device)];
				}),
			listDevices: (accountId) =>
				Ref.get(devices).pipe(
					Effect.map((map) =>
						[...map.values()].filter(
							(device) => device.accountId === accountId,
						),
					),
				),
			revokeDevice: (deviceId, accountId) =>
				Ref.modify(devices, (map) => {
					const found = map.get(deviceId);
					if (found === undefined || found.accountId !== accountId) {
						return [null, map] as const;
					}
					const next = new Map(map);
					next.delete(deviceId);
					return [found.dpopThumbprint, next] as const;
				}).pipe(
					Effect.flatMap((thumbprint) =>
						thumbprint === null
							? Effect.succeed(false)
							: Ref.update(revokedDpopThumbprints, (set) =>
									new Set(set).add(thumbprint),
								).pipe(Effect.as(true)),
					),
				),
			isDpopThumbprintRevoked: (thumbprint) =>
				Ref.get(revokedDpopThumbprints).pipe(
					Effect.map((set) => set.has(thumbprint)),
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
			deleteAccountData: (accountId) =>
				Effect.all(
					[
						Ref.update(
							challenges,
							(map) =>
								new Map(
									[...map].filter(([, value]) => value.accountId !== accountId),
								),
						),
						Ref.update(
							environments,
							(map) =>
								new Map(
									[...map].filter(([, value]) => value.accountId !== accountId),
								),
						),
						Ref.update(
							credentials,
							(map) =>
								new Map(
									[...map].filter(([, value]) => value.accountId !== accountId),
								),
						),
						Ref.update(
							devices,
							(map) =>
								new Map(
									[...map].filter(([, value]) => value.accountId !== accountId),
								),
						),
						Ref.update(activities, (list) =>
							list.filter((value) => value.accountId !== accountId),
						),
					],
					{ discard: true },
				),
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
	readonly private_http_base_url: string | null;
	readonly private_ws_base_url: string | null;
	readonly tunnel_hostname: string | null;
	readonly tunnel_id: string | null;
	readonly dns_record_id: string | null;
	readonly tunnel_status: "reserved" | "ready" | null;
	readonly linked_at: number;
	readonly last_seen_at: number | null;
	readonly runtime_version: string | null;
	readonly wire_protocol_version: number | null;
	readonly capabilities: unknown;
	readonly service_state: ServiceState | null;
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
	privateHttpBaseUrl: row.private_http_base_url ?? undefined,
	privateWsBaseUrl: row.private_ws_base_url ?? undefined,
	tunnelHostname: row.tunnel_hostname ?? undefined,
	tunnelId: row.tunnel_id ?? undefined,
	dnsRecordId: row.dns_record_id ?? undefined,
	tunnelStatus: row.tunnel_status ?? undefined,
	linkedAtMs: Number(row.linked_at),
	lastSeenAtMs:
		row.last_seen_at === null ? undefined : Number(row.last_seen_at),
	runtimeVersion: row.runtime_version ?? undefined,
	wireProtocolVersion:
		row.wire_protocol_version === null
			? undefined
			: Number(row.wire_protocol_version),
	capabilities: row.capabilities ?? undefined,
	serviceState: row.service_state ?? undefined,
});

export const ApiStorePg: Layer.Layer<ApiStore, never, SqlClient.SqlClient> =
	Layer.effect(
		ApiStore,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const orDie = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A> =>
				effect.pipe(Effect.orDie);

			return ApiStore.of({
				createChallenge: (challenge) =>
					orDie(
						sql`
            INSERT INTO api_link_challenges
              (challenge_id, account_id, challenge, api_issuer, expires_at)
            VALUES (
              ${challenge.challengeId}, ${challenge.accountId}, ${challenge.challenge},
              ${challenge.apiIssuer}, ${challenge.expiresAtMs}
            )
          `.pipe(Effect.asVoid),
					),
				consumeChallenge: (challengeId, accountId) =>
					orDie(
						sql<{
							readonly challenge_id: string;
							readonly account_id: string;
							readonly challenge: string;
							readonly api_issuer: string;
							readonly expires_at: number;
						}>`
              DELETE FROM api_link_challenges
              WHERE challenge_id = ${challengeId} AND account_id = ${accountId}
              RETURNING challenge_id, account_id, challenge, api_issuer, expires_at
            `.pipe(
							Effect.map((rows) => {
								const row = rows[0];
								if (row === undefined) return null;
								return {
									challengeId: row.challenge_id,
									accountId: row.account_id,
									challenge: row.challenge,
									apiIssuer: row.api_issuer,
									expiresAtMs: Number(row.expires_at),
								} satisfies LinkChallengeRecord;
							}),
						),
					),
				registerEnvironment: (env, maxEnvironmentsPerAccount, mode) =>
					orDie(
						sql<{ readonly registered: boolean }>`
            WITH account_lock AS (
              SELECT pg_advisory_xact_lock(
                hashtextextended(${env.accountId}, 0)
              )
            ), allowed AS (
              SELECT 1
              FROM account_lock
              WHERE (
                EXISTS (
                  SELECT 1 FROM api_environments
                  WHERE environment_id = ${env.environmentId}
                    AND account_id = ${env.accountId}
									AND (
										${mode}::text = 'replace-same-account'
										OR (
											provider_kind = ${env.providerKind}
											AND environment_public_key = ${env.environmentPublicKey}
										)
									)
                )
                OR (
                  NOT EXISTS (
                    SELECT 1 FROM api_environments
                    WHERE environment_id = ${env.environmentId}
                  )
                  AND (
                    ${maxEnvironmentsPerAccount}::bigint IS NULL
                    OR (
                      SELECT COUNT(*) FROM api_environments
                      WHERE account_id = ${env.accountId}
                    ) < ${maxEnvironmentsPerAccount}::bigint
                  )
                )
              )
            ), registered AS (
              INSERT INTO api_environments
                (environment_id, account_id, org_id, provider_kind, label,
                 environment_public_key, http_base_url, ws_base_url,
                 tunnel_hostname, linked_at, last_seen_at, runtime_version,
                 wire_protocol_version, capabilities, service_state)
              SELECT
                ${env.environmentId}, ${env.accountId}, ${env.orgId ?? null},
                ${env.providerKind}, ${env.label ?? null},
                ${env.environmentPublicKey}, ${env.httpBaseUrl},
                ${env.wsBaseUrl}, ${env.tunnelHostname ?? null},
                ${env.linkedAtMs}, ${env.lastSeenAtMs ?? null},
                ${env.runtimeVersion ?? null}, ${env.wireProtocolVersion ?? null},
                ${env.capabilities === undefined ? null : JSON.stringify(env.capabilities)},
                ${env.serviceState ?? null}
              FROM allowed
              ON CONFLICT (environment_id) DO UPDATE SET
                org_id = EXCLUDED.org_id,
                provider_kind = EXCLUDED.provider_kind,
                label = EXCLUDED.label,
                environment_public_key = EXCLUDED.environment_public_key,
                http_base_url = EXCLUDED.http_base_url,
                ws_base_url = EXCLUDED.ws_base_url,
                linked_at = EXCLUDED.linked_at,
                runtime_version = EXCLUDED.runtime_version,
                wire_protocol_version = EXCLUDED.wire_protocol_version,
                capabilities = EXCLUDED.capabilities,
                service_state = EXCLUDED.service_state
							WHERE api_environments.account_id = EXCLUDED.account_id
								AND (
									${mode}::text = 'replace-same-account'
									OR (
										api_environments.provider_kind = EXCLUDED.provider_kind
										AND api_environments.environment_public_key = EXCLUDED.environment_public_key
									)
								)
              RETURNING environment_id
            )
            SELECT EXISTS(SELECT 1 FROM registered) AS registered
          `.pipe(Effect.map((rows) => rows[0]?.registered === true)),
					),
				listEnvironments: (accountId) =>
					orDie(
						sql<EnvironmentRow>`
              SELECT * FROM api_environments
              WHERE account_id = ${accountId}
              ORDER BY linked_at DESC
            `.pipe(Effect.map((rows) => rows.map(toEnvironment))),
					),
				getEnvironment: (environmentId) =>
					orDie(
						sql<EnvironmentRow>`
              SELECT * FROM api_environments WHERE environment_id = ${environmentId}
            `.pipe(
							Effect.map((rows) => (rows[0] ? toEnvironment(rows[0]) : null)),
						),
					),
				touchEnvironment: (environmentId, lastSeenAtMs, metadata) =>
					orDie(
						sql`
            UPDATE api_environments SET
              last_seen_at = ${lastSeenAtMs},
              runtime_version = COALESCE(${metadata?.runtimeVersion ?? null}, runtime_version),
              wire_protocol_version = COALESCE(${metadata?.wireProtocolVersion ?? null}, wire_protocol_version),
              capabilities = COALESCE(${
								metadata?.capabilities === undefined
									? null
									: JSON.stringify(metadata.capabilities)
							}, capabilities),
              service_state = COALESCE(${metadata?.serviceState ?? null}, service_state)
            WHERE environment_id = ${environmentId}
          `.pipe(Effect.asVoid),
					),
				setTunnelAllocation: (environmentId, allocation) =>
					orDie(
						sql`
            UPDATE api_environments SET
              tunnel_hostname = ${allocation.tunnelHostname},
              tunnel_id = ${allocation.tunnelId},
              dns_record_id = ${allocation.dnsRecordId ?? null},
              tunnel_status = ${allocation.tunnelStatus}
            WHERE environment_id = ${environmentId}
          `.pipe(Effect.asVoid),
					),
				clearTunnelAllocation: (environmentId) =>
					orDie(
						sql`
            UPDATE api_environments SET
              tunnel_hostname = NULL,
              tunnel_id = NULL,
              dns_record_id = NULL,
              tunnel_status = NULL
            WHERE environment_id = ${environmentId}
          `.pipe(Effect.asVoid),
					),
				setPrivateEndpoint: (environmentId, endpoint) =>
					orDie(
						sql`
							UPDATE api_environments SET
								private_http_base_url = ${endpoint?.httpBaseUrl ?? null},
								private_ws_base_url = ${endpoint?.wsBaseUrl ?? null}
							WHERE environment_id = ${environmentId}
						`.pipe(Effect.asVoid),
					),
				deleteEnvironment: (environmentId, accountId) =>
					orDie(
						sql`
            DELETE FROM api_environments
            WHERE environment_id = ${environmentId} AND account_id = ${accountId}
          `.pipe(Effect.asVoid),
					),
				insertCredential: (cred) =>
					orDie(
						sql`
            INSERT INTO api_environment_credentials
              (credential_id, environment_id, account_id, credential_hash, created_at)
            VALUES (
              ${cred.credentialId}, ${cred.environmentId}, ${cred.accountId},
              ${cred.credentialHash}, ${cred.createdAtMs}
            )
          `.pipe(Effect.asVoid),
					),
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
              SELECT * FROM api_environment_credentials
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
										row.revoked_at === null
											? undefined
											: Number(row.revoked_at),
								} satisfies CredentialRecord;
							}),
						),
					),
				revokeEnvironmentCredentials: (environmentId, revokedAtMs) =>
					orDie(
						sql`
							UPDATE api_environment_credentials
							SET revoked_at = ${revokedAtMs}
							WHERE environment_id = ${environmentId} AND revoked_at IS NULL
						`.pipe(Effect.asVoid),
					),
				upsertDevice: (device) =>
					orDie(
						sql<{ readonly device_id: string }>`
            INSERT INTO api_devices
              (device_id, account_id, platform, push_token, dpop_jwk,
               dpop_thumbprint, updated_at)
            VALUES (
              ${device.deviceId}, ${device.accountId}, ${device.platform},
              ${device.pushToken ?? null},
              ${device.dpopJwk === undefined ? null : JSON.stringify(device.dpopJwk)},
              ${device.dpopThumbprint},
              ${device.updatedAtMs}
            )
            ON CONFLICT (device_id) DO UPDATE SET
              platform = EXCLUDED.platform,
              push_token = EXCLUDED.push_token,
              dpop_jwk = EXCLUDED.dpop_jwk,
              dpop_thumbprint = EXCLUDED.dpop_thumbprint,
              updated_at = EXCLUDED.updated_at
            WHERE api_devices.account_id = EXCLUDED.account_id
            RETURNING device_id
          `.pipe(Effect.map((rows) => rows.length > 0)),
					),
				listDevices: (accountId) =>
					orDie(
						sql<{
							readonly device_id: string;
							readonly account_id: string;
							readonly platform: DevicePlatform;
							readonly push_token: string | null;
							readonly dpop_jwk: unknown;
							readonly dpop_thumbprint: string;
							readonly updated_at: number;
						}>`
              SELECT * FROM api_devices WHERE account_id = ${accountId}
            `.pipe(
							Effect.map((rows) =>
								rows.map((row) => ({
									deviceId: row.device_id,
									accountId: row.account_id,
									platform: row.platform,
									pushToken: row.push_token ?? undefined,
									dpopJwk: row.dpop_jwk ?? undefined,
									dpopThumbprint: row.dpop_thumbprint,
									updatedAtMs: Number(row.updated_at),
								})),
							),
						),
					),
				revokeDevice: (deviceId, accountId) =>
					orDie(
						sql<{ readonly dpop_thumbprint: string }>`
              WITH revoked AS (
                DELETE FROM api_devices
                WHERE device_id = ${deviceId} AND account_id = ${accountId}
                RETURNING dpop_thumbprint
              ), blocked AS (
                INSERT INTO api_revoked_dpop_keys (thumbprint, revoked_at)
                SELECT dpop_thumbprint, ${Date.now()} FROM revoked
                ON CONFLICT (thumbprint) DO NOTHING
                RETURNING thumbprint
              )
              SELECT dpop_thumbprint FROM revoked
            `.pipe(Effect.map((rows) => rows.length > 0)),
					),
				isDpopThumbprintRevoked: (thumbprint) =>
					orDie(
						sql<{ readonly revoked: boolean }>`
              SELECT EXISTS(
                SELECT 1 FROM api_revoked_dpop_keys
                WHERE thumbprint = ${thumbprint}
              ) AS revoked
            `.pipe(Effect.map((rows) => rows[0]?.revoked === true)),
					),
				consumeDpopProof: (input) =>
					orDie(
						sql<{ readonly jti: string }>`
              INSERT INTO api_dpop_proofs (thumbprint, jti, issued_at, expires_at)
              VALUES (${input.thumbprint}, ${input.jti}, ${input.issuedAtMs}, ${input.expiresAtMs})
              ON CONFLICT (thumbprint, jti) DO NOTHING
              RETURNING jti
            `.pipe(Effect.map((rows) => rows.length > 0)),
					),
				recordActivity: (activity) =>
					orDie(
						sql`
            INSERT INTO api_agent_activity
              (environment_id, account_id, session_id, kind, title, occurred_at)
            VALUES (
              ${activity.environmentId}, ${activity.accountId}, ${activity.sessionId},
              ${activity.kind}, ${activity.title ?? null}, ${activity.occurredAtMs}
            )
          `.pipe(Effect.asVoid),
					),
				deleteAccountData: (accountId) =>
					orDie(
						sql`
              WITH deleted_activity AS (
                DELETE FROM api_agent_activity WHERE account_id = ${accountId}
              ), deleted_devices AS (
                DELETE FROM api_devices WHERE account_id = ${accountId}
              ), deleted_challenges AS (
                DELETE FROM api_link_challenges WHERE account_id = ${accountId}
              )
              DELETE FROM api_environments WHERE account_id = ${accountId}
            `.pipe(Effect.asVoid),
					),
			});
		}),
	);
