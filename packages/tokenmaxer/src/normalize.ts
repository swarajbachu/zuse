import { createHash } from "node:crypto";

import type {
  TokenCounts,
  UsageConfidence,
  UsageRecord,
  UsageSourceId,
} from "./types.ts";

export const ZERO_TOKENS: TokenCounts = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
};

export const addCounts = <T extends TokenCounts>(target: T, delta: TokenCounts): T => {
  (target as { inputTokens: number }).inputTokens += delta.inputTokens;
  (target as { outputTokens: number }).outputTokens += delta.outputTokens;
  (target as { cacheReadTokens: number }).cacheReadTokens += delta.cacheReadTokens;
  (target as { cacheCreationTokens: number }).cacheCreationTokens += delta.cacheCreationTokens;
  (target as { reasoningTokens: number }).reasoningTokens += delta.reasoningTokens;
  return target;
};

export const hashStable = (input: string): string =>
  createHash("sha256").update(input).digest("hex").slice(0, 24);

const coerceDate = (value: unknown, fallback: Date): Date => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number") {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const d = new Date(millis);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
};

export const numberFrom = (...values: unknown[]): number => {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
};

export const makeUsageRecord = (input: {
  sourceId: UsageSourceId;
  sourceLabel: string;
  providerId?: string;
  model?: string | null;
  sessionId?: string | null;
  projectPath?: string | null;
  workspacePath?: string | null;
  startedAt?: unknown;
  endedAt?: unknown;
  counts: Partial<TokenCounts>;
  loggedCostUsd?: number | null;
  fast?: boolean;
  provenance: string;
  confidence?: UsageConfidence;
  fingerprintParts?: ReadonlyArray<string | null | undefined>;
}): UsageRecord => {
  const now = new Date();
  const startedAt = coerceDate(input.startedAt, now);
  const endedAt = coerceDate(input.endedAt, startedAt);
  const counts: TokenCounts = {
    inputTokens: input.counts.inputTokens ?? 0,
    outputTokens: input.counts.outputTokens ?? 0,
    cacheReadTokens: input.counts.cacheReadTokens ?? 0,
    cacheCreationTokens: input.counts.cacheCreationTokens ?? 0,
    reasoningTokens: input.counts.reasoningTokens ?? 0,
  };
  const model = input.model?.trim() || "unknown";
  const fingerprint = hashStable(
    [
      input.sourceId,
      input.providerId ?? input.sourceId,
      model,
      input.sessionId ?? "",
      input.projectPath ?? "",
      startedAt.toISOString(),
      endedAt.toISOString(),
      counts.inputTokens,
      counts.outputTokens,
      counts.cacheReadTokens,
      counts.cacheCreationTokens,
      counts.reasoningTokens,
      ...(input.fingerprintParts ?? []),
    ].join("\u001f"),
  );

  return {
    id: `${input.sourceId}-${fingerprint}`,
    sourceId: input.sourceId,
    sourceLabel: input.sourceLabel,
    providerId: input.providerId ?? input.sourceId,
    model,
    sessionId: input.sessionId ?? null,
    projectPath: input.projectPath ?? null,
    workspacePath: input.workspacePath ?? input.projectPath ?? null,
    startedAt,
    endedAt,
    ...counts,
    costUsd: null,
    costStatus: "unknown",
    loggedCostUsd: input.loggedCostUsd ?? null,
    fast: input.fast ?? false,
    provenance: input.provenance,
    confidence: input.confidence ?? "exact",
    fingerprint,
    possibleDuplicate: false,
  };
};

export const withDuplicateFlags = (
  records: ReadonlyArray<UsageRecord>,
): ReadonlyArray<UsageRecord> => {
  const seen = new Map<string, number>();
  return records.map((record) => {
    const key = [
      record.providerId,
      record.model,
      record.sessionId ?? "",
      record.projectPath ?? "",
      record.startedAt.toISOString(),
      record.inputTokens,
      record.outputTokens,
      record.cacheReadTokens,
      record.cacheCreationTokens,
    ].join("\u001f");
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? record : { ...record, possibleDuplicate: true };
  });
};
