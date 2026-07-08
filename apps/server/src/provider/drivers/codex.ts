import { Effect, Mailbox, Stream } from "effect";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  AgentSessionStartError,
  resolveModelSlug,
  type AgentEvent,
  type AgentItemId,
  type AgentSessionId,
  type AttachmentRef,
  type FileRef,
  type PermissionDecision,
  type PermissionKind,
  type PermissionMode,
  type RuntimeMode,
  type SkillRef,
  type StartSessionInput,
  ThreadGoal,
  type ThreadGoalSetInput,
  type ThreadGoalStatus,
  type UserQuestionAnswer,
} from "@zuse/wire";

import { AttachmentService } from "../../attachment/services/attachment-service.ts";
import { applyPlanModePrefix } from "./planMode.ts";
import { CodexAppServerClient } from "../codex-app-server-client.ts";
import { startOrchestrationMcpBridge } from "./acp/orchestration-mcp-bridge.ts";
import {
  finishCompactEvent,
  nextCompactItemId,
  startCompactEvent,
  startCompactSnapshot,
  type CompactSnapshot,
} from "./compact.ts";
import type { ServerNotification } from "../codex-app-protocol/ServerNotification";
import type { ServerRequest } from "../codex-app-protocol/ServerRequest";
import type { SandboxPolicy } from "../codex-app-protocol/v2/SandboxPolicy";
import type { Model } from "../codex-app-protocol/v2/Model";
import type { ModelListResponse } from "../codex-app-protocol/v2/ModelListResponse";
import type { ThreadGoal as CodexThreadGoal } from "../codex-app-protocol/v2/ThreadGoal";
import type { ThreadItem } from "../codex-app-protocol/v2/ThreadItem";
import type { UserInput } from "../codex-app-protocol/v2/UserInput";
import {
  ORCHESTRATION_MCP_SERVER_NAME,
  orchestrationMcpPromptHint,
  type OrchestrationSessionTools,
} from "./orchestration-tools.ts";

const SUPPORTED_CODEX_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export type RequestPermission = (
  sessionId: AgentSessionId,
  kind: PermissionKind,
  options: { readonly forcePrompt: boolean },
) => Promise<PermissionDecision>;

const toSandboxMode = (
  mode: PermissionMode,
): "read-only" | "workspace-write" =>
  mode === "plan" ? "read-only" : "workspace-write";

const dedupe = (paths: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(paths),
];

const gitRevParsePaths = (
  cwd: string,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  try {
    return execFileSync("git", ["rev-parse", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
};

export const codexWritableRootsForCwd = (
  cwd: string,
): ReadonlyArray<string> => {
  const gitPaths = gitRevParsePaths(cwd, [
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]);
  const fallbackGitPaths =
    gitPaths.length > 0
      ? []
      : gitRevParsePaths(cwd, ["--git-dir", "--git-common-dir"]);
  return dedupe([
    cwd,
    ...gitPaths,
    ...fallbackGitPaths.map((path) =>
      isAbsolute(path) ? path : resolve(cwd, path),
    ),
  ]);
};

const toSandboxPolicy = (mode: PermissionMode, cwd: string): SandboxPolicy =>
  mode === "plan"
    ? { type: "readOnly", networkAccess: false }
    : {
        type: "workspaceWrite",
        writableRoots: [...codexWritableRootsForCwd(cwd)],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };

export interface CodexSessionHandle {
  readonly events: Stream.Stream<AgentEvent>;
  readonly send: (
    text: string,
    attachments?: ReadonlyArray<AttachmentRef>,
    fileRefs?: ReadonlyArray<FileRef>,
    skillRefs?: ReadonlyArray<SkillRef>,
  ) => Effect.Effect<void>;
  readonly interrupt: () => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Effect.Effect<void>;
  readonly answerQuestion: (
    itemId: AgentItemId,
    answers: ReadonlyArray<UserQuestionAnswer>,
  ) => Effect.Effect<void>;
  readonly getGoal: () => Effect.Effect<ThreadGoal | null>;
  readonly setGoal: (goal: ThreadGoalSetInput) => Effect.Effect<ThreadGoal>;
  readonly clearGoal: () => Effect.Effect<void>;
}

let itemCounter = 0;
const nextItemId = (): AgentItemId =>
  `i_${Date.now()}_${++itemCounter}` as AgentItemId;

const firstLine = (text: string): string => text.split("\n", 1)[0] ?? "";

const asText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const normalizeGoalStatus = (status: string): ThreadGoalStatus => {
  switch (status) {
    case "active":
    case "paused":
    case "budgetLimited":
    case "usageLimited":
    case "blocked":
    case "complete":
      return status;
    case "budget_limited":
      return "budgetLimited";
    case "usage_limited":
      return "usageLimited";
    default:
      return "blocked";
  }
};

const normalizeThreadGoal = (goal: CodexThreadGoal | ThreadGoal): ThreadGoal =>
  ThreadGoal.make({
    threadId: goal.threadId,
    objective: goal.objective,
    status: normalizeGoalStatus(goal.status),
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  });

const goalFromResponse = (value: unknown): CodexThreadGoal | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nested = record["goal"];
  if (nested === null) return null;
  if (nested !== undefined && typeof nested === "object") {
    return nested as CodexThreadGoal;
  }
  return value as CodexThreadGoal;
};

/**
 * Whether a model advertises a "fast" service tier. Codex exposes speed tiers
 * via `serviceTiers` (current) and `additionalSpeedTiers` (deprecated); we
 * match either id/name containing "fast" so we stay robust to label changes.
 */
const modelAdvertisesFastTier = (model: Model): boolean =>
  [
    ...model.serviceTiers.flatMap((tier) => [tier.id, tier.name]),
    ...model.additionalSpeedTiers,
  ].some((label) => label.toLowerCase().includes("fast"));

/**
 * Whether the model a session resolved to advertises a fast service tier,
 * from the live `model/list`. Returns `null` when the model isn't in the
 * catalog (unknown — caller should trust the pre-session FE gate rather than
 * block). The version floor + static model catalog gate the FE *control*; this
 * is the authoritative per-model confirmation enforced at turn time.
 */
const probeModelFastTier = async (
  app: CodexAppServerClient,
  activeModel: string | null,
): Promise<boolean | null> => {
  const response = await app.request<ModelListResponse>("model/list", {
    includeHidden: true,
  });
  const model =
    response.data.find(
      (entry) => entry.id === activeModel || entry.model === activeModel,
    ) ?? response.data.find((entry) => entry.isDefault);
  return model === undefined ? null : modelAdvertisesFastTier(model);
};

const toolIdentifierPart = (value: string): string =>
  value.replace(/[^A-Za-z0-9_]/g, "_");

const normalizeMcpServerName = (server: string): string =>
  server === "memoize" ? "zuse" : server;

const toMcpToolName = (server: string, tool: string): string =>
  `mcp__${toolIdentifierPart(normalizeMcpServerName(server))}__${toolIdentifierPart(tool)}`;

const dynamicToolName = (namespace: string | null, tool: string): string =>
  namespace !== null ? `${namespace}.${tool}` : tool;

const niceToolLabel = (raw: string): string =>
  raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.\/]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ") || "Tool";

const firstTextBlock = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record["text"] === "string") {
      parts.push(record["text"] as string);
      continue;
    }
    const inner = record["content"];
    if (inner !== null && typeof inner === "object") {
      const text = (inner as Record<string, unknown>)["text"];
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
};

const dynamicOutputText = (items: unknown): unknown => {
  if (!Array.isArray(items)) return items ?? null;
  const text = items
    .map((item) =>
      item !== null &&
      typeof item === "object" &&
      (item as Record<string, unknown>)["type"] === "inputText" &&
      typeof (item as Record<string, unknown>)["text"] === "string"
        ? ((item as Record<string, unknown>)["text"] as string)
        : null,
    )
    .filter((item): item is string => item !== null)
    .join("");
  return text.length > 0 ? text : items;
};

const webSearchQueryFromAction = (
  item: Extract<ThreadItem, { type: "webSearch" }>,
): string => {
  const action = item.action;
  if (action?.type === "search") {
    return (
      action.query ?? action.queries?.filter(Boolean).join(", ") ?? item.query
    );
  }
  if (action?.type === "openPage") return action.url ?? item.query;
  if (action?.type === "findInPage")
    return action.pattern ?? action.url ?? item.query;
  return item.query;
};

const codexCommandToolUse = (
  item: Extract<ThreadItem, { type: "commandExecution" }>,
): Extract<AgentEvent, { _tag: "ToolUse" }> => {
  const action =
    item.commandActions.length === 1 ? item.commandActions[0] : null;
  if (action?.type === "read") {
    return {
      _tag: "ToolUse",
      itemId: item.id as AgentItemId,
      tool: "Read",
      input: { file_path: action.path },
    };
  }
  if (action?.type === "listFiles") {
    return {
      _tag: "ToolUse",
      itemId: item.id as AgentItemId,
      tool: "ListDir",
      input: { path: action.path ?? item.cwd },
    };
  }
  if (action?.type === "search") {
    const input: Record<string, unknown> = {
      pattern: action.query ?? action.command,
    };
    if (action.path !== null) input["path"] = action.path;
    return {
      _tag: "ToolUse",
      itemId: item.id as AgentItemId,
      tool: "Grep",
      input,
    };
  }
  return {
    _tag: "ToolUse",
    itemId: item.id as AgentItemId,
    tool: "Bash",
    input: {
      command: item.command,
      cwd: item.cwd,
      description: firstLine(item.command),
    },
  };
};

const codexCommandResultOutput = (
  item: Extract<ThreadItem, { type: "commandExecution" }>,
): string => {
  const output = item.aggregatedOutput ?? "";
  if (output.length > 0 || item.exitCode === 0 || item.exitCode === null) {
    return output;
  }
  return `Command exited with code ${item.exitCode}.`;
};

const codexFileChangeInput = (
  item: Extract<ThreadItem, { type: "fileChange" }>,
): { tool: "Edit" | "MultiEdit"; input: Record<string, unknown> } => {
  const patches = item.changes.map((change) => ({
    file_path: change.path,
    kind: change.kind.type,
    patch: change.diff,
    move_path:
      change.kind.type === "update" ? change.kind.move_path : undefined,
  }));
  if (patches.length === 1) {
    const patch = patches[0]!;
    return {
      tool: "Edit",
      input: {
        file_path: patch.file_path,
        kind: patch.kind,
        patch: patch.patch,
        ...(patch.move_path !== undefined
          ? { move_path: patch.move_path }
          : {}),
      },
    };
  }
  return {
    tool: "MultiEdit",
    input: {
      patches,
    },
  };
};

const normalizeDynamicToolUse = (
  item: Extract<ThreadItem, { type: "dynamicToolCall" }>,
): { tool: string; input: unknown } => {
  const rawName = dynamicToolName(item.namespace, item.tool);
  const input = asRecord(item.arguments);
  switch (rawName) {
    case "functions.exec_command":
    case "exec_command": {
      const command = asString(input["cmd"]) ?? asString(input["command"]);
      if (command !== null) {
        return {
          tool: "Bash",
          input: {
            command,
            ...(asString(input["workdir"]) !== null
              ? { cwd: asString(input["workdir"]) }
              : {}),
          },
        };
      }
      break;
    }
    case "functions.apply_patch":
    case "apply_patch": {
      return {
        tool: "Edit",
        input: { file_path: "(patch)", patch: item.arguments },
      };
    }
    case "web.run": {
      const searches = Array.isArray(input["search_query"])
        ? (input["search_query"] as unknown[])
        : Array.isArray(input["image_query"])
          ? (input["image_query"] as unknown[])
          : [];
      const first = searches[0];
      const query =
        first !== null && typeof first === "object"
          ? asString((first as Record<string, unknown>)["q"])
          : null;
      if (query !== null) return { tool: "WebSearch", input: { query } };
      break;
    }
  }
  return { tool: niceToolLabel(rawName), input: item.arguments };
};

const decisionToCodex = (
  decision: PermissionDecision,
): "accept" | "acceptForSession" | "decline" =>
  decision._tag === "AllowForSession" || decision._tag === "AlwaysAllow"
    ? "acceptForSession"
    : decision._tag === "AllowOnce"
      ? "accept"
      : "decline";

const codexResetDate = (value: number | null): string | null => {
  if (value === null || !Number.isFinite(value)) return null;
  return new Date(
    value > 1_000_000_000_000 ? value : value * 1000,
  ).toISOString();
};

const codexLimitLabel = (value: string | null): string =>
  value !== null && value.trim().length > 0 ? value.trim() : "Codex usage";

const codexWindowLimitLabel = (
  windowMinutes: number | null,
  fallback: string | null,
): string => {
  if (windowMinutes !== null && Number.isFinite(windowMinutes)) {
    if (windowMinutes % (60 * 24) === 0) {
      return `${windowMinutes / (60 * 24)}d limit`;
    }
    if (windowMinutes % 60 === 0) {
      return `${windowMinutes / 60}h limit`;
    }
    return `${windowMinutes}m limit`;
  }
  return codexLimitLabel(fallback);
};

interface CodexToolTranslationLogger {
  readonly path: string;
  readonly append: (
    phase: "started" | "completed",
    item: ThreadItem,
    events: ReadonlyArray<AgentEvent>,
  ) => void;
}

const createCodexToolTranslationLogger = (
  cwd: string,
  sessionId: AgentSessionId,
): CodexToolTranslationLogger => {
  const dir = join(cwd, ".context");
  const path = join(dir, `codex-tools.${sessionId}.ndjson`);
  const safeJson = (value: unknown): string => {
    try {
      return JSON.stringify(value);
    } catch {
      return JSON.stringify("(unserializable)");
    }
  };
  return {
    path,
    append: (phase, item, events) => {
      if (
        events.length === 0 ||
        (item.type !== "commandExecution" &&
          item.type !== "fileChange" &&
          item.type !== "mcpToolCall" &&
          item.type !== "dynamicToolCall" &&
          item.type !== "webSearch")
      ) {
        return;
      }
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(
          path,
          `${safeJson({
            ts: new Date().toISOString(),
            provider: "codex",
            phase,
            itemType: item.type,
            itemId: "id" in item ? item.id : null,
            raw: item,
            events,
          })}\n`,
        );
      } catch {
        // Best-effort debug log: never disrupt the agent loop.
      }
    },
  };
};

interface CodexStatusLogger {
  readonly path: string;
  readonly append: (
    notification: ServerNotification,
    events: ReadonlyArray<AgentEvent>,
  ) => void;
}

const createCodexStatusLogger = (
  cwd: string,
  sessionId: AgentSessionId,
): CodexStatusLogger => {
  const dir = join(cwd, ".context");
  const path = join(dir, `codex-status.${sessionId}.ndjson`);
  const safeJson = (value: unknown): string => {
    try {
      return JSON.stringify(value);
    } catch {
      return JSON.stringify("(unserializable)");
    }
  };
  const statusPayload = (notification: ServerNotification): unknown => {
    switch (notification.method) {
      case "thread/tokenUsage/updated":
        return {
          threadId: notification.params.threadId,
          turnId: notification.params.turnId,
          tokenUsage: {
            total: notification.params.tokenUsage.total,
            last: notification.params.tokenUsage.last,
            modelContextWindow:
              notification.params.tokenUsage.modelContextWindow,
          },
        };
      case "account/rateLimits/updated":
        return { rateLimits: notification.params.rateLimits };
      case "thread/compacted":
        return notification.params;
      case "item/completed":
        return notification.params.item.type === "contextCompaction"
          ? {
              threadId: notification.params.threadId,
              turnId: notification.params.turnId,
              item: notification.params.item,
            }
          : null;
      default:
        return null;
    }
  };
  return {
    path,
    append: (notification, events) => {
      const payload = statusPayload(notification);
      if (payload === null) return;
      const translated = events.filter(
        (event) =>
          event._tag === "ContextUsage" ||
          event._tag === "UsageLimit" ||
          event._tag === "ContextCompaction",
      );
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(
          path,
          `${safeJson({
            ts: new Date().toISOString(),
            provider: "codex",
            method: notification.method,
            raw: payload,
            translated,
          })}\n`,
        );
      } catch {
        // Best-effort debug log: never disrupt the agent loop.
      }
    },
  };
};

export const translateCodexItem = (
  item: ThreadItem,
  phase: "started" | "completed",
  contextCompaction?: CompactSnapshot & {
    readonly afterTokens: number | null;
    readonly durationMs?: number;
  },
): ReadonlyArray<AgentEvent> => {
  switch (item.type) {
    case "agentMessage":
      if (phase !== "completed") return [];
      return [
        { _tag: "AssistantMessage", itemId: nextItemId(), text: item.text },
      ];
    case "plan":
      if (phase !== "completed") return [];
      return [
        { _tag: "AssistantMessage", itemId: nextItemId(), text: item.text },
      ];
    case "reasoning": {
      if (phase !== "completed") return [];
      const text = [...item.summary, ...item.content].join("\n").trim();
      return text.length === 0
        ? []
        : [{ _tag: "Thinking", itemId: nextItemId(), text, redacted: false }];
    }
    case "commandExecution":
      if (phase === "started") {
        return [codexCommandToolUse(item)];
      }
      return [
        {
          _tag: "ToolResult",
          itemId: item.id as AgentItemId,
          output: codexCommandResultOutput(item),
          isError: item.status === "failed",
        },
      ];
    case "fileChange":
      if (phase !== "completed") return [];
      const fileChange = codexFileChangeInput(item);
      return [
        {
          _tag: "ToolUse",
          itemId: item.id as AgentItemId,
          tool: fileChange.tool,
          input: fileChange.input,
        },
        {
          _tag: "ToolResult",
          itemId: item.id as AgentItemId,
          output:
            item.status === "completed"
              ? `Applied ${item.changes.length} file change${item.changes.length === 1 ? "" : "s"}.`
              : { changes: item.changes, status: item.status },
          isError: item.status === "failed",
        },
      ];
    case "mcpToolCall":
      if (phase === "started") {
        return [
          {
            _tag: "ToolUse",
            itemId: item.id as AgentItemId,
            tool: toMcpToolName(item.server, item.tool),
            input: item.arguments,
          },
        ];
      }
      return [
        {
          _tag: "ToolResult",
          itemId: item.id as AgentItemId,
          output:
            item.result !== null
              ? (firstTextBlock(item.result.content) ?? item.result.content)
              : (item.error ?? null),
          isError: item.status === "failed",
        },
      ];
    case "dynamicToolCall":
      if (phase === "started") {
        const toolUse = normalizeDynamicToolUse(item);
        return [
          {
            _tag: "ToolUse",
            itemId: item.id as AgentItemId,
            tool: toolUse.tool,
            input: toolUse.input,
          },
        ];
      }
      return [
        {
          _tag: "ToolResult",
          itemId: item.id as AgentItemId,
          output: dynamicOutputText(item.contentItems),
          isError: item.success === false,
        },
      ];
    case "webSearch":
      if (phase !== "completed") return [];
      // Use the Claude-canonical "WebSearch" tool name so the renderer's
      // tool-row switch picks up the globe icon + result rendering.
      // `query` is the canonical input key per the wire contract.
      return [
        {
          _tag: "ToolUse",
          itemId: item.id as AgentItemId,
          tool: "WebSearch",
          input: { query: webSearchQueryFromAction(item), action: item.action },
        },
      ];
    case "enteredReviewMode":
    case "exitedReviewMode":
      if (phase !== "completed") return [];
      return [
        {
          _tag: "AssistantMessage",
          itemId: item.id as AgentItemId,
          text:
            item.type === "enteredReviewMode"
              ? `Entered review mode: ${item.review}`
              : `Exited review mode: ${item.review}`,
        },
      ];
    case "contextCompaction":
      if (phase !== "completed") return [];
      {
        return [
          finishCompactEvent({
            itemId: contextCompaction?.itemId ?? (item.id as AgentItemId),
            providerId: "codex",
            snapshot: contextCompaction ?? null,
            afterTokens: contextCompaction?.afterTokens ?? null,
            durationMs: contextCompaction?.durationMs,
          }),
        ];
      }
    default:
      return [];
  }
};

export const translateCodexStatusNotification = (
  notification: ServerNotification,
  activeThreadId: string | null,
): ReadonlyArray<AgentEvent> | null => {
  switch (notification.method) {
    case "thread/tokenUsage/updated":
      if (notification.params.threadId !== activeThreadId) return [];
      return [
        {
          _tag: "ContextUsage",
          providerId: "codex",
          usedTokens: notification.params.tokenUsage.last.totalTokens,
          windowTokens:
            notification.params.tokenUsage.modelContextWindow ?? null,
          precision: "exact",
          source: "Codex app-server",
        },
      ];
    case "account/rateLimits/updated": {
      const limits = notification.params.rateLimits;
      const out: AgentEvent[] = [];
      if (limits.primary !== null) {
        out.push({
          _tag: "UsageLimit",
          providerId: "codex",
          label: codexWindowLimitLabel(
            limits.primary.windowDurationMins,
            limits.limitName,
          ),
          usedPercent: limits.primary.usedPercent,
          resetsAt: codexResetDate(limits.primary.resetsAt),
          windowMinutes: limits.primary.windowDurationMins,
        });
      }
      if (limits.secondary !== null) {
        out.push({
          _tag: "UsageLimit",
          providerId: "codex",
          label: codexWindowLimitLabel(
            limits.secondary.windowDurationMins,
            limits.limitName,
          ),
          usedPercent: limits.secondary.usedPercent,
          resetsAt: codexResetDate(limits.secondary.resetsAt),
          windowMinutes: limits.secondary.windowDurationMins,
        });
      }
      return out;
    }
    default:
      return null;
  }
};

export const startCodexSession = (
  input: StartSessionInput,
  cwd: string,
  apiKey: string | null,
  codexPath: string | null,
  sessionId: AgentSessionId,
  requestPermission: RequestPermission,
  getRuntimeMode: () => RuntimeMode,
  orchestrationTools: OrchestrationSessionTools | null = null,
  orchestrationMcpCommand: string | null = null,
  resumeCursor: string | null = null,
): Effect.Effect<
  CodexSessionHandle,
  AgentSessionStartError,
  AttachmentService
> =>
  Effect.gen(function* () {
    const attachments = yield* AttachmentService;
    const events = yield* Mailbox.make<AgentEvent>();
    const toolTranslationLog = createCodexToolTranslationLogger(cwd, sessionId);
    const statusLog = createCodexStatusLogger(cwd, sessionId);
    let currentMode: PermissionMode = input.permissionMode ?? "default";
    let activeThreadId = resumeCursor;
    let currentTurnId: string | null = null;
    let latestDiff = "";
    let closed = false;
    let pending: Promise<void> = Promise.resolve();
    let orchestrationHintPending = orchestrationTools !== null;
    // Runtime fast-tier gate for the model this session resolved to, from the
    // live `model/list` `serviceTiers`. `null` = unknown (probe not done /
    // failed) → trust the FE gate; `true`/`false` = the model definitively
    // does / does not advertise a fast tier. Only a definitive `false` blocks
    // the `serviceTier: "fast"` request in `runTurn`.
    let modelFastTier: boolean | null = null;
    const latestContextTokensByThread = new Map<string, number>();
    const pendingCompactionsByThread = new Map<string, CompactSnapshot>();

    type QuestionWaiter = {
      readonly questionIds: ReadonlyArray<string>;
      readonly resolve: (answers: ReadonlyArray<UserQuestionAnswer>) => void;
    };
    const questionWaiters = new Map<string, QuestionWaiter>();

    const emit = (event: AgentEvent): void => {
      if (!closed) events.unsafeOffer(event);
    };

    emit({
      _tag: "Started",
      sessionId,
      providerId: "codex",
      mode: "sdk",
    });

    const app = yield* Effect.tryPromise({
      try: () =>
        CodexAppServerClient.start({
          codexPath,
          onNotification: (notification) => {
            for (const event of translateNotification(notification))
              emit(event);
          },
          onServerRequest: (request, respond) => {
            void handleServerRequest(request)
              .then(respond)
              .catch((cause) => {
                console.warn("[codex-app-server] request failed", cause);
                respond(defaultServerRequestResponse(request));
              });
          },
        }),
      catch: (cause) =>
        new AgentSessionStartError({
          providerId: "codex",
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    if (apiKey !== null && apiKey.length > 0) {
      // app-server uses the same CLI auth stack as the TUI. The key is still
      // accepted by the legacy SDK path, but app-server currently reads auth
      // from the user's Codex home; keep a visible note for future debugging.
      console.warn(
        "[codex] API key credential present; app-server uses Codex CLI auth",
      );
    }

    const orchestrationMcpBridge =
      orchestrationTools === null
        ? null
        : yield* Effect.tryPromise({
            try: () =>
              startOrchestrationMcpBridge({
                deps: orchestrationTools.deps,
                command: orchestrationMcpCommand ?? process.execPath,
                requestPermission: (kind, options) =>
                  requestPermission(sessionId, kind, options),
                getRuntimeMode,
                getPermissionMode: () => currentMode,
              }),
            catch: (cause) =>
              new AgentSessionStartError({
                providerId: "codex",
                reason: `Could not start orchestration MCP bridge: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
              }),
          });

    const installCodexOrchestrationMcp = async (): Promise<void> => {
      if (orchestrationMcpBridge === null) return;
      const env = Object.fromEntries(
        orchestrationMcpBridge.serverConfig.env.map((entry) => [
          entry.name,
          entry.value,
        ]),
      );
      await app.request("config/value/write", {
        keyPath: `mcp_servers.${JSON.stringify(ORCHESTRATION_MCP_SERVER_NAME)}`,
        value: {
          command: orchestrationMcpBridge.serverConfig.command,
          args: orchestrationMcpBridge.serverConfig.args,
          env,
          enabled: true,
        },
        mergeStrategy: "replace",
      });
      await app.request("config/mcpServer/reload", undefined);
      const status = await app.request<{
        data?: ReadonlyArray<{ name: string }>;
      }>("mcpServerStatus/list", { detail: "toolsAndAuthOnly" });
      const found =
        Array.isArray(status.data) &&
        status.data.some(
          (server) => server.name === ORCHESTRATION_MCP_SERVER_NAME,
        );
      if (!found) {
        throw new Error(
          `Codex did not report ${ORCHESTRATION_MCP_SERVER_NAME} after MCP reload.`,
        );
      }
    };

    yield* Effect.tryPromise({
      try: installCodexOrchestrationMcp,
      catch: (cause) =>
        new AgentSessionStartError({
          providerId: "codex",
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    const commonThreadParams = {
      model: input.model ?? null,
      cwd,
      approvalPolicy: "never" as const,
      sandbox: toSandboxMode(currentMode),
      serviceName: "zuse",
      developerInstructions: input.workspaceInstructions ?? null,
    };

    const startOrResume = async (): Promise<void> => {
      if (activeThreadId !== null && input.forkFromResume === true) {
        // "Fork chat": branch the source thread into a NEW thread so the
        // original transcript stays intact. The forked thread id becomes this
        // session's cursor via the SessionCursor emit below.
        const forked = await app.request<{ thread: { id: string } }>(
          "thread/fork",
          {
            threadId: activeThreadId,
            ...commonThreadParams,
          },
        );
        activeThreadId = forked.thread.id;
      } else if (activeThreadId !== null) {
        const resumed = await app.request<{ thread: { id: string } }>(
          "thread/resume",
          {
            threadId: activeThreadId,
            ...commonThreadParams,
          },
        );
        activeThreadId = resumed.thread.id;
      } else {
        const started = await app.request<{ thread: { id: string } }>(
          "thread/start",
          commonThreadParams,
        );
        activeThreadId = started.thread.id;
      }
      emit({
        _tag: "SessionCursor",
        cursor: activeThreadId,
        strategy: "codex-thread-id",
      });
      try {
        const currentGoal = await app.request<unknown>("thread/goal/get", {
          threadId: activeThreadId,
        });
        const goal = goalFromResponse(currentGoal);
        if (goal !== null) {
          emit({ _tag: "GoalUpdated", goal: normalizeThreadGoal(goal) });
        }
      } catch (cause) {
        console.warn("[codex] goal hydration failed", cause);
      }
      // Runtime fast-mode confirmation: the version floor (AgentAvailability
      // `capabilities`) + the static model catalog decide whether the FE
      // *shows* the fast toggle; the live `model/list` `serviceTiers` are the
      // authoritative per-model gate enforced at turn time (see `runTurn`).
      // Best-effort — a failure leaves `modelFastTier` null (trust the FE).
      try {
        modelFastTier = await probeModelFastTier(app, input.model ?? null);
      } catch (cause) {
        console.warn("[codex] fast-tier probe failed", cause);
      }
    };

    yield* Effect.tryPromise({
      try: startOrResume,
      catch: (cause) =>
        new AgentSessionStartError({
          providerId: "codex",
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    const resolveImageInputs = async (
      refs: ReadonlyArray<AttachmentRef>,
    ): Promise<ReadonlyArray<UserInput>> => {
      const resolved: Array<UserInput | null> = await Promise.all(
        refs.map(async (ref) => {
          if (ref.id.startsWith("pending-")) return null;
          const normalizedMime =
            ref.mimeType.toLowerCase() === "image/jpg"
              ? "image/jpeg"
              : ref.mimeType.toLowerCase();
          if (!SUPPORTED_CODEX_IMAGE_MIME.has(normalizedMime)) return null;
          const meta = await Effect.runPromise(attachments.readPath(ref.id));
          return meta === null
            ? null
            : ({ type: "localImage", path: meta.path } as const);
        }),
      );
      return resolved.filter((item): item is UserInput => item !== null);
    };

    const findSkillPath = async (name: string): Promise<string | null> => {
      const response = await app.request<{
        data: ReadonlyArray<{
          skills: ReadonlyArray<{
            name: string;
            path: string;
            enabled: boolean;
          }>;
        }>;
      }>("skills/list", { cwds: [cwd], forceReload: false });
      for (const entry of response.data) {
        const found = entry.skills.find((s) => s.enabled && s.name === name);
        if (found !== undefined) return found.path;
      }
      return null;
    };

    const buildUserInput = async (
      text: string,
      attachmentRefs: ReadonlyArray<AttachmentRef>,
      fileRefs: ReadonlyArray<FileRef>,
      skillRefs: ReadonlyArray<SkillRef>,
    ): Promise<ReadonlyArray<UserInput>> => {
      const out: UserInput[] = [];
      for (const skill of skillRefs) {
        const path = await findSkillPath(skill.name);
        if (path !== null) {
          out.push({ type: "skill", name: skill.name, path });
        }
      }
      for (const file of fileRefs) {
        out.push({ type: "mention", name: file.relPath, path: file.absPath });
      }
      const skillPrefix = skillRefs[0]?.name;
      const cleanText =
        skillPrefix !== undefined
          ? text.replace(new RegExp(`^/${skillPrefix}\\s*`), "").trim()
          : text.trim();
      if (cleanText.length > 0) {
        out.push({ type: "text", text: cleanText, text_elements: [] });
      }
      out.push(...(await resolveImageInputs(attachmentRefs)));
      return out;
    };

    const runTurn = async (
      text: string,
      attachmentRefs: ReadonlyArray<AttachmentRef>,
      fileRefs: ReadonlyArray<FileRef>,
      skillRefs: ReadonlyArray<SkillRef>,
    ): Promise<void> => {
      if (closed || activeThreadId === null) return;
      const commandHandled =
        skillRefs.length === 0 && (await runSlashCommand(text));
      if (commandHandled) return;

      emit({ _tag: "Status", status: "running" });
      // Plan-mode emulation: Codex has no native "plan" runtime mode, so
      // prepend a developer-instructions block while plan mode is active.
      // The sandbox policy still gates writes, so this is belt-and-braces.
      const basePromptText = applyPlanModePrefix(currentMode, text);
      const promptText =
        orchestrationHintPending && orchestrationMcpBridge !== null
          ? `${orchestrationMcpPromptHint()}\n\n${basePromptText}`
          : basePromptText;
      orchestrationHintPending = false;
      // Reasoning effort: forwarded from FE picker via
      // `input.modelOptions.reasoning`. Pass through low/medium/high
      // directly — Codex accepts the same literal set we use in wire's
      // `ReasoningLevel`.
      const reasoning = input.modelOptions?.["reasoning"];
      const effort: "low" | "medium" | "high" | null =
        reasoning === "low" || reasoning === "medium" || reasoning === "high"
          ? reasoning
          : null;
      // Fast mode: the `fastMode` per-model boolean knob maps onto Codex's
      // `serviceTier: "fast"` (the 1.5× speed tier). The FE only shows the
      // toggle when the CLI version + static model catalog allow it; the live
      // `model/list` `serviceTiers` are the authoritative per-model gate, so we
      // drop the field (and tell the user) when the resolved model definitively
      // lacks a fast tier. `modelFastTier === null` (unknown) trusts the FE.
      const fastModeRequested = input.modelOptions?.["fastMode"] === "true";
      const fastMode = fastModeRequested && modelFastTier !== false;
      if (fastModeRequested && modelFastTier === false) {
        emit({
          _tag: "AssistantMessage",
          itemId: nextItemId(),
          text: "Fast mode isn't available for this model — running at the standard tier.",
        });
      }
      const turn = await app.request<{ turn: { id: string } }>("turn/start", {
        threadId: activeThreadId,
        input: [
          ...(await buildUserInput(
            promptText,
            attachmentRefs,
            fileRefs,
            skillRefs,
          )),
        ],
        cwd,
        approvalPolicy: "never",
        sandboxPolicy: toSandboxPolicy(currentMode, cwd),
        model: input.model ?? null,
        ...(effort !== null ? { effort } : {}),
        ...(fastMode ? { serviceTier: "fast" } : {}),
      });
      currentTurnId = turn.turn.id;
    };

    const enqueueTurn = (
      text: string,
      attachmentRefs: ReadonlyArray<AttachmentRef> = [],
      fileRefs: ReadonlyArray<FileRef> = [],
      skillRefs: ReadonlyArray<SkillRef> = [],
    ): void => {
      pending = pending
        .then(() => runTurn(text, attachmentRefs, fileRefs, skillRefs))
        .catch((cause) => {
          emit({
            _tag: "Error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
          emit({ _tag: "Status", status: "idle" });
        });
    };

    const runSlashCommand = async (rawText: string): Promise<boolean> => {
      const trimmed = rawText.trim();
      const match = trimmed.match(/^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
      if (match === null || activeThreadId === null) return false;
      const command = match[1]!;
      const args = (match[2] ?? "").trim();
      const say = (text: string) =>
        emit({ _tag: "AssistantMessage", itemId: nextItemId(), text });

      switch (command) {
        case "compact":
          {
            const threadId = activeThreadId;
            const snapshot = startCompactSnapshot(
              latestContextTokensByThread.get(threadId) ?? null,
            );
            pendingCompactionsByThread.set(threadId, snapshot);
            emit(startCompactEvent({ providerId: "codex", snapshot }));
            try {
              await app.request("thread/compact/start", { threadId });
            } catch (cause) {
              pendingCompactionsByThread.delete(threadId);
              throw cause;
            }
          }
          return true;
        case "fork": {
          const forked = await app.request<{ thread: { id: string } }>(
            "thread/fork",
            {
              threadId: activeThreadId,
              ...commonThreadParams,
            },
          );
          activeThreadId = forked.thread.id;
          emit({
            _tag: "SessionCursor",
            cursor: activeThreadId,
            strategy: "codex-thread-id",
          });
          say(`Forked Codex thread ${activeThreadId}.`);
          return true;
        }
        case "undo":
        case "rollback":
          await app.request("thread/rollback", {
            threadId: activeThreadId,
            numTurns: 1,
          });
          say(
            "Rolled back the last Codex turn. Local file changes are not reverted by Codex app-server rollback.",
          );
          return true;
        case "review":
          emit({ _tag: "Status", status: "running" });
          await app.request("review/start", {
            threadId: activeThreadId,
            target:
              args.length > 0
                ? { type: "custom", instructions: args }
                : { type: "uncommittedChanges" },
            delivery: "inline",
          });
          return true;
        case "status": {
          const status = await app.request<{
            thread: {
              id: string;
              status: string;
              modelProvider: string;
              cwd: string;
            };
          }>("thread/read", { threadId: activeThreadId, includeTurns: false });
          say(
            `Codex thread ${status.thread.id}\nstatus: ${status.thread.status}\nprovider: ${status.thread.modelProvider}\ncwd: ${status.thread.cwd}`,
          );
          return true;
        }
        case "diff":
          say(
            latestDiff.length > 0
              ? latestDiff
              : "No Codex turn diff is available yet.",
          );
          return true;
        case "mcp": {
          const result = await app.request("mcpServerStatus/list", {});
          say(`MCP servers:\n${asText(result)}`);
          return true;
        }
        case "apps": {
          const result = await app.request("app/list", {});
          say(`Apps:\n${asText(result)}`);
          return true;
        }
        case "plugins": {
          const result = await app.request("plugin/list", {});
          say(`Plugins:\n${asText(result)}`);
          return true;
        }
        case "experimental": {
          const result = await app.request("experimentalFeature/list", {});
          say(`Experimental features:\n${asText(result)}`);
          return true;
        }
        case "debug-config": {
          const result = await app.request("config/read", {});
          say(`Codex config:\n${asText(result)}`);
          return true;
        }
        case "tool-log":
        case "debug-tools":
          say(`Codex tool translation log:\n${toolTranslationLog.path}`);
          return true;
        case "status-log":
        case "debug-status":
          say(`Codex status log:\n${statusLog.path}`);
          return true;
        case "permissions":
          say(
            "Codex approval policy is managed by this app. Current embedded policy: never.",
          );
          return true;
        case "approval":
          say(
            "Codex embedded approval policy is currently fixed at never; permission prompts are bridged through this app when app-server requests them.",
          );
          return true;
        case "sandbox":
          if (args === "read-only" || args === "plan" || args === "readonly") {
            currentMode = "plan";
            emit({ _tag: "PermissionModeChanged", mode: "plan" });
            say("Codex sandbox set to read-only.");
          } else if (
            args === "workspace-write" ||
            args === "write" ||
            args === "default" ||
            args.length === 0
          ) {
            currentMode = "default";
            emit({ _tag: "PermissionModeChanged", mode: "default" });
            say("Codex sandbox set to workspace-write.");
          } else {
            say("Usage: /sandbox read-only | workspace-write");
          }
          return true;
        case "init":
          emit({ _tag: "Status", status: "running" });
          await app.request("turn/start", {
            threadId: activeThreadId,
            input: [
              {
                type: "text",
                text:
                  args.length > 0
                    ? `Initialize repository instructions. ${args}`
                    : "Initialize or update AGENTS.md with concise project instructions for Codex.",
                text_elements: [],
              },
            ],
            cwd,
          });
          return true;
        case "ps":
        case "stop":
        case "sandbox-add-read-dir":
        case "agent":
        case "personality":
        case "fast":
        case "mention":
        case "copy":
        case "theme":
        case "statusline":
        case "title":
        case "feedback":
        case "logout":
        case "resume":
        case "quit":
        case "exit":
          say("Closed the active Codex thread.");
          emit({ _tag: "Completed", reason: "ended" });
          closed = true;
          app.close();
          return true;
        default:
          return false;
      }
    };

    function translateNotification(
      notification: ServerNotification,
    ): ReadonlyArray<AgentEvent> {
      if (
        notification.method === "thread/tokenUsage/updated" &&
        notification.params.threadId === activeThreadId
      ) {
        latestContextTokensByThread.set(
          notification.params.threadId,
          notification.params.tokenUsage.last.totalTokens,
        );
      }

      const statusEvents = translateCodexStatusNotification(
        notification,
        activeThreadId,
      );
      if (statusEvents !== null) {
        statusLog.append(notification, statusEvents);
        return statusEvents;
      }

      switch (notification.method) {
        case "thread/started":
          activeThreadId = notification.params.thread.id;
          return [
            {
              _tag: "SessionCursor",
              cursor: activeThreadId,
              strategy: "codex-thread-id",
            },
          ];
        case "turn/started":
          if (notification.params.threadId !== activeThreadId) return [];
          currentTurnId = notification.params.turn.id;
          return [{ _tag: "Status", status: "running" }];
        case "turn/completed":
          if (notification.params.threadId !== activeThreadId) return [];
          currentTurnId = null;
          return [{ _tag: "Status", status: "idle" }];
        case "turn/diff/updated":
          if (notification.params.threadId === activeThreadId) {
            latestDiff = notification.params.diff;
          }
          return [];
        case "thread/goal/updated":
          if (notification.params.threadId !== activeThreadId) return [];
          return [
            {
              _tag: "GoalUpdated",
              goal: normalizeThreadGoal(notification.params.goal),
            },
          ];
        case "thread/goal/cleared":
          if (notification.params.threadId !== activeThreadId) return [];
          return [{ _tag: "GoalCleared" }];
        case "item/started":
          if (notification.params.threadId !== activeThreadId) return [];
          {
            const translated = translateCodexItem(
              notification.params.item,
              "started",
            );
            toolTranslationLog.append(
              "started",
              notification.params.item,
              translated,
            );
            return translated;
          }
        case "item/completed":
          if (notification.params.threadId !== activeThreadId) return [];
          {
            const compactMetadata =
              notification.params.item.type === "contextCompaction"
                ? (() => {
                    const threadId = notification.params.threadId;
                    const started =
                      pendingCompactionsByThread.get(threadId) ?? null;
                    pendingCompactionsByThread.delete(threadId);
                    const now = Date.now();
                    const startedAt = started?.startedAt ?? now;
                    const beforeTokens = started?.beforeTokens ?? null;
                    const latestAfter =
                      latestContextTokensByThread.get(threadId) ?? null;
                    const afterTokens =
                      latestAfter !== null && latestAfter !== beforeTokens
                        ? latestAfter
                        : null;
                    return {
                      itemId: started?.itemId ?? nextCompactItemId(),
                      startedAt,
                      beforeTokens,
                      afterTokens,
                    };
                  })()
                : undefined;
            const translated = translateCodexItem(
              notification.params.item,
              "completed",
              compactMetadata,
            );
            toolTranslationLog.append(
              "completed",
              notification.params.item,
              translated,
            );
            statusLog.append(notification, translated);
            return translated;
          }
        case "thread/compacted":
          statusLog.append(notification, []);
          return [];
        case "error":
          return [
            { _tag: "Error", message: notification.params.error.message },
          ];
        default:
          return [];
      }
    }

    async function handleServerRequest(
      request: ServerRequest,
    ): Promise<unknown> {
      switch (request.method) {
        case "item/commandExecution/requestApproval": {
          const p = request.params;
          emit({
            _tag: "PermissionRequest",
            itemId: p.itemId as AgentItemId,
            kind: "command_execution",
            details: p,
          });
          const decision = await requestPermission(
            sessionId,
            { _tag: "Bash", command: p.command ?? "" },
            { forcePrompt: false },
          );
          return { decision: decisionToCodex(decision) };
        }
        case "item/fileChange/requestApproval": {
          const p = request.params;
          emit({
            _tag: "PermissionRequest",
            itemId: p.itemId as AgentItemId,
            kind: "file_change",
            details: p,
          });
          const decision = await requestPermission(
            sessionId,
            { _tag: "FileWrite", path: p.grantRoot ?? cwd },
            { forcePrompt: false },
          );
          return { decision: decisionToCodex(decision) };
        }
        case "item/permissions/requestApproval": {
          const p = request.params;
          emit({
            _tag: "PermissionRequest",
            itemId: p.itemId as AgentItemId,
            kind: "permissions",
            details: p,
          });
          const decision = await requestPermission(
            sessionId,
            {
              _tag: "Other",
              tool: "request_permissions",
              summary: p.reason ?? "Codex requested additional permissions",
            },
            { forcePrompt: false },
          );
          return decision._tag === "Deny"
            ? { permissions: {}, scope: "turn" }
            : { permissions: {}, scope: "session" };
        }
        case "item/tool/requestUserInput": {
          const p = request.params;
          const answers = await new Promise<ReadonlyArray<UserQuestionAnswer>>(
            (resolve) => {
              questionWaiters.set(p.itemId, {
                questionIds: p.questions.map((q) => q.id),
                resolve,
              });
              emit({
                _tag: "UserQuestion",
                itemId: p.itemId as AgentItemId,
                questions: p.questions.map((q) => ({
                  question: q.question,
                  options: (q.options ?? []).map(
                    (opt) => `${opt.label}: ${opt.description}`,
                  ),
                  multiSelect: false,
                })),
              });
            },
          );
          const waiter = questionWaiters.get(p.itemId);
          const questionIds =
            waiter?.questionIds ?? p.questions.map((q) => q.id);
          const out: Record<string, { answers: string[] }> = {};
          for (const answer of answers) {
            const question = p.questions[answer.questionIndex];
            const id = questionIds[answer.questionIndex];
            if (question === undefined || id === undefined) continue;
            const selected = answer.selected
              .map((idx) => question.options?.[idx]?.label)
              .filter((v): v is string => typeof v === "string");
            if (answer.other !== undefined) selected.push(answer.other);
            out[id] = { answers: selected };
          }
          return { answers: out };
        }
        case "mcpServer/elicitation/request": {
          const p = request.params;
          const itemId = nextItemId();
          const answers = await new Promise<ReadonlyArray<UserQuestionAnswer>>(
            (resolve) => {
              questionWaiters.set(itemId, {
                questionIds: ["elicitation"],
                resolve,
              });
              emit({
                _tag: "UserQuestion",
                itemId,
                questions: [
                  {
                    question: `${p.serverName}: ${p.message}`,
                    options: ["Accept", "Cancel"],
                    multiSelect: false,
                  },
                ],
              });
            },
          );
          const accept = answers[0]?.selected.includes(0) === true;
          return {
            action: accept ? "accept" : "cancel",
            content: null,
            _meta: null,
          };
        }
        default:
          return defaultServerRequestResponse(request);
      }
    }

    function defaultServerRequestResponse(request: ServerRequest): unknown {
      switch (request.method) {
        case "item/commandExecution/requestApproval":
          return { decision: "decline" };
        case "item/fileChange/requestApproval":
          return { decision: "decline" };
        case "item/permissions/requestApproval":
          return { permissions: {}, scope: "turn" };
        case "item/tool/requestUserInput":
          return { answers: {} };
        case "mcpServer/elicitation/request":
          return { action: "cancel", content: null, _meta: null };
        default:
          return {};
      }
    }

    if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
      enqueueTurn(input.initialPrompt);
    }

    return {
      events: Mailbox.toStream(events),
      send: (text, attachmentRefs, fileRefs, skillRefs) =>
        Effect.sync(() => {
          enqueueTurn(
            text,
            attachmentRefs ?? [],
            fileRefs ?? [],
            skillRefs ?? [],
          );
        }),
      interrupt: () =>
        Effect.promise(async () => {
          if (activeThreadId !== null && currentTurnId !== null) {
            await app.request("turn/interrupt", {
              threadId: activeThreadId,
              turnId: currentTurnId,
            });
          }
        }),
      close: () =>
        Effect.sync(() => {
          emit({ _tag: "Completed", reason: "ended" });
          closed = true;
          if (orchestrationMcpBridge !== null) {
            void orchestrationMcpBridge.close();
          }
          app.close();
          void Effect.runPromise(events.end);
        }),
      setPermissionMode: (mode) =>
        Effect.sync(() => {
          currentMode = mode;
          emit({ _tag: "PermissionModeChanged", mode });
        }),
      answerQuestion: (itemId, answers) =>
        Effect.sync(() => {
          const waiter = questionWaiters.get(itemId);
          if (waiter === undefined) return;
          questionWaiters.delete(itemId);
          waiter.resolve(answers);
        }),
      getGoal: () =>
        Effect.promise(async () => {
          if (activeThreadId === null) return null;
          const response = await app.request<unknown>("thread/goal/get", {
            threadId: activeThreadId,
          });
          const goal = goalFromResponse(response);
          return goal === null ? null : normalizeThreadGoal(goal);
        }),
      setGoal: (goalInput) =>
        Effect.promise(async () => {
          if (activeThreadId === null) {
            throw new Error("Codex thread is not ready for goals.");
          }
          const response = await app.request<unknown>("thread/goal/set", {
            threadId: activeThreadId,
            ...(goalInput.objective !== undefined
              ? { objective: goalInput.objective }
              : {}),
            ...(goalInput.status !== undefined
              ? { status: goalInput.status }
              : {}),
            ...(goalInput.tokenBudget !== undefined
              ? { tokenBudget: goalInput.tokenBudget }
              : {}),
          });
          const responseGoal = goalFromResponse(response);
          if (responseGoal === null) {
            throw new Error("Codex did not return a goal.");
          }
          const normalized = normalizeThreadGoal(responseGoal);
          emit({ _tag: "GoalUpdated", goal: normalized });
          return normalized;
        }),
      clearGoal: () =>
        Effect.promise(async () => {
          if (activeThreadId === null) return;
          await app.request("thread/goal/clear", { threadId: activeThreadId });
          emit({ _tag: "GoalCleared" });
        }),
    };
  });
