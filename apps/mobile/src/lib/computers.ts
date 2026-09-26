import {
	availableConnections,
	type ConnectionRecord,
} from "./connection-records";

export type ComputerEnvironment = {
	readonly environmentId: string;
	readonly label: string;
	readonly presence: "online" | "offline" | "unknown";
};

/** Network routes share an authenticated environment identity, never a display name. */
export const computerRows = (
	connections: readonly ConnectionRecord[],
	environments: readonly ComputerEnvironment[],
	signedIn: boolean,
	snapshots: Readonly<Record<string, { status: string }>>,
) => {
	const selected = availableConnections(
		connections.filter((c) => c.source !== "cloud"),
		signedIn,
		snapshots,
	);
	const rows: {
		key: string;
		connection?: ConnectionRecord;
		environment?: ComputerEnvironment;
	}[] = selected.map((connection) => ({
		key: connection.environmentId ?? connection.key,
		connection,
	}));
	const byId = new Map(rows.map((row) => [row.key, row]));
	if (signedIn)
		for (const environment of environments) {
			const row = byId.get(environment.environmentId);
			if (row) row.environment = environment;
			else {
				const next = { key: environment.environmentId, environment };
				rows.push(next);
				byId.set(next.key, next);
			}
		}
	return rows;
};
