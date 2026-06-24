import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";

import { makeUsageRecord } from "../../normalize.ts";
import type { UsageRecord } from "../../types.ts";
import { collectFiles, YIELD_EVERY, yieldToEventLoop } from "../fs-util.ts";

const FALLBACK_MODEL = "gpt-5";

interface RawUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

interface CodexEvent {
  readonly sessionId: string;
  readonly timestamp: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const nonEmpty = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const normalizeRawUsage = (value: unknown): RawUsage | null => {
  const record = asRecord(value);
  if (record === null) return null;
  const input = num(record.input_tokens);
  const cached = num(record.cached_input_tokens ?? record.cache_read_input_tokens);
  const output = num(record.output_tokens);
  const reasoning = num(record.reasoning_output_tokens);
  const total = num(record.total_tokens);
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total > 0 ? total : input + output + reasoning,
  };
};

const subtract = (current: RawUsage, previous: RawUsage | null): RawUsage => ({
  input_tokens: Math.max(current.input_tokens - (previous?.input_tokens ?? 0), 0),
  cached_input_tokens: Math.max(current.cached_input_tokens - (previous?.cached_input_tokens ?? 0), 0),
  output_tokens: Math.max(current.output_tokens - (previous?.output_tokens ?? 0), 0),
  reasoning_output_tokens: Math.max(
    current.reasoning_output_tokens - (previous?.reasoning_output_tokens ?? 0),
    0,
  ),
  total_tokens: Math.max(current.total_tokens - (previous?.total_tokens ?? 0), 0),
});

const extractModel = (payload: Record<string, unknown>): string | undefined => {
  const info = asRecord(payload.info);
  if (info !== null) {
    const model = nonEmpty(info.model) ?? nonEmpty(info.model_name);
    if (model !== undefined) return model;
    const metadataModel = nonEmpty(asRecord(info.metadata)?.model);
    if (metadataModel !== undefined) return metadataModel;
  }
  return nonEmpty(payload.model) ?? nonEmpty(asRecord(payload.metadata)?.model);
};

const parseSessionFile = (sessionsDir: string, file: string): CodexEvent[] => {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const sessionId = relative(sessionsDir, file).split(sep).join("/").replace(/\.jsonl$/i, "");
  const events: CodexEvent[] = [];
  let previousTotals: RawUsage | null = null;
  let currentModel: string | undefined;

  for (const line of text.split("\n")) {
    if (!line.includes("token_count") && !line.includes("turn_context")) continue;
    let entry: Record<string, unknown> | null;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry === null) continue;
    const type = typeof entry.type === "string" ? entry.type : undefined;
    const payload = asRecord(entry.payload);

    if (type === "turn_context") {
      const model = payload === null ? undefined : extractModel(payload);
      if (model !== undefined) currentModel = model;
      continue;
    }
    if (type !== "event_msg" || payload === null || payload.type !== "token_count") continue;
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    if (timestamp === undefined) continue;

    const info = asRecord(payload.info);
    const lastUsage = normalizeRawUsage(info?.last_token_usage);
    const totalUsage = normalizeRawUsage(info?.total_token_usage);
    let raw = lastUsage;
    if (raw === null && totalUsage !== null) raw = subtract(totalUsage, previousTotals);
    if (totalUsage !== null) previousTotals = totalUsage;
    if (raw === null) continue;

    const cached = Math.min(raw.cached_input_tokens, raw.input_tokens);
    if (raw.input_tokens === 0 && raw.output_tokens === 0 && raw.reasoning_output_tokens === 0) {
      continue;
    }

    const model = extractModel(payload) ?? currentModel;
    if (model !== undefined) currentModel = model;
    events.push({
      sessionId,
      timestamp,
      model: model ?? FALLBACK_MODEL,
      inputTokens: raw.input_tokens,
      cachedInputTokens: cached,
      outputTokens: raw.output_tokens,
      reasoningOutputTokens: raw.reasoning_output_tokens,
      totalTokens: raw.total_tokens > 0 ? raw.total_tokens : raw.input_tokens + raw.output_tokens + raw.reasoning_output_tokens,
    });
  }
  return events;
};

const eventKey = (event: CodexEvent): string =>
  [
    event.timestamp,
    event.model,
    event.inputTokens,
    event.cachedInputTokens,
    event.outputTokens,
    event.reasoningOutputTokens,
    event.totalTokens,
  ].join("\0");

/**
 * Parse Codex `sessions/**\/*.jsonl` token_count events, preferring per-turn
 * `last_token_usage` and otherwise subtracting the running cumulative total to
 * avoid double counting. Input tokens are stored exclusive of cache. Ports
 * ccusage's Codex parser.
 */
export const readCodexJsonl = async (input: {
  readonly sourceId: "codex";
  readonly sourceLabel: string;
  readonly sessionsDirs: ReadonlyArray<string>;
}): Promise<{ records: UsageRecord[]; files: string[] }> => {
  const files: string[] = [];
  const seen = new Set<string>();
  const records: UsageRecord[] = [];
  let processed = 0;

  for (const sessionsDir of input.sessionsDirs) {
    const dirFiles = collectFiles(sessionsDir, ".jsonl");
    files.push(...dirFiles);
    for (const file of dirFiles) {
      if (++processed % YIELD_EVERY === 0) await yieldToEventLoop();
      for (const event of parseSessionFile(sessionsDir, file)) {
        const key = eventKey(event);
        if (seen.has(key)) continue;
        seen.add(key);
        const inputExclusive = Math.max(event.inputTokens - event.cachedInputTokens, 0);
        records.push(
          makeUsageRecord({
            sourceId: input.sourceId,
            sourceLabel: input.sourceLabel,
            providerId: "codex",
            model: event.model,
            sessionId: event.sessionId,
            projectPath: null,
            startedAt: event.timestamp,
            endedAt: event.timestamp,
            counts: {
              inputTokens: inputExclusive,
              outputTokens: event.outputTokens,
              cacheReadTokens: event.cachedInputTokens,
              cacheCreationTokens: 0,
              reasoningTokens: event.reasoningOutputTokens,
            },
            provenance: `${file}#${event.timestamp}`,
            confidence: "exact",
            fingerprintParts: [key],
          }),
        );
      }
    }
  }

  return { records, files };
};
