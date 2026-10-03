import type { StartSessionInput } from "@zuse/contracts";

/** Server-only launch data. Never add these values to the public session schema. */
export type DriverStartSessionInput = StartSessionInput & {
	readonly executionEnvironment?: Readonly<Record<string, string>>;
};
