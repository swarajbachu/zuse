import type { ProviderId } from "@zuse/wire";

/**
 * One slash-prefixed command surfaced in the composer popover.
 *
 * `kind` decides what happens when the user picks it:
 *   - `client`  — handled in chat-composer's `dispatchBuiltin` (cleared from
 *                 the doc, no message sent).
 *   - `forward` — message body is sent to the provider as plain user text
 *                 (e.g. `/compact` → the Claude Code SDK interprets it).
 *
 * `appliesTo` filters by provider; `null` means "all providers".
 */
export interface BuiltinCommand {
  readonly name: string;
  readonly description: string;
  readonly kind: "client" | "forward";
  readonly appliesTo: ProviderId | null;
}

export interface ParsedBuiltin {
  readonly command: BuiltinCommand;
  readonly args: string;
}

/**
 * The full list. Client-handled entries (`/clear`, `/new`, `/model`, `/mode`,
 * `/help`) wire up to renderer-side actions. Forward entries surface the
 * provider's CLI commands so users see `/compact`, `/init`, etc. in the same
 * popover; selecting them sends the literal token to the provider as user text.
 */
const COMMANDS: readonly BuiltinCommand[] = [
  // Client-handled.
  {
    name: "clear",
    description: "Clear the composer and the per-session queue.",
    kind: "client",
    appliesTo: null,
  },
  {
    name: "new",
    description: "Start a new session in the current project.",
    kind: "client",
    appliesTo: null,
  },
  {
    name: "model",
    description: "Switch the session model. Usage: /model <id>",
    kind: "client",
    appliesTo: null,
  },
  {
    name: "mode",
    description: "Switch the runtime permission mode. Usage: /mode <name>",
    kind: "client",
    appliesTo: null,
  },
  {
    name: "plan",
    description:
      "Switch into plan mode — agent reads only, ends with ExitPlanMode.",
    kind: "client",
    appliesTo: null,
  },
  {
    name: "run",
    description: "Leave plan mode and resume normal execution.",
    kind: "client",
    appliesTo: null,
  },
  {
    name: "goal",
    description: "Send the next message as a goal.",
    kind: "client",
    appliesTo: "codex",
  },
  {
    name: "goal",
    description: "Send the next message as a goal.",
    kind: "client",
    appliesTo: "grok",
  },
  {
    name: "help",
    description: "List built-in commands and skills.",
    kind: "client",
    appliesTo: null,
  },

  // Claude Code provider commands. Forwarded as user text.
  {
    name: "compact",
    description: "Summarize and compact the conversation history.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "init",
    description: "Initialize CLAUDE.md for this project.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "cost",
    description: "Show token cost for this session.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "agents",
    description: "Manage subagents.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "hooks",
    description: "Manage Claude Code hooks.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "mcp",
    description: "Manage MCP servers.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "permissions",
    description: "Manage tool permissions.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "status",
    description: "Show session status.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "config",
    description: "Show or edit Claude Code config.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "memory",
    description: "Edit memory / CLAUDE.md.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "review",
    description: "Review code on this branch.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "release-notes",
    description: "Show release notes.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "doctor",
    description: "Diagnose installation issues.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "bug",
    description: "File a bug report.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "pr_comments",
    description: "List PR comments.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "ide",
    description: "Connect / disconnect the IDE.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "add-dir",
    description: "Add a working directory.",
    kind: "forward",
    appliesTo: "claude",
  },
  {
    name: "security-review",
    description: "Run a security review on the diff.",
    kind: "forward",
    appliesTo: "claude",
  },

  // Codex provider commands. These are intercepted by the Codex app-server
  // driver; they must remain plain text, not skill chips.
  {
    name: "resume",
    description: "Resume a previous Codex thread.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "fork",
    description: "Fork the active Codex thread.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "quit",
    description: "Close the active Codex thread.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "exit",
    description: "Close the active Codex thread.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "fast",
    description: "Toggle Codex fast mode.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "personality",
    description: "Choose Codex communication style.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "permissions",
    description: "Review Codex approval requirements.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "approval",
    description: "Review Codex approval policy.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "sandbox",
    description: "Switch Codex sandbox policy.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "agent",
    description: "Switch between Codex agent threads.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "mention",
    description: "Mention files or folders.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "copy",
    description: "Copy the latest completed Codex response.",
    kind: "client",
    appliesTo: "codex",
  },
  {
    name: "diff",
    description: "Show the latest Codex turn diff.",
    kind: "client",
    appliesTo: "codex",
  },
  {
    name: "sandbox-add-read-dir",
    description: "Grant Windows sandbox read access.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "mcp",
    description: "List Codex MCP server status.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "apps",
    description: "List Codex app connectors.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "plugins",
    description: "List Codex plugins.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "experimental",
    description: "List Codex experimental features.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "status",
    description: "Show Codex thread status.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "debug-config",
    description: "Show Codex config details.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "tool-log",
    description: "Show the Codex tool translation log path.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "debug-tools",
    description: "Show the Codex tool translation log path.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "statusline",
    description: "Configure statusline fields.",
    kind: "client",
    appliesTo: "codex",
  },
  {
    name: "title",
    description: "Configure terminal title fields.",
    kind: "client",
    appliesTo: "codex",
  },
  {
    name: "ps",
    description: "Check background Codex processes.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "stop",
    description: "Stop background Codex work.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "review",
    description: "Run Codex review on the working tree.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "compact",
    description: "Compact the Codex conversation.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "init",
    description: "Initialize AGENTS.md for this repository.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "feedback",
    description: "Submit Codex diagnostics.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "logout",
    description: "Log out of Codex.",
    kind: "forward",
    appliesTo: "codex",
  },
  {
    name: "theme",
    description: "Change Codex theme settings.",
    kind: "client",
    appliesTo: "codex",
  },
  {
    name: "undo",
    description: "Rollback the last Codex turn.",
    kind: "forward",
    appliesTo: "codex",
  },
];

export const builtinsForProvider = (
  providerId: ProviderId,
): readonly BuiltinCommand[] =>
  COMMANDS.filter((c) => c.appliesTo === null || c.appliesTo === providerId);

/**
 * Detect a leading client-handled built-in (`/clear`, `/model`, etc.).
 * Forward-kind commands (`/compact`, `/init`, …) deliberately return null so
 * submit's normal path forwards them to the provider as plain user text.
 */
export const matchBuiltin = (
  docText: string,
  providerId: ProviderId,
): ParsedBuiltin | null => {
  const trimmed = docText.trim();
  if (!trimmed.startsWith("/")) return null;
  const head = trimmed.split(/\s+/, 1)[0]!;
  const cmd = builtinsForProvider(providerId).find(
    (c) => `/${c.name}` === head && c.kind === "client",
  );
  if (!cmd) return null;
  const args = trimmed.slice(head.length).trim();
  return { command: cmd, args };
};

export const filterBuiltins = (
  query: string,
  providerId: ProviderId,
): readonly BuiltinCommand[] => {
  const list = builtinsForProvider(providerId);
  const q = query.toLowerCase();
  if (!q) return list;
  return list.filter((c) => c.name.toLowerCase().startsWith(q));
};
