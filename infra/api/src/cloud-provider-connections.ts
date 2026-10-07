import type {
	CloudProviderConnection,
	CloudProviderConnectionInput,
} from "@zuse/contracts";
import {
	type SandboxProviderAdapter,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { openApiString, sealApiString } from "./api-sealing.ts";
import {
	type CloudProjectBuildRecord,
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
} from "./cloud-workspace-store.ts";
import type { ApiConfiguration } from "./config.ts";
import { randomToken } from "./crypto.ts";
import { type ApiError, serviceUnavailable } from "./errors.ts";

export interface ProviderConnectionRecord extends CloudProviderConnection {
	readonly accountId: string;
	readonly envelope: string;
}
interface ConnectionStorage {
	readonly list: (
		accountId: string,
	) => Effect.Effect<ReadonlyArray<ProviderConnectionRecord>, ApiError>;
	readonly save: (
		record: ProviderConnectionRecord,
	) => Effect.Effect<void, ApiError>;
	readonly disconnect: (
		accountId: string,
		connectionId: string,
	) => Effect.Effect<void, ApiError>;
}
export class CloudProviderConnections extends Context.Service<
	CloudProviderConnections,
	ConnectionStorage
>()("api/CloudProviderConnections") {}
const context = (accountId: string, providerId: string, connectionId: string) =>
	JSON.stringify([
		"sandbox-provider-key-v1",
		accountId,
		providerId,
		connectionId,
	]);
const storageError = () =>
	serviceUnavailable("cloud_provider_connection_storage_unavailable");
const fromRow = (row: Record<string, unknown>): ProviderConnectionRecord => ({
	connectionId: String(row.connection_id),
	accountId: String(row.account_id),
	providerId: String(row.provider),
	envelope: String(row.envelope),
	active: row.active === true,
	createdAt: Number(row.created_at),
	...(row.template_id === null ? {} : { templateId: String(row.template_id) }),
	...(row.organization === null
		? {}
		: { organization: String(row.organization) }),
});
export const CloudProviderConnectionsLive = Layer.effect(
	CloudProviderConnections,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return CloudProviderConnections.of({
			list: (accountId) =>
				sql`SELECT * FROM api_cloud_provider_connections WHERE account_id=${accountId} ORDER BY created_at DESC`.pipe(
					Effect.map((rows) => rows.map(fromRow)),
					Effect.mapError(storageError),
				),
			save: (record) =>
				sql
					.withTransaction(
						Effect.gen(function* () {
							yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([record.accountId, record.providerId])}, 0))`;
							yield* sql`UPDATE api_cloud_provider_connections SET active=false WHERE account_id=${record.accountId} AND provider=${record.providerId} AND active=true`;
							yield* sql`INSERT INTO api_cloud_provider_connections (connection_id, account_id, provider, envelope, active, template_id, organization, created_at) VALUES (${record.connectionId}, ${record.accountId}, ${record.providerId}, ${record.envelope}, true, ${record.templateId ?? null}, ${record.organization ?? null}, ${record.createdAt})`;
						}),
					)
					.pipe(Effect.mapError(storageError)),
			disconnect: (accountId, connectionId) =>
				sql`UPDATE api_cloud_provider_connections SET active=false WHERE account_id=${accountId} AND connection_id=${connectionId}`.pipe(
					Effect.asVoid,
					Effect.mapError(storageError),
				),
		});
	}),
);

export const listProviderConnections = Effect.fn("listProviderConnections")(
	function* (accountId: string) {
		const storage = yield* Effect.serviceOption(CloudProviderConnections);
		return Option.isSome(storage) ? yield* storage.value.list(accountId) : [];
	},
);
export const publicProviderConnections = (
	records: ReadonlyArray<ProviderConnectionRecord>,
) => ({
	connections: records.map(
		({
			connectionId,
			providerId,
			active,
			templateId,
			organization,
			createdAt,
		}) => ({
			connectionId,
			providerId,
			active,
			templateId,
			organization,
			createdAt,
		}),
	),
});
export const hasProviderConnection = Effect.fn("hasProviderConnection")(
	function* (accountId: string) {
		return (yield* listProviderConnections(accountId)).some(
			(record) => record.active,
		);
	},
);
export type ConnectedSandboxProvider = SandboxProviderAdapter & {
	readonly connectionId?: string;
};
export const connectionIdFor = (
	resource: CloudProjectBuildRecord | CloudWorkspaceRecord,
): string | undefined => {
	const data =
		"requestConfig" in resource ? resource.requestConfig : resource.settings;
	return typeof data?.providerConnectionId === "string"
		? data.providerConnectionId
		: undefined;
};
export const resolveConnectedProvider = Effect.fn("resolveConnectedProvider")(
	function* (
		accountId: string,
		providerId: string,
		connectionId?: string,
	): Effect.fn.Return<
		ConnectedSandboxProvider,
		ApiError,
		SandboxProviders | ApiConfiguration
	> {
		const base = yield* (yield* SandboxProviders)
			.get(providerId)
			.pipe(
				Effect.mapError(() => serviceUnavailable("cloud_provider_unavailable")),
			);
		if (connectionId === undefined) return base;
		const record = (yield* listProviderConnections(accountId)).find(
			(record) =>
				record.connectionId === connectionId &&
				record.providerId === providerId,
		);
		if (record === undefined || base.withCredentials === undefined)
			return yield* serviceUnavailable("cloud_provider_connection_unavailable");
		const apiKey = yield* openApiString(
			context(accountId, providerId, connectionId),
			record.envelope,
		);
		return {
			...base.withCredentials({
				apiKey: Redacted.make(apiKey),
				templateId: record.templateId,
				organization: record.organization,
			}),
			connectionId,
			// Prevent snapshots being reused across provider accounts or credential versions.
			templateVersion: `${base.templateVersion}:connection:${connectionId}`,
		};
	},
);
export const resolveResourceProvider = (
	resource: CloudProjectBuildRecord | CloudWorkspaceRecord,
) =>
	resolveConnectedProvider(
		resource.accountId,
		resource.provider,
		connectionIdFor(resource),
	);
export const resourceProviderConnectionId = Effect.fn(
	"resourceProviderConnectionId",
)(function* (
	resourceKind: "workspace" | "build" | "review",
	resourceId: string,
) {
	// Hosted review has no customer-owned compute connection; its attempt pins Zuse placement.
	if (resourceKind === "review") return undefined;
	const store = yield* CloudWorkspaceStore;
	const resource =
		resourceKind === "workspace"
			? yield* store.getWorkspace(resourceId)
			: yield* store.getBuild(resourceId);
	return resource === null ? undefined : connectionIdFor(resource);
});
export const saveProviderConnection = Effect.fn("saveProviderConnection")(
	function* (
		accountId: string,
		input: CloudProviderConnectionInput,
		nowMs: number,
	) {
		const storage = yield* Effect.serviceOption(CloudProviderConnections);
		if (Option.isNone(storage)) return yield* storageError();
		const provider = yield* (yield* SandboxProviders)
			.get(input.providerId)
			.pipe(
				Effect.mapError(() => serviceUnavailable("cloud_provider_unavailable")),
			);
		if (!provider.withCredentials)
			return yield* serviceUnavailable("cloud_provider_keys_unavailable");
		const key = input.apiKey.trim();
		if (!key) return yield* serviceUnavailable("cloud_provider_key_invalid");
		// A read-only lookup authenticates the key without allocating paid compute.
		yield* provider
			.withCredentials({
				apiKey: Redacted.make(key),
				templateId: input.templateId,
				organization: input.organization,
			})
			.recoverByLabel(`zuse-key-check-${crypto.randomUUID()}`)
			.pipe(
				Effect.timeout("15 seconds"),
				Effect.mapError(() =>
					serviceUnavailable("cloud_provider_key_verification_failed"),
				),
			);
		const connectionId = yield* randomToken("provider", 16);
		const envelope = yield* sealApiString(
			context(accountId, input.providerId, connectionId),
			key,
		);
		yield* storage.value.save({
			connectionId,
			accountId,
			providerId: input.providerId,
			envelope,
			active: true,
			templateId: input.templateId,
			organization: input.organization,
			createdAt: nowMs,
		});
		return publicProviderConnections(yield* storage.value.list(accountId));
	},
);

/** Resolve active connections only for new placement; retained resources use their pinned ID. */
export const accountSandboxProviders = Effect.fn("accountSandboxProviders")(
	function* (accountId: string) {
		const providers = yield* SandboxProviders;
		const records = yield* listProviderConnections(accountId);
		return yield* Effect.forEach(providers.availableProviders, (provider) =>
			resolveConnectedProvider(
				accountId,
				provider.providerId,
				records.find(
					(record) =>
						record.active && record.providerId === provider.providerId,
				)?.connectionId,
			),
		);
	},
);
