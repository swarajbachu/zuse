import { Schema } from "effect";

import { EnvironmentDescriptor } from "./connect.ts";
import { EnvironmentId } from "./ids.ts";

export const TailnetShareAvailability = Schema.Literals([
	"not-installed",
	"signed-out",
	"approval-required",
	"available",
	"error",
]);
export type TailnetShareAvailability = typeof TailnetShareAvailability.Type;

export class TailnetShareState extends Schema.Class<TailnetShareState>(
	"TailnetShareState",
)({
	availability: TailnetShareAvailability,
	enabled: Schema.Boolean,
	dnsName: Schema.NullOr(Schema.String),
	httpsUrl: Schema.NullOr(Schema.String),
	backendState: Schema.NullOr(Schema.String),
	port: Schema.Number,
	detail: Schema.NullOr(Schema.String),
	approvalUrl: Schema.NullOr(Schema.String),
}) {}

export class TailnetEnvironmentProfile extends Schema.Class<TailnetEnvironmentProfile>(
	"TailnetEnvironmentProfile",
)({
	profileId: Schema.String,
	environmentId: EnvironmentId,
	label: Schema.String,
	httpBaseUrl: Schema.String,
	wsBaseUrl: Schema.String,
	lastConnectedAt: Schema.String,
}) {}

export const EnsureTailnetEnvironmentInput = Schema.Union([
	Schema.Struct({ profileId: Schema.String }),
	Schema.Struct({
		pairingLink: Schema.String,
		label: Schema.optional(Schema.String),
	}),
]);
export type EnsureTailnetEnvironmentInput =
	typeof EnsureTailnetEnvironmentInput.Type;

export class TailnetEnvironmentConnection extends Schema.Class<TailnetEnvironmentConnection>(
	"TailnetEnvironmentConnection",
)({
	descriptor: EnvironmentDescriptor,
	profile: TailnetEnvironmentProfile,
	wsUrl: Schema.String,
}) {}
