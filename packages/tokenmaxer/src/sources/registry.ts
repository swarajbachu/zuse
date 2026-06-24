import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { makeUsageRecord } from "../normalize.ts";
import type { UsageReadOptions, UsageRecord, UsageSourceId, UsageSourceReadResult } from "../types.ts";
import { SOURCE_LABELS } from "./catalog.ts";
import { readAnthropicJsonl } from "./engines/anthropic-jsonl.ts";
import { readCodexJsonl } from "./engines/codex-jsonl.ts";
import {
  collectFiles,
  existingDirectories,
  isDirectory,
  normalizePathList,
  YIELD_EVERY,
  yieldToEventLoop,
} from "./fs-util.ts";
import { openReadonlyDatabase } from "./sqlite.ts";

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const buildStatus = (
  id: UsageSourceId,
  detected: boolean,
  records: ReadonlyArray<UsageRecord>,
  paths: ReadonlyArray<string>,
  warning: string | null = null,
): UsageSourceReadResult["status"] => ({
  id,
  label: SOURCE_LABELS[id],
  detected,
  recordCount: records.length,
  paths,
  warning:
    warning ??
    (detected && records.length === 0
      ? "Detected, but no usage rows were found."
      : null),
});

// ── Claude Code ──────────────────────────────────────────────────────────────
const claudeRoots = (): string[] => {
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  const candidates =
    env != null && env !== ""
      ? normalizePathList(env, [])
      : normalizePathList(undefined, [
          join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "claude"),
          join(homedir(), ".claude"),
        ]);
  return candidates.filter((root) => isDirectory(join(root, "projects")));
};

const readClaude = async (): Promise<UsageSourceReadResult> => {
  const roots = claudeRoots();
  if (roots.length === 0) {
    return { status: buildStatus("claude", false, [], [join(homedir(), ".claude")], "Claude Code data directory was not found."), records: [] };
  }
  const { records, files } = await readAnthropicJsonl({
    sourceId: "claude",
    sourceLabel: SOURCE_LABELS.claude,
    roots,
  });
  return { status: buildStatus("claude", true, records, files), records };
};

// ── Codex ────────────────────────────────────────────────────────────────────
const readCodex = async (): Promise<UsageSourceReadResult> => {
  const homes = normalizePathList(process.env.CODEX_HOME, [join(homedir(), ".codex")]);
  const sessionsDirs = homes.map((home) => join(home, "sessions")).filter(isDirectory);
  if (sessionsDirs.length === 0) {
    return { status: buildStatus("codex", false, [], [join(homedir(), ".codex", "sessions")], "Codex sessions directory was not found."), records: [] };
  }
  const { records, files } = await readCodexJsonl({
    sourceId: "codex",
    sourceLabel: SOURCE_LABELS.codex,
    sessionsDirs,
  });
  return { status: buildStatus("codex", true, records, files), records };
};

// ── OpenCode (storage/message/**/*.json + opencode.db) ───────────────────────
interface OpenCodeMessage {
  id?: string;
  sessionID?: string;
  providerID?: string;
  modelID?: string;
  time?: { created?: number };
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  cost?: number;
}

const openCodeRecord = (message: OpenCodeMessage, provenance: string): UsageRecord | null => {
  const tokens = message.tokens;
  if (tokens === undefined || message.modelID == null || message.providerID == null) return null;
  const counts = {
    inputTokens: num(tokens.input),
    outputTokens: num(tokens.output),
    cacheReadTokens: num(tokens.cache?.read),
    cacheCreationTokens: num(tokens.cache?.write),
    reasoningTokens: num(tokens.reasoning),
  };
  if (counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheCreationTokens + counts.reasoningTokens <= 0) {
    return null;
  }
  return makeUsageRecord({
    sourceId: "opencode",
    sourceLabel: SOURCE_LABELS.opencode,
    providerId: message.providerID,
    model: message.modelID,
    sessionId: message.sessionID ?? null,
    startedAt: typeof message.time?.created === "number" ? message.time.created : undefined,
    counts,
    loggedCostUsd: typeof message.cost === "number" ? message.cost : null,
    provenance,
    confidence: "exact",
    fingerprintParts: [message.id ?? provenance],
  });
};

const readOpenCode = async (): Promise<UsageSourceReadResult> => {
  const roots = existingDirectories(
    normalizePathList(process.env.OPENCODE_DATA_DIR, [join(homedir(), ".local", "share", "opencode")]),
  );
  if (roots.length === 0) {
    return { status: buildStatus("opencode", false, [], [join(homedir(), ".local", "share", "opencode")], "OpenCode data directory was not found."), records: [] };
  }
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  const paths: string[] = [];
  let processed = 0;
  for (const root of roots) {
    const dbPath = join(root, "opencode.db");
    if (existsSync(dbPath)) {
      paths.push(dbPath);
      try {
        const db = openReadonlyDatabase(dbPath);
        const rows = db.prepare("SELECT id, session_id, data FROM message").all() as Array<{
          id: string;
          session_id: string;
          data: string;
        }>;
        for (const row of rows) {
          if (seen.has(row.id)) continue;
          try {
            const data = JSON.parse(row.data) as OpenCodeMessage;
            const record = openCodeRecord({ ...data, id: row.id, sessionID: data.sessionID ?? row.session_id }, `${dbPath}#${row.id}`);
            if (record !== null) {
              seen.add(row.id);
              records.push(record);
            }
          } catch {
            // skip malformed row
          }
        }
        db.close();
      } catch {
        // DB unreadable; fall through to JSON files
      }
    }
    const files = collectFiles(join(root, "storage", "message"), ".json");
    paths.push(...files);
    for (const file of files) {
      if (++processed % YIELD_EVERY === 0) await yieldToEventLoop();
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as OpenCodeMessage;
        const id = data.id ?? file;
        if (seen.has(id)) continue;
        const record = openCodeRecord(data, file);
        if (record !== null) {
          seen.add(id);
          records.push(record);
        }
      } catch {
        // skip malformed file
      }
    }
  }
  return { status: buildStatus("opencode", true, records, paths), records };
};

// ── Amp (threads/**/*.json) ──────────────────────────────────────────────────
interface AmpThread {
  id?: string;
  messages?: Array<{ role?: string; messageId?: number; usage?: { cacheCreationInputTokens?: number; cacheReadInputTokens?: number } }>;
  usageLedger?: { events?: Array<{ timestamp?: string; model?: string; tokens?: { input?: number; output?: number }; toMessageId?: number }> };
}

const readAmp = async (): Promise<UsageSourceReadResult> => {
  const roots = existingDirectories(
    normalizePathList(process.env.AMP_DATA_DIR, [join(homedir(), ".local", "share", "amp")]),
  );
  if (roots.length === 0) {
    return { status: buildStatus("amp", false, [], [join(homedir(), ".local", "share", "amp")], "Amp data directory was not found."), records: [] };
  }
  const records: UsageRecord[] = [];
  const files = roots.flatMap((root) => collectFiles(join(root, "threads"), ".json"));
  let processed = 0;
  for (const file of files) {
    if (++processed % YIELD_EVERY === 0) await yieldToEventLoop();
    let thread: AmpThread;
    try {
      thread = JSON.parse(readFileSync(file, "utf8")) as AmpThread;
    } catch {
      continue;
    }
    for (const event of thread.usageLedger?.events ?? []) {
      const assistant = thread.messages?.find((m) => m.role === "assistant" && m.messageId === event.toMessageId);
      records.push(
        makeUsageRecord({
          sourceId: "amp",
          sourceLabel: SOURCE_LABELS.amp,
          providerId: "amp",
          model: event.model ?? null,
          sessionId: thread.id ?? null,
          startedAt: event.timestamp,
          counts: {
            inputTokens: num(event.tokens?.input),
            outputTokens: num(event.tokens?.output),
            cacheReadTokens: num(assistant?.usage?.cacheReadInputTokens),
            cacheCreationTokens: num(assistant?.usage?.cacheCreationInputTokens),
            reasoningTokens: 0,
          },
          provenance: file,
          confidence: "exact",
          fingerprintParts: [thread.id ?? file, event.timestamp ?? "", String(event.toMessageId ?? "")],
        }),
      );
    }
  }
  return { status: buildStatus("amp", true, records, files), records };
};

// ── pi-agent (sessions/**/*.jsonl) ───────────────────────────────────────────
const readPi = async (): Promise<UsageSourceReadResult> => {
  const envDir = process.env.PI_AGENT_DIR?.trim();
  const roots = existingDirectories(
    envDir != null && envDir !== ""
      ? normalizePathList(envDir, [])
      : [join(homedir(), ".pi", "agent", "sessions")],
  );
  if (roots.length === 0) {
    return { status: buildStatus("pi", false, [], [join(homedir(), ".pi", "agent", "sessions")], "pi-agent sessions directory was not found."), records: [] };
  }
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  const files = roots.flatMap((root) => collectFiles(root, ".jsonl"));
  let processed = 0;
  for (const file of files) {
    if (++processed % YIELD_EVERY === 0) await yieldToEventLoop();
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const segments = file.split(/[/\\]/);
    const sessionsIndex = segments.lastIndexOf("sessions");
    const project = sessionsIndex !== -1 ? segments[sessionsIndex + 1] ?? "unknown" : "unknown";
    const base = segments[segments.length - 1]!.replace(/\.jsonl$/i, "");
    const underscore = base.indexOf("_");
    const sessionId = underscore === -1 ? base : base.slice(underscore + 1);
    for (const line of text.split("\n")) {
      if (!line.includes('"usage"') || !line.includes('"message"')) continue;
      let parsed: { timestamp?: string; message?: { role?: string; model?: string; usage?: Record<string, unknown> } };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = parsed.message?.usage;
      if (parsed.message?.role !== "assistant" || usage === undefined || typeof usage.input !== "number" || typeof usage.output !== "number") {
        continue;
      }
      const cacheCreation = num(usage.cacheWrite);
      const cacheRead = num(usage.cacheRead);
      const cost = (usage.cost as { total?: number } | undefined)?.total;
      const key = `${project}:${sessionId}:${parsed.timestamp}:${num(usage.input)}:${num(usage.output)}:${cacheRead}:${cacheCreation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(
        makeUsageRecord({
          sourceId: "pi",
          sourceLabel: SOURCE_LABELS.pi,
          providerId: "pi",
          model: str(parsed.message.model),
          sessionId,
          projectPath: project,
          startedAt: parsed.timestamp,
          counts: {
            inputTokens: num(usage.input),
            outputTokens: num(usage.output),
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheCreation,
            reasoningTokens: 0,
          },
          loggedCostUsd: typeof cost === "number" ? cost : null,
          provenance: file,
          confidence: "exact",
          fingerprintParts: [key],
        }),
      );
    }
  }
  return { status: buildStatus("pi", true, records, files), records };
};

// ── Grok ─────────────────────────────────────────────────────────────────────
// Grok ("grok build") does not log per-turn input/output token counts. The only
// usage signal it persists is an aggregate `tokens_used` on `subagent_finished`
// events inside each session's `updates.jsonl`. We surface those as best-effort
// total-token rows (no input/output split, so the aggregate is recorded as input
// and cost is left unknown — `grok-build` is an agent name, not a priced model).
interface GrokSummary {
  info?: { cwd?: string };
  current_model_id?: string;
  created_at?: string;
}

const readGrok = async (): Promise<UsageSourceReadResult> => {
  const root = join(homedir(), ".grok");
  const sessionsDir = join(root, "sessions");
  if (!isDirectory(sessionsDir)) {
    return { status: buildStatus("grok", false, [], [root], "Grok data directory was not found."), records: [] };
  }

  const files = collectFiles(sessionsDir, "updates.jsonl");
  const records: UsageRecord[] = [];
  let processed = 0;
  for (const file of files) {
    if (++processed % YIELD_EVERY === 0) await yieldToEventLoop();
    const dir = file.slice(0, file.length - "/updates.jsonl".length);
    let summary: GrokSummary = {};
    try {
      summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as GrokSummary;
    } catch {
      // No summary — fall back to the URL-encoded cwd in the session path.
    }
    const cwd = summary.info?.cwd ?? decodeGrokCwd(dir);
    const model = str(summary.current_model_id) ?? "grok-build";

    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"tokens_used"')) continue;
      let entry: { timestamp?: string; params?: { sessionId?: string; update?: Record<string, unknown> } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const update = entry.params?.update;
      if (update?.sessionUpdate !== "subagent_finished") continue;
      const tokens = num(update.tokens_used);
      if (tokens <= 0) continue;
      const childId = str(update.child_session_id) ?? str(update.subagent_id) ?? "";
      records.push(
        makeUsageRecord({
          sourceId: "grok",
          sourceLabel: SOURCE_LABELS.grok,
          providerId: "grok",
          model,
          sessionId: str(entry.params?.sessionId),
          projectPath: cwd,
          workspacePath: cwd,
          startedAt: str(entry.timestamp) ?? summary.created_at,
          counts: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 },
          provenance: `${file}#${childId}`,
          confidence: "estimated",
          fingerprintParts: [childId, String(tokens)],
        }),
      );
    }
  }

  const warning =
    records.length === 0
      ? "Grok does not expose per-token usage logs."
      : "Undercounted: Grok only logs tokens for finished subagents — main-agent turns are not recorded on disk, so the real total is higher.";
  return { status: buildStatus("grok", true, records, files, warning), records };
};

/** Grok session dirs are named after the URL-encoded cwd, e.g. `%2FUsers%2F…`. */
const decodeGrokCwd = (dir: string): string | null => {
  const encoded = dir.split("/").find((segment) => segment.includes("%2F"));
  if (encoded === undefined) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
};

const READERS: Record<UsageSourceId, () => Promise<UsageSourceReadResult>> = {
  memoize: () => {
    throw new Error("memoize is read separately");
  },
  claude: readClaude,
  codex: readCodex,
  opencode: readOpenCode,
  amp: readAmp,
  pi: readPi,
  grok: readGrok,
};

export const readExternalSource = (
  sourceId: Exclude<UsageSourceId, "memoize">,
  _options?: UsageReadOptions,
): Promise<UsageSourceReadResult> => READERS[sourceId]();
