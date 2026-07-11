import type { Message } from "@zuse/contracts";

export type ToolActivityKind =
  | "command"
  | "read"
  | "write"
  | "search"
  | "list"
  | "load"
  | "other";

const COMMAND_TOOLS = new Set([
  "Bash",
  "Shell",
  "shell",
  "Terminal",
  "Execute",
  "execute",
  "Run",
  "run",
  "exec_command",
  "run_shell_command",
  "run_terminal_cmd",
  "run_terminal_command",
]);
const READ_TOOLS = new Set(["Read", "view_image", "read_mcp_resource"]);
const WRITE_TOOLS = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "apply_patch",
  "imagegen",
]);
const SEARCH_TOOLS = new Set(["Grep", "WebSearch", "WebFetch", "search"]);
const LIST_TOOLS = new Set(["Glob", "List", "list_dir", "find"]);

export const classifyToolActivity = (tool: string): ToolActivityKind => {
  const base = tool.includes("__") ? (tool.split("__").at(-1) ?? tool) : tool;
  if (COMMAND_TOOLS.has(base)) return "command";
  const normalized = base.toLowerCase().replace(/[\s-]+/g, "_");
  if (
    normalized.includes("terminal") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized === "bash"
  ) {
    return "command";
  }
  if (READ_TOOLS.has(base)) return "read";
  if (WRITE_TOOLS.has(base)) return "write";
  if (SEARCH_TOOLS.has(base)) return "search";
  if (LIST_TOOLS.has(base)) return "list";
  if (base === "Skill" || base === "ToolSearch" || base === "tool_search") {
    return "load";
  }
  return "other";
};

const PENDING_LABEL: Record<ToolActivityKind, string> = {
  command: "Running commands…",
  read: "Reading files…",
  write: "Writing files…",
  search: "Searching…",
  list: "Listing files…",
  load: "Loading a tool…",
  other: "Using a tool…",
};

const SETTLED_LABEL: Record<ToolActivityKind, [string, string]> = {
  command: ["Ran a command", "Ran commands"],
  read: ["Read a file", "Read files"],
  write: ["Wrote a file", "Wrote files"],
  search: ["Searched", "Searched"],
  list: ["Listed files", "Listed files"],
  load: ["Loaded a tool", "Loaded tools"],
  other: ["Used a tool", "Used tools"],
};

export interface ToolActivitySummary {
  readonly label: string;
  readonly pending: boolean;
  readonly count: number;
  readonly hasError: boolean;
}

export const countTurnProgressMessages = (
  messages: ReadonlyArray<Message>,
): number =>
  messages.filter(
    (message) =>
      message.content._tag === "assistant" ||
      message.content._tag === "thinking",
  ).length;

export const summarizeToolActivity = (
  messages: ReadonlyArray<Message>,
  live = false,
): ToolActivitySummary => {
  const uses = messages.filter(
    (message) => message.content._tag === "tool_use",
  );
  const results = new Map(
    messages.flatMap((message) =>
      message.content._tag === "tool_result"
        ? [[message.content.itemId, message.content] as const]
        : [],
    ),
  );
  const pendingUses = uses.filter(
    (message) =>
      message.content._tag === "tool_use" &&
      !results.has(message.content.itemId),
  );
  const latestPending = pendingUses.at(-1);
  const pendingKind =
    latestPending?.content._tag === "tool_use"
      ? classifyToolActivity(latestPending.content.tool)
      : null;

  if (live && messages.at(-1)?.content._tag === "thinking") {
    return {
      label: "Thinking…",
      pending: true,
      count: uses.length,
      hasError: false,
    };
  }

  if (pendingKind !== null) {
    return {
      label: PENDING_LABEL[pendingKind],
      pending: true,
      count: uses.length,
      hasError: false,
    };
  }

  const messageCount = messages.filter(
    (message) => message.content._tag === "thinking",
  ).length;
  if (uses.length === 0 && messageCount > 0) {
    return {
      label: "Thinking",
      pending: false,
      count: 0,
      hasError: false,
    };
  }

  const ordered: Array<{ kind: ToolActivityKind; count: number }> = [];
  for (const use of uses) {
    if (use.content._tag !== "tool_use") continue;
    const kind = classifyToolActivity(use.content.tool);
    const existing = ordered.find((entry) => entry.kind === kind);
    if (existing === undefined) ordered.push({ kind, count: 1 });
    else existing.count += 1;
  }

  return {
    label: ordered
      .map(({ kind, count }) => SETTLED_LABEL[kind][count === 1 ? 0 : 1])
      .join(", "),
    pending: false,
    count: uses.length,
    hasError: Array.from(results.values()).some((result) => result.isError),
  };
};

export const isToolActivityMessage = (message: Message): boolean =>
  message.content._tag === "thinking" ||
  message.content._tag === "tool_use" ||
  message.content._tag === "tool_result";
