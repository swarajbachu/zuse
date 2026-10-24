import type {
	EnvironmentSharingAudience,
	MasterOwnership,
	PublicUsageProfile,
	UsageHistoryPage,
	UsageHistoryRow,
} from "@zuse/contracts";
import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Context, Effect, Layer, Ref, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
	type DomainJoiningStore,
	makeDomainJoiningMemory,
	makeDomainJoiningSql,
} from "./domain-joining-store.ts";
import { type ApiError, serviceUnavailable } from "./errors.ts";
import {
	type GithubJoiningStore,
	makeGithubJoiningMemory,
	makeGithubJoiningSql,
} from "./github-joining-store.ts";

const organizationDeadline = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
	operation.pipe(
		Effect.timeout("60 seconds"),
		Effect.catchTag("TimeoutError", () =>
			Effect.fail(serviceUnavailable("organization_operation_timeout")),
		),
	);

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
	readonly sharingAudience?: EnvironmentSharingAudience;
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

export interface UsageProfileRecord {
	readonly accountId: string;
	readonly published: boolean;
	readonly profile: PublicUsageProfile;
}

/** Identity of one usage history aggregate within an account. */
export const usageHistoryRowKey = (row: UsageHistoryRow): string =>
	JSON.stringify([row.hour, row.sourceId, row.model, row.session, row.project]);

/**
 * Monotonic merge so replays, partial re-uploads, and uploads from devices
 * with less local history never decrease a stored aggregate.
 */
const mergeUsageHistoryRow = (
	current: UsageHistoryRow,
	incoming: UsageHistoryRow,
): UsageHistoryRow => ({
	...current,
	inputTokens: Math.max(current.inputTokens, incoming.inputTokens),
	outputTokens: Math.max(current.outputTokens, incoming.outputTokens),
	cacheReadTokens: Math.max(current.cacheReadTokens, incoming.cacheReadTokens),
	cacheCreationTokens: Math.max(
		current.cacheCreationTokens,
		incoming.cacheCreationTokens,
	),
	reasoningTokens: Math.max(current.reasoningTokens, incoming.reasoningTokens),
	costUsd:
		current.costUsd === null
			? incoming.costUsd
			: incoming.costUsd === null
				? current.costUsd
				: Math.max(current.costUsd, incoming.costUsd),
	recordCount: Math.max(current.recordCount, incoming.recordCount),
	firstAt: Math.min(current.firstAt, incoming.firstAt),
	lastAt: Math.max(current.lastAt, incoming.lastAt),
});

export type UsageHistoryUpsertResult = "stored" | "full" | "backup_disabled";

interface UsageHistoryKeyRecord {
	readonly key: string;
	readonly backupEnabled: boolean;
}

interface UsageHistoryEntry {
	readonly id: number;
	readonly row: UsageHistoryRow;
}

/** Build a page from up to `limit + 1` id-ordered entries. */
const toUsageHistoryPage = (
	entries: ReadonlyArray<UsageHistoryEntry>,
	limit: number,
): UsageHistoryPage => {
	const page = entries.slice(0, limit);
	return {
		rows: page.map((entry) => entry.row),
		nextCursor:
			entries.length > limit ? String(page[page.length - 1]?.id) : null,
	};
};

export interface ApiStoreApi {
	readonly getUsageProfile: (
		accountId: string,
	) => Effect.Effect<UsageProfileRecord | null>;
	readonly findPublicUsageProfile: (
		handle: string,
	) => Effect.Effect<PublicUsageProfile | null>;
	/**
	 * Publish `record`. With `expectedUpdatedAt`, only replace a profile that is
	 * still published at that revision, so background refreshes never undo a
	 * newer unpublish or privacy choice.
	 */
	readonly saveUsageProfile: (
		record: UsageProfileRecord,
		options?: { readonly expectedUpdatedAt?: number },
	) => Effect.Effect<"saved" | "handle_unavailable" | "changed">;
	readonly unpublishUsageProfile: (accountId: string) => Effect.Effect<void>;
	/** Return the account's usage history key, storing `candidate` if none exists. */
	readonly getOrCreateUsageHistoryKey: (
		accountId: string,
		candidate: string,
	) => Effect.Effect<string>;
	/** Whether the account opted in to usage history backup; false without a key row. */
	readonly getUsageHistoryBackupEnabled: (
		accountId: string,
	) => Effect.Effect<boolean>;
	/**
	 * Set the account backup switch and return the stored state. Enabling
	 * atomically creates the key row with `candidate` when none exists;
	 * disabling keeps the key and rows.
	 */
	readonly setUsageHistoryBackupEnabled: (
		accountId: string,
		enabled: boolean,
		candidate: string,
	) => Effect.Effect<boolean>;
	/** The account key only while backup is enabled; never creates a key. */
	readonly getUsageHistoryRuntimeKey: (
		accountId: string,
	) => Effect.Effect<string | null>;
	/**
	 * Monotonically merge rows into the account's history. Writes nothing when
	 * the account would exceed `maxAccountRows` stored rows, or when
	 * `requireBackupEnabled` is set and the account's backup switch is off.
	 */
	readonly upsertUsageHistory: (
		accountId: string,
		rows: ReadonlyArray<UsageHistoryRow>,
		options: {
			readonly maxAccountRows: number;
			readonly requireBackupEnabled: boolean;
		},
	) => Effect.Effect<UsageHistoryUpsertResult>;
	/** Rows with a stable id greater than `afterId`, in id order. */
	readonly pageUsageHistory: (
		accountId: string,
		afterId: number,
		limit: number,
	) => Effect.Effect<UsageHistoryPage>;
	/** Delete every history row and the key; returns the deleted row count. */
	readonly deleteUsageHistory: (accountId: string) => Effect.Effect<number>;

	readonly githubJoining: GithubJoiningStore;
	readonly domainJoining: DomainJoiningStore;
	/** Serialize membership edits across API workers before checking current authority. */
	readonly withOrganizationLock: <A, E, R>(
		organizationId: string,
		operation: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | ApiError, R>;
	readonly getMasterOwnership: (
		accountId: string,
		masterId: string,
	) => Effect.Effect<MasterOwnership | null>;
	readonly compareMasterOwnership: (
		accountId: string,
		expectedGeneration: number,
		next: MasterOwnership,
	) => Effect.Effect<boolean>;
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
			readonly sharingAudience?: EnvironmentSharingAudience;
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

export const ApiStoreMemory: Layer.Layer<ApiStore> = Layer.effect(
	ApiStore,
	Effect.gen(function* () {
		const usageProfiles = yield* Ref.make(
			new Map<string, UsageProfileRecord>(),
		);
		/** Keys and rows share one Ref so switch checks and writes are atomic. */
		const usageHistory = yield* Ref.make({
			nextId: 1,
			keys: new Map<string, UsageHistoryKeyRecord>(),
			accounts: new Map<string, ReadonlyMap<string, UsageHistoryEntry>>(),
		});
		const deleteMemoryUsageHistory = (accountId: string) =>
			Ref.modify(usageHistory, (state) => {
				const deleted = state.accounts.get(accountId)?.size ?? 0;
				const keys = new Map(state.keys);
				keys.delete(accountId);
				const accounts = new Map(state.accounts);
				accounts.delete(accountId);
				return [deleted, { ...state, keys, accounts }];
			});
		const challenges = yield* Ref.make(new Map<string, LinkChallengeRecord>());
		const environments = yield* Ref.make(new Map<string, EnvironmentRecord>());
		const credentials = yield* Ref.make(new Map<string, CredentialRecord>());
		const deviceLock = yield* Semaphore.make(1);
		const devices = yield* Ref.make(new Map<string, DeviceRecord>());
		const revokedDpopThumbprints = yield* Ref.make(new Set<string>());
		const dpop = yield* Ref.make(new Set<string>());
		const activities = yield* Ref.make<ActivityRecord[]>([]);
		const organizationLock = new KeyedEffectSerialWorker<string>();

		const githubJoining = makeGithubJoiningMemory();
		const domainJoining = makeDomainJoiningMemory();
		const masterOwnership = yield* Ref.make(new Map<string, MasterOwnership>());

		return ApiStore.of({
			getUsageProfile: (accountId) =>
				Ref.get(usageProfiles).pipe(
					Effect.map((profiles) => profiles.get(accountId) ?? null),
				),
			findPublicUsageProfile: (handle) =>
				Ref.get(usageProfiles).pipe(
					Effect.map(
						(profiles) =>
							[...profiles.values()].find(
								(record) =>
									record.published && record.profile.handle === handle,
							)?.profile ?? null,
					),
				),
			saveUsageProfile: (record, options) =>
				Ref.modify(usageProfiles, (profiles) => {
					const existing = profiles.get(record.accountId);
					if (
						options?.expectedUpdatedAt !== undefined &&
						(!existing?.published ||
							existing.profile.updatedAt !== options.expectedUpdatedAt)
					)
						return ["changed" as const, profiles];
					if (
						(existing && existing.profile.handle !== record.profile.handle) ||
						[...profiles.values()].some(
							(other) =>
								other.accountId !== record.accountId &&
								other.profile.handle === record.profile.handle,
						)
					)
						return ["handle_unavailable" as const, profiles];
					const next = new Map(profiles);
					next.set(record.accountId, {
						...record,
						profile: {
							...record.profile,
							publishedAt:
								existing?.profile.publishedAt ?? record.profile.publishedAt,
						},
					});
					return ["saved" as const, next];
				}),
			unpublishUsageProfile: (accountId) =>
				Ref.update(usageProfiles, (profiles) => {
					const next = new Map(profiles);
					const record = next.get(accountId);
					if (record) next.set(accountId, { ...record, published: false });
					return next;
				}),
			getOrCreateUsageHistoryKey: (accountId, candidate) =>
				Ref.modify(usageHistory, (state) => {
					const existing = state.keys.get(accountId);
					return existing === undefined
						? [
								candidate,
								{
									...state,
									keys: new Map(state.keys).set(accountId, {
										key: candidate,
										backupEnabled: false,
									}),
								},
							]
						: [existing.key, state];
				}),
			getUsageHistoryBackupEnabled: (accountId) =>
				Ref.get(usageHistory).pipe(
					Effect.map(
						(state) => state.keys.get(accountId)?.backupEnabled ?? false,
					),
				),
			setUsageHistoryBackupEnabled: (accountId, enabled, candidate) =>
				Ref.modify(usageHistory, (state) => {
					const existing = state.keys.get(accountId);
					if (existing === undefined && !enabled) return [false, state];
					return [
						enabled,
						{
							...state,
							keys: new Map(state.keys).set(accountId, {
								key: existing?.key ?? candidate,
								backupEnabled: enabled,
							}),
						},
					];
				}),
			getUsageHistoryRuntimeKey: (accountId) =>
				Ref.get(usageHistory).pipe(
					Effect.map((state) => {
						const record = state.keys.get(accountId);
						return record?.backupEnabled ? record.key : null;
					}),
				),
			upsertUsageHistory: (
				accountId,
				rows,
				{ maxAccountRows, requireBackupEnabled },
			) =>
				Ref.modify(usageHistory, (state) => {
					if (requireBackupEnabled && !state.keys.get(accountId)?.backupEnabled)
						return ["backup_disabled" as const, state];
					const current =
						state.accounts.get(accountId) ??
						new Map<string, UsageHistoryEntry>();
					const added = rows.filter(
						(row) => !current.has(usageHistoryRowKey(row)),
					).length;
					if (current.size + added > maxAccountRows)
						return ["full" as const, state];
					const next = new Map(current);
					let nextId = state.nextId;
					for (const row of rows) {
						const key = usageHistoryRowKey(row);
						const existing = next.get(key);
						next.set(
							key,
							existing
								? {
										id: existing.id,
										row: mergeUsageHistoryRow(existing.row, row),
									}
								: { id: nextId++, row },
						);
					}
					return [
						"stored" as const,
						{
							...state,
							nextId,
							accounts: new Map(state.accounts).set(accountId, next),
						},
					];
				}),
			pageUsageHistory: (accountId, afterId, limit) =>
				Ref.get(usageHistory).pipe(
					Effect.map((state) =>
						toUsageHistoryPage(
							[...(state.accounts.get(accountId)?.values() ?? [])]
								.filter((entry) => entry.id > afterId)
								.sort((left, right) => left.id - right.id)
								.slice(0, limit + 1),
							limit,
						),
					),
				),
			deleteUsageHistory: deleteMemoryUsageHistory,
			githubJoining,
			domainJoining,
			withOrganizationLock: (organizationId, operation) =>
				organizationDeadline(organizationLock.run(organizationId, operation)),
			getMasterOwnership: (accountId, masterId) =>
				Ref.get(masterOwnership).pipe(
					Effect.map((map) => map.get(`${accountId}:${masterId}`) ?? null),
				),
			compareMasterOwnership: (accountId, expectedGeneration, next) =>
				Ref.modify(masterOwnership, (map) => {
					const key = `${accountId}:${next.masterId}`;
					if ((map.get(key)?.generation ?? 0) !== expectedGeneration)
						return [false, map];
					const requested = new Set(
						next.repositories.map(
							(repo) => `${repo.environmentId}:${repo.folderId}`,
						),
					);
					if (requested.size !== next.repositories.length) return [false, map];
					for (const [ownerKey, owner] of map)
						if (
							ownerKey.startsWith(`${accountId}:`) &&
							ownerKey !== key &&
							owner.repositories.some((repo) =>
								requested.has(`${repo.environmentId}:${repo.folderId}`),
							)
						)
							return [false, map];
					return [true, new Map(map).set(key, next)];
				}),

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
						(candidate) =>
							candidate.accountId === environment.accountId &&
							candidate.providerKind !== "cloud",
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
						sharingAudience: metadata?.sharingAudience ?? [],
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
				Semaphore.withPermit(
					deviceLock,
					Effect.gen(function* () {
						if (
							(yield* Ref.get(revokedDpopThumbprints)).has(
								device.dpopThumbprint,
							)
						)
							return false;
						return yield* Ref.modify(devices, (map) => {
							const current = map.get(device.deviceId);
							if (
								current !== undefined &&
								current.accountId !== device.accountId
							)
								return [false, map];
							return [true, new Map(map).set(device.deviceId, device)];
						});
					}),
				),
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
					(effect) => Semaphore.withPermit(deviceLock, effect),
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
						Ref.update(usageProfiles, (profiles) => {
							const next = new Map(profiles);
							next.delete(accountId);
							return next;
						}),
						deleteMemoryUsageHistory(accountId),
						githubJoining.deleteAccount(accountId),
						domainJoining.deleteAccount(accountId),
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

interface EnvironmentRow {
	readonly sharing_audience: EnvironmentSharingAudience | null;
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
	sharingAudience: row.sharing_audience ?? undefined,
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

interface UsageHistoryDbRow {
	readonly id: string;
	readonly hour: string;
	readonly source_id: string;
	readonly model: string;
	readonly session: string;
	readonly project: string;
	readonly input_tokens: string;
	readonly output_tokens: string;
	readonly cache_read_tokens: string;
	readonly cache_creation_tokens: string;
	readonly reasoning_tokens: string;
	readonly cost_usd: number | null;
	readonly record_count: string;
	readonly first_at: string;
	readonly last_at: string;
}

const toUsageHistoryEntry = (row: UsageHistoryDbRow): UsageHistoryEntry => ({
	id: Number(row.id),
	row: {
		hour: row.hour,
		sourceId: row.source_id as UsageHistoryRow["sourceId"],
		model: row.model,
		session: row.session,
		project: row.project,
		inputTokens: Number(row.input_tokens),
		outputTokens: Number(row.output_tokens),
		cacheReadTokens: Number(row.cache_read_tokens),
		cacheCreationTokens: Number(row.cache_creation_tokens),
		reasoningTokens: Number(row.reasoning_tokens),
		costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
		recordCount: Number(row.record_count),
		firstAt: Number(row.first_at),
		lastAt: Number(row.last_at),
	},
});

/** Column definitions for decoding a JSON array of `UsageHistoryRow`s. */
const USAGE_HISTORY_RECORDSET_COLUMNS =
	'hour text, "sourceId" text, model text, session text, project text, "inputTokens" bigint, "outputTokens" bigint, "cacheReadTokens" bigint, "cacheCreationTokens" bigint, "reasoningTokens" bigint, "costUsd" double precision, "recordCount" bigint, "firstAt" bigint, "lastAt" bigint';

export const ApiStorePg: Layer.Layer<ApiStore, never, SqlClient.SqlClient> =
	Layer.effect(
		ApiStore,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const orDie = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A> =>
				effect.pipe(Effect.orDie);

			const withDeviceLock = <A>(
				accountId: string,
				operation: Effect.Effect<A, unknown>,
			) =>
				orDie(
					sql.withTransaction(
						Effect.gen(function* () {
							yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile-devices:${accountId}`}, 0))`;
							return yield* operation;
						}),
					),
				);

			/** Serialize history writes per account so the row cap and deletes are exact. */
			const lockUsageHistory = (accountId: string) =>
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${`usage-history:${accountId}`}, 0))`;
			const usageHistoryRecordset = (rows: ReadonlyArray<UsageHistoryRow>) =>
				sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(${sql.literal(USAGE_HISTORY_RECORDSET_COLUMNS)})`;

			const githubJoining = makeGithubJoiningSql(sql);
			const domainJoining = makeDomainJoiningSql(sql);
			return ApiStore.of({
				getUsageProfile: (accountId) =>
					orDie(
						sql<{
							account_id: string;
							published: boolean;
							payload: PublicUsageProfile;
						}>`SELECT account_id, published, payload FROM api_usage_profiles WHERE account_id=${accountId}`.pipe(
							Effect.map((rows) =>
								rows[0]
									? {
											accountId: rows[0].account_id,
											published: rows[0].published,
											profile: rows[0].payload,
										}
									: null,
							),
						),
					),
				findPublicUsageProfile: (handle) =>
					orDie(
						sql<{
							payload: PublicUsageProfile;
						}>`SELECT payload FROM api_usage_profiles WHERE handle=${handle} AND published=true`.pipe(
							Effect.map((rows) => rows[0]?.payload ?? null),
						),
					),
				saveUsageProfile: (record, options) =>
					orDie(
						sql.withTransaction(
							Effect.gen(function* () {
								yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${record.accountId}, 812))`;
								const current = yield* sql<{
									handle: string;
									published: boolean;
									updated_at: string | null;
								}>`SELECT handle, published, payload->>'updatedAt' AS updated_at FROM api_usage_profiles WHERE account_id=${record.accountId}`;
								if (
									options?.expectedUpdatedAt !== undefined &&
									(!current[0]?.published ||
										Number(current[0].updated_at) !== options.expectedUpdatedAt)
								)
									return "changed" as const;
								if (current[0] && current[0].handle !== record.profile.handle)
									return "handle_unavailable" as const;
								const rows =
									yield* sql`INSERT INTO api_usage_profiles(account_id,handle,published,payload) VALUES(${record.accountId},${record.profile.handle},${record.published},${JSON.stringify(record.profile)}::jsonb) ON CONFLICT(handle) DO UPDATE SET published=excluded.published,payload=jsonb_set(excluded.payload,'{publishedAt}',api_usage_profiles.payload->'publishedAt') WHERE api_usage_profiles.account_id=excluded.account_id RETURNING account_id`;
								return rows.length === 1
									? ("saved" as const)
									: ("handle_unavailable" as const);
							}),
						),
					),
				unpublishUsageProfile: (accountId) =>
					orDie(
						sql`UPDATE api_usage_profiles SET published=false WHERE account_id=${accountId}`.pipe(
							Effect.asVoid,
						),
					),
				getOrCreateUsageHistoryKey: (accountId, candidate) =>
					orDie(
						sql<{
							key: string;
						}>`INSERT INTO api_usage_history_keys(account_id,key) VALUES(${accountId},${candidate}) ON CONFLICT(account_id) DO UPDATE SET key=api_usage_history_keys.key RETURNING key`.pipe(
							Effect.flatMap(([row]) =>
								row
									? Effect.succeed(row.key)
									: Effect.die(
											new Error("usage history key upsert returned no row"),
										),
							),
						),
					),
				getUsageHistoryBackupEnabled: (accountId) =>
					orDie(
						sql<{
							backup_enabled: boolean;
						}>`SELECT backup_enabled FROM api_usage_history_keys WHERE account_id=${accountId}`.pipe(
							Effect.map(([row]) => row?.backup_enabled ?? false),
						),
					),
				setUsageHistoryBackupEnabled: (accountId, enabled, candidate) =>
					orDie(
						(enabled
							? sql`INSERT INTO api_usage_history_keys(account_id,key,backup_enabled) VALUES(${accountId},${candidate},true) ON CONFLICT(account_id) DO UPDATE SET backup_enabled=true`
							: sql`UPDATE api_usage_history_keys SET backup_enabled=false WHERE account_id=${accountId}`
						).pipe(Effect.as(enabled)),
					),
				getUsageHistoryRuntimeKey: (accountId) =>
					orDie(
						sql<{
							key: string;
						}>`SELECT key FROM api_usage_history_keys WHERE account_id=${accountId} AND backup_enabled`.pipe(
							Effect.map(([row]) => row?.key ?? null),
						),
					),
				upsertUsageHistory: (
					accountId,
					rows,
					{ maxAccountRows, requireBackupEnabled },
				) =>
					orDie(
						sql.withTransaction(
							Effect.gen(function* () {
								yield* lockUsageHistory(accountId);
								if (requireBackupEnabled) {
									// FOR SHARE holds off a concurrent disable until commit.
									const [switchRow] = yield* sql<{
										backup_enabled: boolean;
									}>`SELECT backup_enabled FROM api_usage_history_keys WHERE account_id=${accountId} FOR SHARE`;
									if (!switchRow?.backup_enabled)
										return "backup_disabled" as const;
								}
								if (rows.length === 0) return "stored" as const;
								const [stored] = yield* sql<{
									count: number;
								}>`SELECT count(*)::int AS count FROM api_usage_history WHERE account_id=${accountId}`;
								const storedCount = stored?.count ?? 0;
								if (storedCount + rows.length > maxAccountRows) {
									const [existing] = yield* sql<{
										count: number;
									}>`SELECT count(*)::int AS count FROM ${usageHistoryRecordset(rows)} JOIN api_usage_history h ON h.account_id=${accountId} AND h.hour=r.hour AND h.source_id=r."sourceId" AND h.model=r.model AND h.session=r.session AND h.project=r.project`;
									if (
										storedCount + rows.length - (existing?.count ?? 0) >
										maxAccountRows
									)
										return "full" as const;
								}
								yield* sql`INSERT INTO api_usage_history(account_id,hour,source_id,model,session,project,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,reasoning_tokens,cost_usd,record_count,first_at,last_at)
                  SELECT ${accountId},r.hour,r."sourceId",r.model,r.session,r.project,r."inputTokens",r."outputTokens",r."cacheReadTokens",r."cacheCreationTokens",r."reasoningTokens",r."costUsd",r."recordCount",r."firstAt",r."lastAt" FROM ${usageHistoryRecordset(rows)}
                  ON CONFLICT(account_id,hour,source_id,model,session,project) DO UPDATE SET
                    input_tokens=GREATEST(api_usage_history.input_tokens,excluded.input_tokens),
                    output_tokens=GREATEST(api_usage_history.output_tokens,excluded.output_tokens),
                    cache_read_tokens=GREATEST(api_usage_history.cache_read_tokens,excluded.cache_read_tokens),
                    cache_creation_tokens=GREATEST(api_usage_history.cache_creation_tokens,excluded.cache_creation_tokens),
                    reasoning_tokens=GREATEST(api_usage_history.reasoning_tokens,excluded.reasoning_tokens),
                    cost_usd=GREATEST(api_usage_history.cost_usd,excluded.cost_usd),
                    record_count=GREATEST(api_usage_history.record_count,excluded.record_count),
                    first_at=LEAST(api_usage_history.first_at,excluded.first_at),
                    last_at=GREATEST(api_usage_history.last_at,excluded.last_at)
                  WHERE api_usage_history.input_tokens<excluded.input_tokens
                    OR api_usage_history.output_tokens<excluded.output_tokens
                    OR api_usage_history.cache_read_tokens<excluded.cache_read_tokens
                    OR api_usage_history.cache_creation_tokens<excluded.cache_creation_tokens
                    OR api_usage_history.reasoning_tokens<excluded.reasoning_tokens
                    OR excluded.cost_usd>COALESCE(api_usage_history.cost_usd,-1)
                    OR api_usage_history.record_count<excluded.record_count
                    OR api_usage_history.first_at>excluded.first_at
                    OR api_usage_history.last_at<excluded.last_at`;
								return "stored" as const;
							}),
						),
					),
				pageUsageHistory: (accountId, afterId, limit) =>
					orDie(
						sql<UsageHistoryDbRow>`SELECT id,hour,source_id,model,session,project,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,reasoning_tokens,cost_usd,record_count,first_at,last_at FROM api_usage_history WHERE account_id=${accountId} AND id>${afterId} ORDER BY id LIMIT ${limit + 1}`.pipe(
							Effect.map((rows) =>
								toUsageHistoryPage(rows.map(toUsageHistoryEntry), limit),
							),
						),
					),
				deleteUsageHistory: (accountId) =>
					orDie(
						sql.withTransaction(
							Effect.gen(function* () {
								yield* lockUsageHistory(accountId);
								yield* sql`DELETE FROM api_usage_history_keys WHERE account_id=${accountId}`;
								const [deleted] = yield* sql<{
									count: number;
								}>`WITH deleted AS (DELETE FROM api_usage_history WHERE account_id=${accountId} RETURNING 1) SELECT count(*)::int AS count FROM deleted`;
								return deleted?.count ?? 0;
							}),
						),
					),
				githubJoining,
				domainJoining,
				withOrganizationLock: (organizationId, operation) =>
					sql
						.withTransaction(
							sql`SELECT pg_advisory_xact_lock(hashtextextended(${`organization:${organizationId}`}, 0))`.pipe(
								Effect.orDie,
								Effect.andThen(operation),
							),
						)
						.pipe(
							Effect.catchTag("SqlError", Effect.die),
							organizationDeadline,
						),
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
                        AND provider_kind IN ('desktop', 'ssh')
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
				getMasterOwnership: (accountId, masterId) =>
					orDie(
						sql<{
							home_environment_id: string;
							generation: number;
							repositories_json: string;
						}>`SELECT home_environment_id, generation, repositories_json FROM api_master_ownership WHERE account_id = ${accountId} AND master_id = ${masterId}`.pipe(
							Effect.map((rows) =>
								rows[0]
									? {
											masterId,
											homeEnvironmentId: rows[0].home_environment_id,
											generation: rows[0].generation,
											repositories: JSON.parse(rows[0].repositories_json),
										}
									: null,
							),
						),
					),

				compareMasterOwnership: (accountId, expectedGeneration, next) =>
					orDie(
						sql.withTransaction(
							Effect.gen(function* () {
								// Serialize repository ownership changes for this account, including first claims.
								yield* sql`SELECT pg_advisory_xact_lock(hashtext(${accountId}))`;
								const owners = yield* sql<{
									master_id: string;
									repositories_json: string;
								}>`SELECT master_id, repositories_json FROM api_master_ownership WHERE account_id = ${accountId}`;
								const requested = new Set(
									next.repositories.map(
										(repo) => `${repo.environmentId}:${repo.folderId}`,
									),
								);
								if (requested.size !== next.repositories.length) return false;
								for (const owner of owners) {
									const repositories: MasterOwnership["repositories"] =
										JSON.parse(owner.repositories_json);
									if (
										owner.master_id !== next.masterId &&
										repositories.some((repo) =>
											requested.has(`${repo.environmentId}:${repo.folderId}`),
										)
									)
										return false;
								}
								const changed =
									expectedGeneration === 0
										? yield* sql`INSERT INTO api_master_ownership (account_id, master_id, home_environment_id, generation, repositories_json) VALUES (${accountId}, ${next.masterId}, ${next.homeEnvironmentId}, ${next.generation}, ${JSON.stringify(next.repositories)}) ON CONFLICT DO NOTHING RETURNING master_id`
										: yield* sql`UPDATE api_master_ownership SET home_environment_id = ${next.homeEnvironmentId}, generation = ${next.generation}, repositories_json = ${JSON.stringify(next.repositories)} WHERE account_id = ${accountId} AND master_id = ${next.masterId} AND generation = ${expectedGeneration} RETURNING master_id`;
								return changed.length === 1;
							}),
						),
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
              sharing_audience = ${JSON.stringify(metadata?.sharingAudience ?? [])},
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
					withDeviceLock(
						device.accountId,
						sql<{ readonly device_id: string }>`
            INSERT INTO api_devices
              (device_id, account_id, platform, push_token, dpop_jwk,
               dpop_thumbprint, updated_at)
            SELECT
              ${device.deviceId}, ${device.accountId}, ${device.platform},
              ${device.pushToken ?? null},
              ${device.dpopJwk === undefined ? null : JSON.stringify(device.dpopJwk)},
              ${device.dpopThumbprint},
              ${device.updatedAtMs}
            WHERE NOT EXISTS (
              SELECT 1 FROM api_revoked_dpop_keys WHERE thumbprint = ${device.dpopThumbprint}
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
					withDeviceLock(
						accountId,
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
              WITH deleted_usage_profile AS (DELETE FROM api_usage_profiles WHERE account_id = ${accountId}), deleted_usage_history AS (DELETE FROM api_usage_history WHERE account_id = ${accountId}), deleted_usage_history_key AS (DELETE FROM api_usage_history_keys WHERE account_id = ${accountId}), deleted_github_identity AS (DELETE FROM api_github_identities WHERE account_id = ${accountId}), deleted_github_enrollments AS (DELETE FROM api_github_enrollments WHERE account_id = ${accountId}), deleted_domain_enrollments AS (DELETE FROM api_organization_domain_enrollments WHERE account_id = ${accountId}), deleted_activity AS (
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
