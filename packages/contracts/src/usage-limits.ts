import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { ProviderId } from "./agent.ts";

export const UsageLimitScope = Schema.Literals([
  "session",
  "weekly",
  "model",
  "overall",
]);
export type UsageLimitScope = typeof UsageLimitScope.Type;

export class UsageLimitWindow extends Schema.Class<UsageLimitWindow>(
  "UsageLimitWindow",
)({
  id: Schema.String,
  label: Schema.String,
  scope: UsageLimitScope,
  usedPercent: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(Schema.String),
  windowMinutes: Schema.NullOr(Schema.Number),
}) {}

export class ProviderUsageLimits extends Schema.Class<ProviderUsageLimits>(
  "ProviderUsageLimits",
)({
  providerId: ProviderId,
  planLabel: Schema.NullOr(Schema.String),
  windows: Schema.Array(UsageLimitWindow),
  creditsRemaining: Schema.NullOr(Schema.Number),
  fetchedAt: Schema.String,
  source: Schema.Literals(["api", "session-event", "cache"]),
  unavailableReason: Schema.optional(
    Schema.Literals([
      "no-credentials",
      "expired",
      "scope-missing",
      "unsupported",
      "error",
    ]),
  ),
}) {}

export const UsageLimitsRpc = Rpc.make("usage.limits", {
  payload: Schema.Struct({
    forceRefresh: Schema.optional(Schema.Boolean),
    providerId: Schema.optional(ProviderId),
  }),
  success: Schema.Struct({ providers: Schema.Array(ProviderUsageLimits) }),
});
