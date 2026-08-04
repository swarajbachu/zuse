import type { Schema } from "effect";

export type ServeServiceState = "running" | "stopped" | "missing";
export type ServeTunnelState = "configured" | "unavailable";

export interface ServeStatusV1 {
	readonly schemaVersion: 1;
	readonly computer: string;
	readonly service: ServeServiceState;
	readonly tunnel: ServeTunnelState;
	readonly runtimeVersion: string;
	readonly agents: ReadonlyArray<string>;
	readonly reachable: boolean;
	readonly environmentId: string | null;
	readonly durable: boolean;
	readonly dataDir: string;
	readonly appUrl: string;
}

export declare const ServeServiceState: Schema.Schema<ServeServiceState>;
export declare const ServeTunnelState: Schema.Schema<ServeTunnelState>;
export declare const ServeStatusV1: Schema.Schema<ServeStatusV1>;
