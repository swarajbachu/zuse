import { Schema } from "effect";

export const NetworkAccessMode = Schema.Literals([
	"local-only",
	"network-accessible",
]);
export type NetworkAccessMode = typeof NetworkAccessMode.Type;

export class NetworkAccessState extends Schema.Class<NetworkAccessState>(
	"NetworkAccessState",
)({
	mode: NetworkAccessMode,
	advertisedHost: Schema.NullOr(Schema.String),
	endpointUrl: Schema.NullOr(Schema.String),
	port: Schema.Number,
}) {}
