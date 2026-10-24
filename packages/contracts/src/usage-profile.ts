import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { CloudWorkspaceOpError } from "./cloud-workspaces.ts";
import { UsageSourceId } from "./usage.ts";

const Count = Schema.Number.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const ShortText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(100),
);
const TokenShares = (max: number) =>
	Schema.Array(Schema.Struct({ name: ShortText, tokens: Count })).check(
		Schema.isMaxLength(max),
	);
/** Aggregate year-to-date usage. Cost and hours are opt-in and null when hidden. */
export const UsageProfileSnapshot = Schema.Struct({
	year: Schema.Number.check(
		Schema.isInt(),
		Schema.isBetween({ minimum: 2020, maximum: 2100 }),
	),
	generatedAt: Schema.String,
	sessionCount: Count,
	days: Schema.Array(
		Schema.Struct({ date: Schema.String, tokens: Count }),
	).check(Schema.isMaxLength(366)),
	models: TokenShares(64),
	breakdown: Schema.Struct({
		input: Count,
		output: Count,
		cacheRead: Count,
		cacheWrite: Count,
		reasoning: Count,
	}),
	sources: Schema.Array(
		Schema.Struct({ id: UsageSourceId, label: ShortText, tokens: Count }),
	).check(Schema.isMaxLength(16)),
	months: Schema.Array(
		Schema.Struct({
			month: Schema.Number.check(
				Schema.isInt(),
				Schema.isBetween({ minimum: 1, maximum: 12 }),
			),
			models: TokenShares(9),
		}),
	).check(Schema.isMaxLength(12)),
	projectCount: Count,
	sessionMinutes: Schema.Struct({ median: Count, longest: Count }),
	cost: Schema.NullOr(
		Schema.Struct({
			usd: Schema.Number.check(
				Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 }),
			),
			complete: Schema.Boolean,
		}),
	),
	hours: Schema.NullOr(
		Schema.Array(Count).check(Schema.isMinLength(24), Schema.isMaxLength(24)),
	),
});
export type UsageProfileSnapshot = typeof UsageProfileSnapshot.Type;
export const UsageProfileInput = Schema.Struct({
	handle: Schema.String.check(
		Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/u),
	),
	displayName: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(60),
	),
	github: Schema.String.check(
		Schema.isPattern(/^(?:[a-zA-Z0-9][a-zA-Z0-9-]{0,38})?$/u),
	),
	...UsageProfileSnapshot.fields,
});
export type UsageProfileInput = typeof UsageProfileInput.Type;
export const PublicUsageProfile = Schema.Struct({
	...UsageProfileInput.fields,
	publishedAt: Schema.Number,
	updatedAt: Schema.Number,
});
export type PublicUsageProfile = typeof PublicUsageProfile.Type;
export const UsageProfileState = Schema.Struct({
	profile: Schema.NullOr(PublicUsageProfile),
	published: Schema.Boolean,
});
export type UsageProfileState = typeof UsageProfileState.Type;
export const UsageProfileGetRpc = Rpc.make("usage.profile.get", {
	success: UsageProfileState,
	error: CloudWorkspaceOpError,
});
export const UsageProfilePublishRpc = Rpc.make("usage.profile.publish", {
	payload: UsageProfileInput,
	success: UsageProfileState,
	error: CloudWorkspaceOpError,
});
export const UsageProfileUnpublishRpc = Rpc.make("usage.profile.unpublish", {
	success: UsageProfileState,
	error: CloudWorkspaceOpError,
});
/** Builds the local snapshot; `timeZone` only places the opt-in hour histogram. */
export const UsageProfileSnapshotRpc = Rpc.make("usage.profile.snapshot", {
	payload: Schema.Struct({ timeZone: Schema.String }),
	success: UsageProfileSnapshot,
});
