import type { PoolConfig } from "pg";

export const hyperdrivePoolConfig = (connectionString: string): PoolConfig => ({
	connectionString,
	max: 1,
	connectionTimeoutMillis: 5_000,
});
