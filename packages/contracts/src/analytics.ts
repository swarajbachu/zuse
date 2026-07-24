import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

export const AnalyticsIdentityKind = Schema.Literals(["anonymous", "account"]);
export type AnalyticsIdentityKind = typeof AnalyticsIdentityKind.Type;

/** The intentionally narrow analytics context shared with trusted clients. */
export class AnalyticsContext extends Schema.Class<AnalyticsContext>(
	"AnalyticsContext",
)({
	enabled: Schema.Boolean,
	distinctId: Schema.String,
	identityKind: AnalyticsIdentityKind,
}) {}

export const AnalyticsGetContextRpc = Rpc.make("analytics.getContext", {
	success: AnalyticsContext,
});

export const AnalyticsContextChangesRpc = Rpc.make("analytics.contextChanges", {
	success: AnalyticsContext,
	stream: true,
});
