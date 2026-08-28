import { CapabilityFeature, CapabilityManifest } from "@zuse/contracts";
import { Schema } from "effect";

export const ConnectionSource = Schema.Literals(["paired", "api", "manual"]);
export type ConnectionSource = typeof ConnectionSource.Type;
const LegacyConnectionSource = Schema.Literal("relay");

export const LocalPathType = Schema.Literals(["lan", "apple-peer"]);
export type LocalPathType = typeof LocalPathType.Type;

const ConnectionRecordFields = {
	key: Schema.String,
	environmentId: Schema.optional(Schema.String),
	host: Schema.String,
	port: Schema.Number,
	token: Schema.optional(Schema.NullOr(Schema.String)),
	wsBaseUrl: Schema.optional(Schema.NullOr(Schema.String)),
	serverKeyPin: Schema.optional(Schema.String),
	serverPublicKey: Schema.optional(Schema.String),
	transportCertificatePin: Schema.optional(Schema.String),
	nearbyServiceName: Schema.optional(Schema.String),
	routeGeneration: Schema.optional(Schema.Number),
	pathType: Schema.optional(LocalPathType),
	refreshAccountGrant: Schema.optional(Schema.Boolean),
	label: Schema.String,
	updatedAt: Schema.Number,
	source: Schema.optional(
		Schema.Union([ConnectionSource, LegacyConnectionSource]),
	),
};

const CurrentConnectionRecord = Schema.Struct({
	...ConnectionRecordFields,
	capabilities: Schema.optional(CapabilityManifest),
});

const FlatCapabilityList = Schema.Array(CapabilityFeature);

const FlatCapabilitiesConnectionRecord = Schema.Struct({
	...ConnectionRecordFields,
	capabilities: Schema.optional(FlatCapabilityList),
});

const StoredConnectionRecord = Schema.Union([
	CurrentConnectionRecord,
	FlatCapabilitiesConnectionRecord,
]);

export type ConnectionRecord = Omit<
	typeof CurrentConnectionRecord.Type,
	"source"
> & {
	readonly source: ConnectionSource;
};

export const connectionStorageKey = (
	source: ConnectionSource,
	identity: string,
): string => `${source}:${identity}`;

export const replaceDiscoveredRoute = (
	record: ConnectionRecord,
	route: {
		readonly host: string;
		readonly port: number;
		readonly pathType: LocalPathType;
		readonly nearbyServiceName?: string;
		readonly transportCertificatePin?: string;
	},
): ConnectionRecord => ({
	...record,
	host: route.host.trim(),
	port: route.port,
	pathType: route.pathType,
	...(route.nearbyServiceName === undefined
		? {}
		: { nearbyServiceName: route.nearbyServiceName }),
	...(route.transportCertificatePin === undefined
		? {}
		: { transportCertificatePin: route.transportCertificatePin }),
	routeGeneration: (record.routeGeneration ?? 0) + 1,
	updatedAt: Date.now(),
});

export const connectionSupports = (
	record: ConnectionRecord | undefined,
	capability: typeof CapabilityFeature.Type,
): boolean => record?.capabilities?.features.includes(capability) === true;

export const refreshConnectionDescriptor = (
	connections: ConnectionRecord[],
	key: string,
	label: string,
	capabilities: typeof CapabilityManifest.Type | undefined,
	now: number = Date.now(),
): ConnectionRecord[] => {
	const current = connections.find((connection) => connection.key === key);
	if (current === undefined) return connections;
	const sameCapabilities =
		current.capabilities === capabilities ||
		(current.capabilities !== undefined &&
			capabilities !== undefined &&
			current.capabilities.version === capabilities.version &&
			current.capabilities.features.length === capabilities.features.length &&
			current.capabilities.features.every((feature) =>
				capabilities.features.includes(feature),
			));
	if (current.label === label && sameCapabilities) return connections;
	return connections.map((connection) =>
		connection.key === key
			? { ...connection, label, capabilities, updatedAt: now }
			: connection,
	);
};

const inferSource = (
	record: typeof StoredConnectionRecord.Type,
): ConnectionSource => {
	if (record.source === "relay") return "api";
	if (record.source !== undefined) return record.source;
	if (record.wsBaseUrl !== undefined && record.wsBaseUrl !== null) return "api";
	if (record.token !== undefined && record.token !== null) return "paired";
	return "manual";
};

export const decodeConnectionRecords = (value: unknown): ConnectionRecord[] =>
	Schema.decodeUnknownSync(Schema.Array(StoredConnectionRecord))(value).map(
		(record) => {
			const legacyApiSource = record.source === "relay";
			const source = inferSource(record);
			const capabilities = Schema.is(FlatCapabilityList)(record.capabilities)
				? CapabilityManifest.make({ version: 1, features: record.capabilities })
				: record.capabilities;
			return {
				...record,
				key:
					legacyApiSource && record.key.startsWith("relay:")
						? `api:${record.key.slice("relay:".length)}`
						: record.key,
				capabilities,
				source,
			};
		},
	);

export const availableConnections = (
	connections: readonly ConnectionRecord[],
	signedIn: boolean,
): ConnectionRecord[] => {
	const priority: Record<ConnectionSource, number> = {
		paired: 3,
		manual: 2,
		api: 1,
	};
	const selected = new Map<string, ConnectionRecord>();
	for (const connection of connections) {
		if (connection.source === "api" && !signedIn) continue;
		const identity = connection.environmentId ?? connection.key;
		const current = selected.get(identity);
		if (
			current === undefined ||
			priority[connection.source] > priority[current.source] ||
			(priority[connection.source] === priority[current.source] &&
				connection.updatedAt > current.updatedAt)
		) {
			selected.set(identity, connection);
		}
	}
	return [...selected.values()];
};
