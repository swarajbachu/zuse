import { Schema } from "effect";

/** Headless runtime release tested against this desktop wire contract. */
export const COMPATIBLE_SERVE_RUNTIME_VERSION = "0.1.6" as const;

export const ServeServiceState = Schema.Literals([
	"running",
	"stopped",
	"missing",
]);
export type ServeServiceState = typeof ServeServiceState.Type;

export const ServeTunnelState = Schema.Literals(["configured", "unavailable"]);
export type ServeTunnelState = typeof ServeTunnelState.Type;

/** Stable JSON emitted by `zuse serve status --json`. */
export const ServeStatusV1 = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	computer: Schema.String,
	service: ServeServiceState,
	tunnel: ServeTunnelState,
	runtimeVersion: Schema.String,
	agents: Schema.Array(Schema.String),
	reachable: Schema.Boolean,
	environmentId: Schema.NullOr(Schema.String),
	durable: Schema.Boolean,
	dataDir: Schema.String,
	appUrl: Schema.String,
});
export type ServeStatusV1 = typeof ServeStatusV1.Type;
