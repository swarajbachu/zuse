import { Rpc } from "@effect/rpc";
import { Schema } from "effect";

import { FolderId } from "./ids.ts";

export const UsageSourceId = Schema.Literal(
  "zuse",
  "memoize",
  "claude",
  "codex",
  "opencode",
  "amp",
  "pi",
  "grok",
);
export type UsageSourceId = typeof UsageSourceId.Type;

export const UsageBucket = Schema.Literal("daily", "weekly", "monthly", "session");
export type UsageBucket = typeof UsageBucket.Type;

const UsageCostStatus = Schema.Literal("known", "partial", "unknown");

export class UsageSummary extends Schema.Class<UsageSummary>("UsageSummary")({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheCreationTokens: Schema.Number,
  reasoningTokens: Schema.Number,
  costUsd: Schema.NullOr(Schema.Number),
  costStatus: UsageCostStatus,
  recordCount: Schema.Number,
  possibleDuplicateCount: Schema.Number,
}) {}

export class UsageGroup extends Schema.Class<UsageGroup>("UsageGroup")({
  key: Schema.String,
  label: Schema.String,
  startedAt: Schema.NullOr(Schema.DateFromString),
  endedAt: Schema.NullOr(Schema.DateFromString),
  sourceIds: Schema.Array(UsageSourceId),
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheCreationTokens: Schema.Number,
  reasoningTokens: Schema.Number,
  costUsd: Schema.NullOr(Schema.Number),
  costStatus: UsageCostStatus,
  recordCount: Schema.Number,
  possibleDuplicateCount: Schema.Number,
}) {}

export class UsageRecord extends Schema.Class<UsageRecord>("UsageRecord")({
  id: Schema.String,
  sourceId: UsageSourceId,
  sourceLabel: Schema.String,
  providerId: Schema.String,
  model: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  projectPath: Schema.NullOr(Schema.String),
  workspacePath: Schema.NullOr(Schema.String),
  startedAt: Schema.DateFromString,
  endedAt: Schema.DateFromString,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheCreationTokens: Schema.Number,
  reasoningTokens: Schema.Number,
  costUsd: Schema.NullOr(Schema.Number),
  costStatus: Schema.Literal("known", "unknown"),
  provenance: Schema.String,
  confidence: Schema.Literal("exact", "partial", "estimated"),
  fingerprint: Schema.String,
  possibleDuplicate: Schema.Boolean,
}) {}

export class UsageSourceStatus extends Schema.Class<UsageSourceStatus>(
  "UsageSourceStatus",
)({
  id: UsageSourceId,
  label: Schema.String,
  detected: Schema.Boolean,
  recordCount: Schema.Number,
  paths: Schema.Array(Schema.String),
  warning: Schema.NullOr(Schema.String),
}) {}

export class UsageReport extends Schema.Class<UsageReport>("UsageReport")({
  bucket: UsageBucket,
  generatedAt: Schema.DateFromString,
  summary: UsageSummary,
  groups: Schema.Array(UsageGroup),
  bySource: Schema.Array(UsageGroup),
  byModel: Schema.Array(UsageGroup),
  bySession: Schema.Array(UsageGroup),
  records: Schema.Array(UsageRecord),
  sources: Schema.Array(UsageSourceStatus),
}) {}

export const UsageReportRpc = Rpc.make("usage.report", {
  payload: Schema.Struct({
    bucket: Schema.optional(UsageBucket),
    sourceIds: Schema.optional(Schema.Array(UsageSourceId)),
    since: Schema.optional(Schema.DateFromString),
    until: Schema.optional(Schema.DateFromString),
    timezone: Schema.optional(Schema.String),
    projectId: Schema.optional(FolderId),
    includePossibleDuplicates: Schema.optional(Schema.Boolean),
    forceRefresh: Schema.optional(Schema.Boolean),
  }),
  success: UsageReport,
});
