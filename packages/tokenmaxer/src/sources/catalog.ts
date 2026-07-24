import type { UsageSourceId } from "../types.ts";

export const SOURCE_LABELS: Record<UsageSourceId, string> = {
  zuse: "Zuse (Beta)",
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
  "zuse",
  "claude",
  "codex",
  "opencode",
  "amp",
  "pi",
  "grok",
];

/** Non-Zuse agent CLIs (Zuse is read from its own SQLite database). */
export const EXTERNAL_SOURCE_IDS: ReadonlyArray<
  Exclude<UsageSourceId, "zuse" | "memoize">
> = [
  "claude",
  "codex",
  "opencode",
  "amp",
  "pi",
  "grok",
];
