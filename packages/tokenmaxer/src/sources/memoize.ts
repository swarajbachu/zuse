import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { makeUsageRecord, numberFrom } from "../normalize.ts";
import type { UsageRecord, UsageSourceReadResult } from "../types.ts";
import { openReadonlyDatabase } from "./sqlite.ts";

interface MemoizeUsageRow {
  readonly message_id: string;
  readonly session_id: string;
  readonly content_json: string;
  readonly created_at: string;
  readonly provider_id: string | null;
  readonly session_model: string | null;
  readonly project_path: string | null;
}

export const memoizeDbPathCandidates = (): string[] => {
  const override = process.env.MEMOIZE_USER_DATA_DIR?.trim();
  if (override) return [join(override, "memoize.sqlite")];
  if (process.platform === "darwin") {
    const base = join(homedir(), "Library", "Application Support");
    return ["memoize Alpha", "memoize", "memoize Alpha (Dev)", "memoize (Dev)", "monkit Beta"].map(
      (name) => join(base, name, "memoize.sqlite"),
    );
  }
  if (process.env.XDG_DATA_HOME) {
    return [join(process.env.XDG_DATA_HOME, "memoize", "memoize.sqlite")];
  }
  return [join(homedir(), ".local", "share", "memoize", "memoize.sqlite")];
};

export const defaultMemoizeDbPath = (): string | null => {
  const candidates = memoizeDbPathCandidates();
  return candidates.find((path) => existsSync(path)) ?? candidates[0] ?? null;
};

/** A `content_json.model` of "unknown"/empty should fall back to the session model. */
const resolveModel = (contentModel: unknown, sessionModel: string | null): string | null => {
  if (typeof contentModel === "string") {
    const trimmed = contentModel.trim();
    if (trimmed !== "" && trimmed !== "unknown") return trimmed;
  }
  return sessionModel;
};

export const readMemoizeUsage = (dbPath?: string | null): UsageSourceReadResult => {
  const candidates =
    dbPath !== undefined && dbPath !== null
      ? [dbPath]
      : memoizeDbPathCandidates().filter((path) => existsSync(path));
  const statusPaths =
    candidates.length > 0
      ? candidates
      : dbPath !== undefined && dbPath !== null
        ? [dbPath]
        : memoizeDbPathCandidates();
  if (candidates.length === 0) {
    return {
      status: {
        id: "memoize",
        label: "Memoize",
        detected: false,
        recordCount: 0,
        paths: statusPaths,
        warning: "Memoize SQLite database was not found.",
      },
      records: [],
    };
  }

  const failures: string[] = [];
  for (const path of candidates) {
    try {
      const db = openReadonlyDatabase(path);
      const rows = db
        .prepare(
          `
          SELECT
            m.id AS message_id,
            m.session_id AS session_id,
            m.content_json AS content_json,
            m.created_at AS created_at,
            s.provider_id AS provider_id,
            s.model AS session_model,
            p.path AS project_path
          FROM messages m
          LEFT JOIN sessions s ON s.id = m.session_id
          LEFT JOIN projects p ON p.id = s.project_id
          WHERE m.kind = 'usage'
          ORDER BY m.created_at ASC
          `,
        )
        .all() as MemoizeUsageRow[];
      const records: UsageRecord[] = [];
      for (const row of rows) {
        try {
          const content = JSON.parse(row.content_json) as Record<string, unknown>;
          records.push(
            makeUsageRecord({
              sourceId: "memoize",
              sourceLabel: "Memoize",
              providerId: row.provider_id ?? "memoize",
              model: resolveModel(content.model, row.session_model) ?? "unknown",
              sessionId: row.session_id,
              projectPath: row.project_path,
              workspacePath: row.project_path,
              startedAt: row.created_at,
              endedAt: row.created_at,
              counts: {
                inputTokens: numberFrom(content.inputTokens),
                outputTokens: numberFrom(content.outputTokens),
                cacheReadTokens: numberFrom(content.cacheReadTokens),
                cacheCreationTokens: numberFrom(content.cacheCreationTokens),
                reasoningTokens: numberFrom(content.reasoningTokens),
              },
              provenance: `${path}#messages/${row.message_id}`,
              confidence: "exact",
              fingerprintParts: [row.message_id],
            }),
          );
        } catch {
          // Ignore malformed historical rows; one bad row should not poison the report.
        }
      }
      db.close();
      return {
        status: {
          id: "memoize",
          label: "Memoize",
          detected: true,
          recordCount: records.length,
          paths: candidates,
          // Memoize only records usage for its own native chat sessions. When you
          // drive Claude Code / Codex (directly or via Memoize spawning the CLI),
          // those tokens are logged by the CLIs and counted under their own
          // sources — so a low/zero Memoize count is expected, not missing data.
          warning:
            records.length === 0
              ? "No Memoize-native sessions recorded usage. Claude Code / Codex tokens are counted under their own sources."
              : null,
        },
        records,
      };
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    status: {
      id: "memoize",
      label: "Memoize",
      detected: true,
      recordCount: 0,
      paths: candidates,
      warning: failures.join("; "),
    },
    records: [],
  };
};
