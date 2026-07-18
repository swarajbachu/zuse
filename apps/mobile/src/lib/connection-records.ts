import { Schema } from "effect";

export const ConnectionSource = Schema.Literals(["paired", "relay", "manual"]);
export type ConnectionSource = typeof ConnectionSource.Type;

const LegacyConnectionRecord = Schema.Struct({
	key: Schema.String,
	environmentId: Schema.optional(Schema.String),
	host: Schema.String,
	port: Schema.Number,
	token: Schema.optional(Schema.NullOr(Schema.String)),
	wsBaseUrl: Schema.optional(Schema.NullOr(Schema.String)),
	label: Schema.String,
	updatedAt: Schema.Number,
	source: Schema.optional(ConnectionSource),
});

export type ConnectionRecord = Omit<
	typeof LegacyConnectionRecord.Type,
	"source"
> & {
	readonly source: ConnectionSource;
};

export const connectionStorageKey = (
	source: ConnectionSource,
	identity: string,
): string => `${source}:${identity}`;

const inferSource = (
	record: typeof LegacyConnectionRecord.Type,
): ConnectionSource => {
	if (record.source !== undefined) return record.source;
	if (record.wsBaseUrl !== undefined && record.wsBaseUrl !== null)
		return "relay";
	if (record.token !== undefined && record.token !== null) return "paired";
	return "manual";
};

export const decodeConnectionRecords = (value: unknown): ConnectionRecord[] =>
	Schema.decodeUnknownSync(Schema.Array(LegacyConnectionRecord))(value).map(
		(record) => {
			const source = inferSource(record);
			return { ...record, source };
		},
	);

export const availableConnections = (
	connections: readonly ConnectionRecord[],
	signedIn: boolean,
): ConnectionRecord[] => {
	const priority: Record<ConnectionSource, number> = {
		paired: 3,
		manual: 2,
		relay: 1,
	};
	const selected = new Map<string, ConnectionRecord>();
	for (const connection of connections) {
		if (connection.source === "relay" && !signedIn) continue;
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
