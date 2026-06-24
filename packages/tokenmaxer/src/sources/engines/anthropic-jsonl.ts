import { readFileSync } from "node:fs";
import { join, sep } from "node:path";

import { makeUsageRecord } from "../../normalize.ts";
import type { UsageRecord, UsageSourceId } from "../../types.ts";
import { collectFiles, YIELD_EVERY, yieldToEventLoop } from "../fs-util.ts";

const USAGE_MARKER = '"usage":{';

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  speed?: string;
}

interface AnthropicLine {
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  requestId?: string;
  costUSD?: number;
  isApiErrorMessage?: boolean;
  message?: {
    usage?: AnthropicUsage;
    model?: string;
    id?: string;
  };
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Project name = the path segment immediately after `projects/`. */
const projectFromPath = (path: string, projectsDir: string): string => {
  const segments = path.split(sep);
  const index = segments.indexOf(projectsDir);
  return index === -1 || index + 1 >= segments.length ? "unknown" : (segments[index + 1] ?? "unknown");
};

interface ParsedEntry {
  readonly uniqueHash: string | null;
  readonly tokenTotal: number;
  readonly record: UsageRecord;
}

/**
 * Parse Claude-Code-format JSONL (`message.usage` schema) from one or more
 * config roots, deduplicating by `message.id[:requestId]` and keeping the entry
 * with the larger token total on collision. Ports ccusage's Claude data-loader.
 */
export const readAnthropicJsonl = async (input: {
  readonly sourceId: UsageSourceId;
  readonly sourceLabel: string;
  readonly roots: ReadonlyArray<string>;
  readonly projectsSubdir?: string;
}): Promise<{ records: UsageRecord[]; files: string[] }> => {
  const projectsDir = input.projectsSubdir ?? "projects";
  const files = input.roots.flatMap((root) => collectFiles(join(root, projectsDir), ".jsonl"));

  const parsed: ParsedEntry[] = [];
  let processed = 0;
  for (const file of files) {
    if (++processed % YIELD_EVERY === 0) await yieldToEventLoop();
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const project = projectFromPath(file, projectsDir);
    for (const line of text.split("\n")) {
      if (!line.includes(USAGE_MARKER)) continue;
      let data: AnthropicLine;
      try {
        data = JSON.parse(line) as AnthropicLine;
      } catch {
        continue;
      }
      const usage = data.message?.usage;
      if (
        data.isApiErrorMessage === true ||
        usage === undefined ||
        typeof usage.input_tokens !== "number" ||
        typeof usage.output_tokens !== "number"
      ) {
        continue;
      }
      const counts = {
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        cacheReadTokens: num(usage.cache_read_input_tokens),
        cacheCreationTokens: num(usage.cache_creation_input_tokens),
        reasoningTokens: 0,
      };
      const messageId = data.message?.id ?? null;
      const requestId = data.requestId ?? null;
      const uniqueHash =
        messageId === null ? null : requestId === null ? messageId : `${messageId}:${requestId}`;
      const sessionId = data.sessionId ?? file.split(sep).pop()?.replace(/\.jsonl$/i, "") ?? null;
      parsed.push({
        uniqueHash,
        tokenTotal:
          counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheCreationTokens,
        record: makeUsageRecord({
          sourceId: input.sourceId,
          sourceLabel: input.sourceLabel,
          providerId: input.sourceId,
          model: data.message?.model ?? null,
          sessionId,
          projectPath: project,
          workspacePath: data.cwd ?? project,
          startedAt: data.timestamp,
          endedAt: data.timestamp,
          counts,
          loggedCostUsd: typeof data.costUSD === "number" ? data.costUSD : null,
          fast: usage.speed === "fast",
          provenance: `${file}#${messageId ?? "?"}`,
          confidence: "exact",
          fingerprintParts: [uniqueHash ?? `${file}:${data.timestamp ?? ""}`],
        }),
      });
    }
  }

  return { records: dedupe(parsed), files };
};

/** Keep one entry per uniqueHash (larger token total wins); null hashes kept. */
const dedupe = (entries: ReadonlyArray<ParsedEntry>): UsageRecord[] => {
  const byHash = new Map<string, ParsedEntry>();
  const kept: UsageRecord[] = [];
  for (const entry of entries) {
    if (entry.uniqueHash === null) {
      kept.push(entry.record);
      continue;
    }
    const existing = byHash.get(entry.uniqueHash);
    if (existing === undefined || entry.tokenTotal > existing.tokenTotal) {
      byHash.set(entry.uniqueHash, entry);
    }
  }
  for (const entry of byHash.values()) kept.push(entry.record);
  return kept;
};
