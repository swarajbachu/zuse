import type { UsageSourceId } from "../types.ts";

export const SOURCE_LABELS: Record<UsageSourceId, string> = {
  memoize: "Memoize",
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  amp: "Amp",
  pi: "pi-agent",
  grok: "Grok",
};

/** Every source id in a stable display order. */
export const ALL_SOURCE_IDS: ReadonlyArray<UsageSourceId> = [
  "memoize",
  "claude",
  "codex",
  "opencode",
  "amp",
  "pi",
  "grok",
];

/** Non-Memoize agent CLIs (Memoize is read from its own SQLite database). */
export const EXTERNAL_SOURCE_IDS: ReadonlyArray<UsageSourceId> = [
  "claude",
  "codex",
  "opencode",
  "amp",
  "pi",
  "grok",
];
