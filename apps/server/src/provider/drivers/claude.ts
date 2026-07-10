import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type PermissionMode as SdkPermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { type Cause, Effect, Queue, Stream } from "effect";
import { z } from "zod";

import {
  AgentSessionStartError,
  type AgentEvent,
  type AgentItemId,
  type AgentSessionId,
  type AttachmentRef,
  type PermissionDecision,
  type PermissionKind,
  type PermissionMode,
  type RuntimeMode,
  type StartSessionInput,
  type UserQuestion,
  type UserQuestionAnswer,
} from "@zuse/contracts";

import { AttachmentService } from "../../attachment/services/attachment-service.ts";
import {
  applyClaudeWorktreeEnv,
  claudeWorktreePrompt,
} from "./claude-worktree-prompt.ts";
import {
  finishCompactEvent,
  isCompactCommand,
  startCompactEvent,
  startCompactSnapshot,
  type CompactSnapshot,
} from "./compact.ts";
import {
  ORCHESTRATION_MCP_SERVER_NAME,
  ORCHESTRATION_MCP_TOOLS,
} from "./orchestration-tools.ts";

/**
 * Live-only handle for one Claude SDK conversation. The orchestrator
 * (`ProviderService`) owns the map of sessionId → handle and forwards wire
 * RPCs to these methods.
 */
export interface ClaudeSessionHandle {
  readonly events: Stream.Stream<AgentEvent>;
  readonly send: (
    text: string,
    attachments?: ReadonlyArray<AttachmentRef>,
    fileRefs?: unknown,
    skillRefs?: unknown,
  ) => Effect.Effect<void>;
  readonly interrupt: () => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
  /**
   * Switch SDK lifecycle mode (plan / default / acceptEdits) on a live
   * session. Emits `PermissionModeChanged` as a side-effect so the
   * renderer chip stays in sync without polling.
   */
  readonly setPermissionMode: (mode: PermissionMode) => Effect.Effect<void>;
  /**
   * Resolve the pending `AskUserQuestion` tool call identified by `itemId`
   * with the user's answers. The SDK turn unwinds with the answers as the
   * tool result. No-op if the question is unknown (already cancelled or
   * answered).
   */
  readonly answerQuestion: (
    itemId: AgentItemId,
    answers: ReadonlyArray<UserQuestionAnswer>,
  ) => Effect.Effect<void>;
}

/**
 * Map our PermissionMode literal onto the SDK's. Identical at present
 * (the SDK union is wider — `dontAsk`, `auto`, `bypassPermissions` —
 * but we only expose the three the renderer chip surfaces).
 */
const toSdkPermissionMode = (mode: PermissionMode): SdkPermissionMode =>
  mode satisfies SdkPermissionMode;

const runtimeModeToSdkPermissionMode = (
  runtimeMode: RuntimeMode,
  permissionMode: PermissionMode,
): SdkPermissionMode => {
  if (permissionMode === "plan") return toSdkPermissionMode(permissionMode);
  switch (runtimeMode) {
    case "full-access":
      return "bypassPermissions" as SdkPermissionMode;
    case "auto-accept-edits":
    case "auto-accept-edits-and-bash":
      return "acceptEdits" as SdkPermissionMode;
    case "approval-required":
      return toSdkPermissionMode(permissionMode);
  }
};

/**
 * Name we register the in-process AskUserQuestion tool under. The SDK
 * exposes MCP tools to the model as `mcp__<server>__<tool>`, so the
 * model sees `mcp__zuse__ask_user_question` and the translator
 * matches on that exact prefix to emit `UserQuestion` instead of a
 * generic `ToolUse`.
 */
const ZUSE_MCP_NAME = "zuse";
const ASK_USER_QUESTION_TOOL = "ask_user_question";
const ASK_USER_QUESTION_FQN = `mcp__${ZUSE_MCP_NAME}__${ASK_USER_QUESTION_TOOL}`;
const ORCHESTRATION_TOOL_FQNS = ORCHESTRATION_MCP_TOOLS.map(
  (toolDef) => `mcp__${ORCHESTRATION_MCP_SERVER_NAME}__${toolDef.name}`,
);

/**
 * Anthropic accepts these media types as image content blocks. Anything else
 * (HEIC, BMP, raw bytes) gets dropped with a console warning rather than
 * forwarded as an unsupported block — the SDK would reject the whole turn.
 */
const SUPPORTED_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

type AnthropicImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

type UserContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: AnthropicImageMediaType;
        data: string;
      };
    }
  | {
      type: "document";
      source: {
        type: "base64";
        media_type: "application/pdf";
        data: string;
      };
      title?: string;
    };

/**
 * Tiny promise-backed async input channel. The Claude SDK's streaming-input
 * mode wants an `AsyncIterable<SDKUserMessage>`; we want imperative pushes
 * from `send()`. This bridges the two without pulling in another dependency.
 * `push` after `close` is silently dropped.
 */
class UserInputChannel implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    if (this.waiting !== null) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: message, done: false });
      return;
    }
    this.buffer.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting !== null) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () =>
        new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          const next = this.buffer.shift();
          if (next !== undefined) {
            resolve({ value: next, done: false });
            return;
          }
          if (this.closed) {
            resolve({ value: undefined, done: true });
            return;
          }
          this.waiting = resolve;
        }),
    };
  }
}

const userMessageOf = (
  text: string,
  sessionId: string,
  attachmentBlocks: ReadonlyArray<UserContentBlock> = [],
): SDKUserMessage => ({
  type: "user",
  message: {
    role: "user",
    content: [...attachmentBlocks, { type: "text", text }],
  },
  parent_tool_use_id: null,
  session_id: sessionId,
});

let itemCounter = 0;
const nextItemId = (): AgentItemId =>
  `i_${Date.now()}_${++itemCounter}` as AgentItemId;

// Markers Claude Code injects into every subprocess it spawns. If memoize
// is launched from a Claude Code terminal these get inherited, and the
// nested `claude` binary then loads a different parent's session state
// instead of the user's `claude /login` OAuth. Strip them so our spawn
// runs as if the user had launched it from a fresh shell.
const INHERITED_CLAUDE_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_NAME",
  "CLAUDE_CODE_SESSION_LOG",
] as const;

const scrubInheritedClaudeMarkers = (
  base: NodeJS.ProcessEnv,
): Record<string, string | undefined> => {
  const next: Record<string, string | undefined> = { ...base };
  for (const key of INHERITED_CLAUDE_MARKERS) delete next[key];
  return next;
};

/**
 * Per-turn accumulator for thinking_delta / redacted_thinking blocks. The
 * SDK delivers raw `content_block_*` events when `includePartialMessages`
 * is on; we stitch them back together because the completed assistant
 * message has the `thinking` field stripped (SDK policy).
 *
 * Keyed by `index` from the stream events, which is stable within one
 * message but resets per turn — `message_start` clears the map.
 */
interface ThinkingAccumulator {
  kind: "thinking" | "redacted_thinking";
  text: string;
  signatureLength: number;
}

interface PendingAgent {
  readonly agentName: string;
  readonly model: string;
  readonly startedAt: number;
  turnCount: number;
}

interface TranslateState {
  thinkingByIndex: Map<number, ThinkingAccumulator>;
  emittedThinkingThisTurn: boolean;
  /**
   * Tracks `Agent` / `Task` tool_uses awaiting their paired tool_result
   * so we can emit a `SubagentSummary` event when the result lands.
   * Keyed by the parent's tool_use id.
   */
  pendingAgents: Map<string, PendingAgent>;
  /**
   * Most recent `parent_tool_use_id` seen on an SDK message. The Claude
   * SDK's `canUseTool` callback signature does not include a parent id,
   * so the driver attributes a permission request to the parent of the
   * latest in-flight assistant message. SDK currently runs sub-agents
   * serially; if it ever parallelises, this attribution races.
   */
  latestParentItemId: AgentItemId | undefined;
  /**
   * Tool-use ids for in-flight AskUserQuestion calls. The translator
   * suppresses the generic `ToolUse` and matching `ToolResult` events for
   * these ids — the question + answer are surfaced via dedicated
   * `UserQuestion` events and the persisted `user_question` /
   * `user_question_answer` rows instead.
   */
  askUserQuestionIds: Set<string>;
  /**
   * Tool-use ids for in-flight `ExitPlanMode` calls. When the matching
   * `tool_result` lands with `is_error === false`, the SDK has already
   * flipped its internal `permissionMode` to `default`; we mirror that
   * by emitting a `PermissionModeChanged` event so MessageStore
   * persists the new mode and the chip auto-untoggles.
   */
  exitPlanModeIds: Set<string>;
  /**
   * Tokens occupying the context window after the most recent top-level
   * assistant turn (`input + cache_read + cache_creation + output`). The
   * per-request `usage` on an assistant message is the truest snapshot of
   * current context fill; we stash it here and emit an exact `ContextUsage`
   * when the turn's `result` lands (which carries the real `contextWindow`).
   */
  lastContextUsedTokens: number | null;
  pendingCompact: CompactSnapshot | null;
  /**
   * Set once we've re-emitted an auth failure as an Error from a top-level
   * assistant text block, so the turn's terminal `result` doesn't surface the
   * same failure a second time.
   */
  emittedAuthError: boolean;
  /**
   * Set when the user interrupts the running turn (`handle.interrupt`). The SDK
   * ends an interrupted turn with an `error_during_execution` result, which
   * would otherwise surface as a bogus error bubble; while this flag is set the
   * translator emits an `Interrupted` event + `Completed reason:"interrupted"`
   * instead. Reset per turn once consumed.
   */
  interrupted: boolean;
}

const newTranslateState = (): TranslateState => ({
  thinkingByIndex: new Map(),
  emittedThinkingThisTurn: false,
  pendingAgents: new Map(),
  latestParentItemId: undefined,
  askUserQuestionIds: new Set(),
  exitPlanModeIds: new Set(),
  lastContextUsedTokens: null,
  pendingCompact: null,
  emittedAuthError: false,
  interrupted: false,
});

const isAgentToolUse = (block: { type?: string; name?: string }): boolean =>
  block.type === "tool_use" &&
  (block.name === "Agent" || block.name === "Task");

const extractTextFromContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          const t = (block as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .join("\n");
  }
  return "";
};

// Off by default; enable with MEMOIZE_DEBUG_THINKING=1 when diagnosing
// thinking-block delivery. One JSON object per line so terminal
// scrollback / `grep` / `tee logfile` all preserve every field — Node's
// default util.inspect spans multiple lines and gets chopped by
// line-oriented tools.
const THINKING_DEBUG = process.env.MEMOIZE_DEBUG_THINKING === "1";
const tlog = (event: string, payload: Record<string, unknown> = {}): void => {
  if (!THINKING_DEBUG) return;
  let line: string;
  try {
    line = JSON.stringify({ event, ...payload });
  } catch {
    line = JSON.stringify({ event, error: "unserializable payload" });
  }
  // eslint-disable-next-line no-console
  console.error(`[claude-driver/thinking] ${line}`);
};
const summarize = (value: unknown, max = 200): string => {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > max ? `${s.slice(0, max)}…(${s.length}b)` : s;
  } catch {
    return String(value);
  }
};

/**
 * Pull the real context-window size out of a `result` message's
 * `modelUsage` map. Prefers the model that produced the result; falls back
 * to the largest window present (sub-agents on smaller models can pollute
 * the map). Returns `null` when the SDK omits it.
 */
const contextWindowFromModelUsage = (
  msg: SDKMessage,
  model: string,
): number | null => {
  const modelUsage = (
    msg as { modelUsage?: Record<string, { contextWindow?: unknown }> }
  ).modelUsage;
  if (modelUsage === undefined) return null;
  const windowOf = (entry: { contextWindow?: unknown } | undefined) =>
    typeof entry?.contextWindow === "number" && entry.contextWindow > 0
      ? entry.contextWindow
      : null;
  const exact = windowOf(modelUsage[model]);
  if (exact !== null) return exact;
  let max: number | null = null;
  for (const entry of Object.values(modelUsage)) {
    const w = windowOf(entry);
    if (w !== null && (max === null || w > max)) max = w;
  }
  return max;
};

interface ClaudeRateLimitInfo {
  readonly status?: string;
  readonly resetsAt?: number;
  readonly rateLimitType?: string;
  readonly utilization?: number;
}

const CLAUDE_LIMIT_LABELS: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly limit (Opus)",
  seven_day_sonnet: "Weekly limit (Sonnet)",
  overage: "Overage",
};

const CLAUDE_LIMIT_WINDOW_MINUTES: Record<string, number> = {
  five_hour: 5 * 60,
  seven_day: 7 * 24 * 60,
  seven_day_opus: 7 * 24 * 60,
  seven_day_sonnet: 7 * 24 * 60,
};

/**
 * Map a subscription `rate_limit_event` into a `UsageLimit` event. Only
 * fires for claude.ai subscription sessions; API-key sessions never emit
 * it. `utilization` arrives as a 0–1 fraction or a 0–100 percent depending
 * on SDK version, so normalise defensively.
 */
const claudeRateLimitEvents = (
  info: ClaudeRateLimitInfo,
): ReadonlyArray<AgentEvent> => {
  const type = info.rateLimitType;
  if (type === undefined) return [];
  const utilization =
    typeof info.utilization === "number" ? info.utilization : null;
  const usedPercent =
    utilization === null
      ? null
      : utilization <= 1
        ? utilization * 100
        : utilization;
  const resetsAt =
    typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt)
      ? new Date(
          info.resetsAt > 1e12 ? info.resetsAt : info.resetsAt * 1000,
        ).toISOString()
      : null;
  return [
    {
      _tag: "UsageLimit",
      providerId: "claude",
      label: CLAUDE_LIMIT_LABELS[type] ?? "Usage limit",
      usedPercent,
      resetsAt,
      windowMinutes: CLAUDE_LIMIT_WINDOW_MINUTES[type] ?? null,
    },
  ];
};

// When the `claude` CLI/SDK runs without valid credentials it does NOT throw —
// it reports the failure as ordinary output ("Not logged in · Please run
// /login", "Invalid API key", a 401 result). Left untranslated that renders as
// a confusing assistant message the user can't act on. We sniff the signature
// so it can be re-emitted as a structured `Error` event, which the renderer
// turns into the "Authentication required → Sign in to Claude" card.
const CLAUDE_AUTH_FAILURE_PATTERN =
  /not logged in|please run \/login|\/login\b|invalid api key|invalid authentication credentials|\bunauthorized\b|oauth token (?:has )?expired|authentication_error|\b401\b/i;

export const looksLikeClaudeAuthFailure = (text: string): boolean =>
  CLAUDE_AUTH_FAILURE_PATTERN.test(text);

/**
 * Pull the human-readable error text out of a `result` message. Treat only
 * explicit failure signals as provider errors. Claude can return assistant
 * prose in `result` even when `subtype` is not exactly `"success"`; rendering
 * that prose as an Error creates a bogus "Provider error" bubble.
 */
export const claudeResultErrorText = (msg: SDKMessage): string | null => {
  const m = msg as {
    subtype?: string;
    is_error?: boolean;
    result?: unknown;
    errors?: unknown;
    api_error_status?: unknown;
  };
  const status =
    typeof m.api_error_status === "number" ? m.api_error_status : null;
  const errors = Array.isArray(m.errors)
    ? m.errors.filter((e): e is string => typeof e === "string")
    : [];
  const isError =
    m.is_error === true ||
    errors.length > 0 ||
    (status !== null && status >= 400);
  if (!isError) {
    const subtype = typeof m.subtype === "string" ? m.subtype : "";
    const hasResult =
      typeof m.result === "string" && m.result.trim().length > 0;
    if (subtype.startsWith("error") && !hasResult) {
      return "The agent run ended with an error.";
    }
    return null;
  }
  const parts: string[] = [];
  if (typeof m.result === "string" && m.result.trim().length > 0) {
    parts.push(m.result.trim());
  }
  parts.push(...errors);
  if (status !== null) parts.push(`API Error: ${status}`);
  const text = parts.join("\n").trim();
  return text.length > 0 ? text : "The agent run ended with an error.";
};

/**
 * Translate one SDKMessage into zero-or-more wire AgentEvents. Mostly
 * stateless, but the `state` carries thinking-delta accumulators across
 * `stream_event` messages so we can emit one Thinking event per content
 * block at its `content_block_stop`.
 */
const translate = (
  msg: SDKMessage,
  state: TranslateState,
): ReadonlyArray<AgentEvent> => {
  tlog("sdk-msg", {
    type: (msg as { type?: unknown }).type,
    hasMessage: "message" in (msg as object),
    sessionId: (msg as { session_id?: unknown }).session_id,
  });
  // Pull `parent_tool_use_id` off the SDK message — when set, every event
  // we emit for this message is happening inside a sub-agent and gets
  // tagged so the renderer can group nested rows.
  const parentItemId =
    typeof (msg as { parent_tool_use_id?: unknown }).parent_tool_use_id ===
    "string"
      ? ((msg as { parent_tool_use_id: string })
          .parent_tool_use_id as AgentItemId)
      : undefined;
  state.latestParentItemId = parentItemId;

  if (msg.type === "assistant") {
    const out: AgentEvent[] = [];
    const content = msg.message.content;
    const blockTypes: string[] = [];
    // Each assistant message inside a sub-agent counts as one of its
    // turns. The SDK exposes only the parent's `Agent` tool_use start
    // and the eventual tool_result; we tally turns here so the
    // SubagentSummary reflects how much work the sub-agent did.
    if (parentItemId !== undefined) {
      const pending = state.pendingAgents.get(parentItemId);
      if (pending !== undefined) pending.turnCount += 1;
    } else {
      // Top-level turn: snapshot how full the context window is. The
      // per-request `usage` is what was actually sent to (input + cache)
      // plus generated this request (output) — i.e. the live occupancy.
      const usage = (msg.message as { usage?: unknown }).usage as
        | Record<string, unknown>
        | undefined;
      if (usage !== undefined) {
        const tok = (key: string): number => {
          const v = usage[key];
          return typeof v === "number" ? v : 0;
        };
        const used =
          tok("input_tokens") +
          tok("cache_read_input_tokens") +
          tok("cache_creation_input_tokens") +
          tok("output_tokens");
        if (used > 0) state.lastContextUsedTokens = used;
      }
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        blockTypes.push(String((block as { type?: unknown }).type));
        if (block.type === "text" && typeof block.text === "string") {
          // An unauthenticated `claude` surfaces "Not logged in · Please run
          // /login" as a top-level assistant text block. Re-emit it as an
          // Error so the renderer shows the sign-in card instead of a dead-end
          // message. Only at the top level — a sub-agent quoting "/login" in
          // its reasoning shouldn't trip this.
          if (
            parentItemId === undefined &&
            looksLikeClaudeAuthFailure(block.text)
          ) {
            out.push({ _tag: "Error", message: block.text.trim() });
            state.emittedAuthError = true;
            continue;
          }
          out.push({
            _tag: "AssistantMessage",
            itemId: nextItemId(),
            text: block.text,
            parentItemId,
          });
        } else if (block.type === "tool_use") {
          const id =
            typeof (block as { id?: unknown }).id === "string"
              ? ((block as { id: string }).id as AgentItemId)
              : nextItemId();
          // AskUserQuestion: suppress the generic ToolUse row. The MCP
          // handler emits a dedicated `UserQuestion` event with the
          // matching itemId, which the renderer paints as a question
          // card. Track the id so the paired tool_result is suppressed
          // too — the user's answer surfaces via the persisted
          // `user_question_answer` row, not a noisy tool_result.
          if (block.name === ASK_USER_QUESTION_FQN) {
            state.askUserQuestionIds.add(id as string);
            continue;
          }
          // ExitPlanMode: track so we can detect the paired tool_result
          // and emit `PermissionModeChanged` when it succeeds. The SDK
          // flips its internal permissionMode to `default` once the
          // tool runs; we mirror that into our session row.
          if (block.name === "ExitPlanMode") {
            state.exitPlanModeIds.add(id as string);
          }
          // If this tool_use is the parent agent kicking off a sub-agent,
          // remember it so the eventual paired tool_result can pop a
          // SubagentSummary event.
          if (isAgentToolUse(block)) {
            const inputObj = (block as { input?: unknown }).input as
              | Record<string, unknown>
              | undefined;
            const subagentType =
              typeof inputObj?.subagent_type === "string"
                ? (inputObj.subagent_type as string)
                : "agent";
            const requestedModel =
              typeof inputObj?.model === "string"
                ? (inputObj.model as string)
                : "inherit";
            state.pendingAgents.set(id as string, {
              agentName: subagentType,
              model: requestedModel,
              startedAt: Date.now(),
              turnCount: 0,
            });
          }
          out.push({
            _tag: "ToolUse",
            itemId: id,
            tool: block.name,
            input: block.input,
            parentItemId,
          });
        } else if (
          block.type === "thinking" &&
          typeof (block as { thinking?: unknown }).thinking === "string"
        ) {
          // Fallback: if the partial-message deltas didn't deliver
          // anything for this turn (e.g. SDK strips them too), at least
          // emit whatever the assistant message has — even if `thinking`
          // is empty — so a row appears and we know thinking happened.
          const text = (block as { thinking: string }).thinking;
          tlog("assistant.thinking-block", {
            textLen: text.length,
            emittedFromDeltasThisTurn: state.emittedThinkingThisTurn,
            preview: summarize(text),
          });
          if (!state.emittedThinkingThisTurn) {
            state.emittedThinkingThisTurn = true;
            out.push({
              _tag: "Thinking",
              itemId: nextItemId(),
              text,
              redacted: false,
              parentItemId,
            });
          }
        } else if (block.type === "redacted_thinking") {
          tlog("assistant.redacted-thinking-block", {
            emittedFromDeltasThisTurn: state.emittedThinkingThisTurn,
          });
          if (!state.emittedThinkingThisTurn) {
            state.emittedThinkingThisTurn = true;
            out.push({
              _tag: "Thinking",
              itemId: nextItemId(),
              text: "",
              redacted: true,
              parentItemId,
            });
          }
        }
      }
    }
    tlog("assistant.blocks", { types: blockTypes, emitted: out.length });
    return out;
  }
  if (msg.type === "stream_event") {
    const ev = (msg as { event?: unknown }).event as
      | Record<string, unknown>
      | undefined;
    if (ev === undefined || typeof ev.type !== "string") {
      tlog("stream_event.malformed", { event: summarize(ev) });
      return [];
    }
    if (ev.type === "message_start") {
      state.thinkingByIndex.clear();
      state.emittedThinkingThisTurn = false;
      tlog("stream_event.message_start");
      return [];
    }
    if (ev.type === "content_block_start") {
      const index = typeof ev.index === "number" ? ev.index : null;
      const block = ev.content_block as Record<string, unknown> | undefined;
      tlog("stream_event.content_block_start", {
        index,
        blockType: block?.type,
        block: summarize(block),
      });
      if (index === null || block === undefined) return [];
      if (block.type === "thinking") {
        state.thinkingByIndex.set(index, {
          kind: "thinking",
          text: "",
          signatureLength: 0,
        });
      } else if (block.type === "redacted_thinking") {
        state.thinkingByIndex.set(index, {
          kind: "redacted_thinking",
          text: "",
          signatureLength: 0,
        });
      }
      return [];
    }
    if (ev.type === "content_block_delta") {
      const index = typeof ev.index === "number" ? ev.index : null;
      const delta = ev.delta as Record<string, unknown> | undefined;
      if (index === null || delta === undefined) {
        tlog("stream_event.content_block_delta.malformed", {
          index,
          delta: summarize(delta),
        });
        return [];
      }
      const acc = state.thinkingByIndex.get(index);
      if (delta.type === "thinking_delta") {
        const chunk = typeof delta.thinking === "string" ? delta.thinking : "";
        tlog("stream_event.thinking_delta", {
          index,
          chunkLen: chunk.length,
          chunkPreview: summarize(chunk, 80),
          haveAccumulator: acc !== undefined,
        });
        if (acc !== undefined) acc.text += chunk;
      } else if (delta.type === "signature_delta") {
        // signatures confirm thinking happened even when text is empty
        const sig = typeof delta.signature === "string" ? delta.signature : "";
        tlog("stream_event.signature_delta", { index, sigLen: sig.length });
        if (acc !== undefined) acc.signatureLength += sig.length;
      } else if (
        delta.type !== "text_delta" &&
        delta.type !== "input_json_delta"
      ) {
        tlog("stream_event.other_delta", {
          index,
          deltaType: delta.type,
          delta: summarize(delta),
        });
      }
      return [];
    }
    if (ev.type === "content_block_stop") {
      const index = typeof ev.index === "number" ? ev.index : null;
      if (index === null) return [];
      const acc = state.thinkingByIndex.get(index);
      if (acc === undefined) return [];
      state.thinkingByIndex.delete(index);
      tlog("stream_event.content_block_stop[thinking]", {
        index,
        kind: acc.kind,
        textLen: acc.text.length,
        signatureLen: acc.signatureLength,
        textPreview: summarize(acc.text),
      });
      // If the assistant-message path already emitted thinking for this
      // turn (rare ordering: full message arrives before trailing
      // content_block_stop), skip — otherwise we render the same thought
      // twice.
      if (state.emittedThinkingThisTurn) return [];
      if (acc.kind === "redacted_thinking") {
        state.emittedThinkingThisTurn = true;
        return [
          {
            _tag: "Thinking",
            itemId: nextItemId(),
            text: "",
            redacted: true,
            parentItemId,
          },
        ];
      }
      if (acc.text.length > 0) {
        state.emittedThinkingThisTurn = true;
        return [
          {
            _tag: "Thinking",
            itemId: nextItemId(),
            text: acc.text,
            redacted: false,
            parentItemId,
          },
        ];
      }
      // Empty thinking + a non-zero signature still indicates a thought
      // was produced — render the empty placeholder so the user can see
      // it happened. (If signature is also zero, drop silently.)
      if (acc.signatureLength > 0) {
        state.emittedThinkingThisTurn = true;
        return [
          {
            _tag: "Thinking",
            itemId: nextItemId(),
            text: "",
            redacted: false,
            parentItemId,
          },
        ];
      }
      return [];
    }
    return [];
  }
  if (msg.type === "user") {
    // Tool results come back as user messages with tool_result content blocks.
    const out: AgentEvent[] = [];
    const content = msg.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          // Pair to the originating tool_use by the SDK's correlation id;
          // fall back to a fresh id only if the SDK omits it (shouldn't
          // happen for valid tool_result blocks).
          const id =
            typeof (block as { tool_use_id?: unknown }).tool_use_id === "string"
              ? ((block as { tool_use_id: string }).tool_use_id as AgentItemId)
              : nextItemId();
          // Suppress tool_result rows for AskUserQuestion — the answer is
          // already persisted as a `user_question_answer` row via
          // `answerQuestion`. Showing both would double-paint.
          if (state.askUserQuestionIds.has(id as string)) {
            state.askUserQuestionIds.delete(id as string);
            continue;
          }
          // Successful ExitPlanMode → SDK is now in `default` mode.
          // Emit PermissionModeChanged so MessageStore persists the
          // flip and the chip auto-untoggles. We still emit the
          // ToolResult itself so the plan card sees `result` and
          // switches to its "Approved" state.
          if (state.exitPlanModeIds.has(id as string)) {
            state.exitPlanModeIds.delete(id as string);
            if (block.is_error !== true) {
              out.push({
                _tag: "PermissionModeChanged",
                mode: "default",
              });
            }
          }
          out.push({
            _tag: "ToolResult",
            itemId: id,
            output: block.content ?? null,
            isError: block.is_error === true,
            parentItemId,
          });
          // Was this the parent's `Agent` tool_result? Pop a closing
          // SubagentSummary that the wrapper-row footer reads when
          // collapsed. The summary's text is the sub-agent's final
          // assistant message that the SDK packs into `tool_result.content`.
          const pending = state.pendingAgents.get(id as string);
          if (pending !== undefined) {
            state.pendingAgents.delete(id as string);
            out.push({
              _tag: "SubagentSummary",
              itemId: id,
              agentName: pending.agentName,
              model: pending.model,
              turns: pending.turnCount,
              durationMs: Date.now() - pending.startedAt,
              summary: extractTextFromContent(block.content),
              isError: block.is_error === true,
            });
          }
        }
      }
    }
    return out;
  }
  if (msg.type === "result") {
    const out: AgentEvent[] = [];
    // `result` carries usage; emit a UsageDelta tagged with parentItemId
    // when the result belongs to a sub-agent. Cumulative numbers are
    // accumulated renderer-side from the deltas.
    const usage = (msg as { usage?: unknown }).usage as
      | Record<string, unknown>
      | undefined;
    const modelOnResult =
      typeof (msg as unknown as { model?: unknown }).model === "string"
        ? (msg as unknown as { model: string }).model
        : "unknown";
    if (usage !== undefined) {
      const num = (key: string): number => {
        const v = usage[key];
        return typeof v === "number" ? v : 0;
      };
      const compactAfterTokens =
        state.pendingCompact !== null ? num("output_tokens") : 0;
      out.push({
        _tag: "UsageDelta",
        parentItemId,
        inputTokens: num("input_tokens"),
        outputTokens: num("output_tokens"),
        cacheReadTokens: num("cache_read_input_tokens"),
        cacheCreationTokens: num("cache_creation_input_tokens"),
        model: modelOnResult,
      });
      if (state.pendingCompact !== null && compactAfterTokens > 0) {
        state.lastContextUsedTokens = compactAfterTokens;
      }
    }
    // The session-level `result` (no parent_tool_use_id) closes the turn.
    // A sub-agent's `result` does NOT close the parent's turn — the SDK
    // continues running until the parent emits its own top-level result.
    if (parentItemId === undefined) {
      // Emit the exact context occupancy for the turn. The real window
      // comes from `modelUsage[model].contextWindow`; the used tokens are
      // the snapshot stashed from the last top-level assistant message.
      if (state.lastContextUsedTokens !== null) {
        out.push({
          _tag: "ContextUsage",
          providerId: "claude",
          usedTokens: state.lastContextUsedTokens,
          windowTokens: contextWindowFromModelUsage(msg, modelOnResult),
          precision: "exact",
          source: "Claude usage",
        });
      }
      if (state.pendingCompact !== null) {
        out.push(
          finishCompactEvent({
            itemId: state.pendingCompact.itemId,
            providerId: "claude",
            snapshot: state.pendingCompact,
            afterTokens: state.lastContextUsedTokens,
          }),
        );
        state.pendingCompact = null;
      }
      // The user interrupted this turn. The SDK ends it with an
      // `error_during_execution` result, but that's a normal user action — emit
      // a muted `Interrupted` badge + non-error completion instead of an Error
      // bubble, and skip the failed-result handling below.
      if (state.interrupted) {
        out.push({ _tag: "Interrupted" });
        out.push({ _tag: "Completed", reason: "interrupted" });
        state.interrupted = false;
        state.emittedAuthError = false;
        return out;
      }
      // Surface a failed result's text as an Error so it persists + renders
      // (auth failures the SDK reports via the result rather than an assistant
      // block land here). `state.emittedAuthError` dedupes against the
      // assistant-block path above so we don't show the card twice.
      const resultError = claudeResultErrorText(msg);
      if (resultError !== null && !state.emittedAuthError) {
        out.push({ _tag: "Error", message: resultError });
      }
      out.push(
        resultError === null
          ? { _tag: "Completed", reason: "ended" }
          : { _tag: "Completed", reason: "error" },
      );
      // The result closes the top-level turn — reset the per-turn auth dedupe
      // so a later turn that fails auth still surfaces its own card.
      state.emittedAuthError = false;
    }
    return out;
  }
  if ((msg as { type?: unknown }).type === "rate_limit_event") {
    const info = (msg as { rate_limit_info?: ClaudeRateLimitInfo })
      .rate_limit_info;
    return info === undefined ? [] : claudeRateLimitEvents(info);
  }
  return [];
};

export const translateClaudeSdkMessages = (
  messages: ReadonlyArray<SDKMessage>,
): ReadonlyArray<AgentEvent> => {
  const state = newTranslateState();
  return messages.flatMap((message) => translate(message, state));
};

/**
 * Tools the agent can run without a prompt. These are pure reads or
 * internal-state tools (`TodoWrite`) with no observable blast radius. The
 * `Read` exception for sensitive paths is enforced separately in
 * `policyFor` — even read-only tools force a prompt when the target looks
 * like a secret.
 *
 * `ASK_USER_QUESTION_FQN` is here because asking the user a question IS
 * the user-facing prompt — gating it behind a separate "Use tool
 * AskUserQuestion?" toast is double prompting.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "LS",
  "Glob",
  "Grep",
  "NotebookRead",
  "BashOutput",
  "TodoWrite",
  ASK_USER_QUESTION_FQN,
  // Agent browser — navigate / screenshot / snapshot / wait are read-only and
  // fully visible to the user (the page loads in the on-screen webview,
  // screenshots flash a shutter). Auto-allow like Grep/Glob.
  // `browser_click` and `browser_type` are deliberately absent: they mutate
  // page state, so they fall through to the regular permission prompt.
  `mcp__${ZUSE_MCP_NAME}__browser_navigate`,
  `mcp__${ZUSE_MCP_NAME}__browser_screenshot`,
  `mcp__${ZUSE_MCP_NAME}__browser_snapshot`,
  `mcp__${ZUSE_MCP_NAME}__browser_wait`,
  // Read-only / non-mutating browsing: scroll, hover, read text, console,
  // network (pure read of captured request metadata), and history
  // (back/forward/reload — like navigate, which also auto-allows).
  // `browser_select`, `browser_press`, `browser_fill_form`, and
  // `browser_dialog` change page state, so they prompt.
  `mcp__${ZUSE_MCP_NAME}__browser_scroll`,
  `mcp__${ZUSE_MCP_NAME}__browser_hover`,
  `mcp__${ZUSE_MCP_NAME}__browser_read`,
  `mcp__${ZUSE_MCP_NAME}__browser_console`,
  `mcp__${ZUSE_MCP_NAME}__browser_network`,
  `mcp__${ZUSE_MCP_NAME}__browser_history`,
  // Control-plane (orchestration) reads. Inspecting threads/models is
  // non-mutating and visible to the user, so auto-allow like the browser
  // reads. The MUTATING control-plane tools — create_thread, create_session,
  // send_to_thread — are deliberately absent: they spawn real work and must
  // fall through to the permission prompt, which is the approval gate for the
  // `approval-gated` autonomy level.
  `mcp__${ORCHESTRATION_MCP_SERVER_NAME}__read_thread`,
  `mcp__${ORCHESTRATION_MCP_SERVER_NAME}__list_threads`,
  `mcp__${ORCHESTRATION_MCP_SERVER_NAME}__list_models`,
  `mcp__${ORCHESTRATION_MCP_SERVER_NAME}__whoami`,
]);

/**
 * Path patterns that always prompt regardless of any prior `AllowForSession`
 * or `AlwaysAllow` decision. Match anywhere in the path string — agents
 * tend to use absolute paths, so anchoring to a directory boundary catches
 * `~/.ssh/...` and `/path/to/repo/.env` alike.
 */
const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)credentials(\.[^/]+)?$/i,
  /(^|\/)\.aws\//,
  /(^|\/)\.ssh\//,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)\.netrc$/,
  /(^|\/)\.pgpass$/,
];

const isSensitivePath = (p: string): boolean =>
  SENSITIVE_PATTERNS.some((re) => re.test(p));

type ToolPolicy =
  | { readonly kind: "auto-allow" }
  | { readonly kind: "prompt"; readonly forcePrompt: boolean };

const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

const editPathOf = (toolInput: Record<string, unknown>): string =>
  typeof toolInput.file_path === "string"
    ? toolInput.file_path
    : typeof toolInput.notebook_path === "string"
      ? (toolInput.notebook_path as string)
      : "";

/**
 * Decide whether the SDK's tool call needs to bother the user. Layered:
 *
 *   1. Sensitive paths always force a prompt (`forcePrompt: true`) — this is
 *      the safety net that survives every other allow rule, including
 *      `full-access` mode.
 *   2. Read-only tools auto-allow.
 *   3. `auto-accept-edits` mode short-circuits file edits.
 *   4. `full-access` mode short-circuits everything else.
 *   5. Otherwise, prompt.
 */
/**
 * Match every "ask the user a question" surface we know about. The
 * Claude SDK has a built-in `AskUserQuestion` tool (PascalCase) that
 * the model can call; we register our own `mcp__zuse__ask_user_question`
 * to drive a renderer card. Either form should bypass the permission
 * toast — asking permission to ask a question is double-prompting.
 *
 * The SDK built-in is also added to `disallowedTools` below so the
 * model is steered to ours; this matcher is the safety net.
 */
const SDK_BUILTIN_ASK_USER_QUESTION = "AskUserQuestion";

const isAskUserQuestion = (toolName: string): boolean =>
  toolName === ASK_USER_QUESTION_FQN ||
  toolName === ASK_USER_QUESTION_TOOL ||
  toolName === SDK_BUILTIN_ASK_USER_QUESTION ||
  toolName.endsWith(`__${ASK_USER_QUESTION_TOOL}`);

const policyFor = (
  toolName: string,
  toolInput: Record<string, unknown>,
  runtimeMode: RuntimeMode,
): ToolPolicy => {
  // 0a. Plan-mode exit is ALWAYS a user decision. Regardless of runtime
  //     mode — including `full-access` — `ExitPlanMode` must surface the
  //     Approve / Cancel card in the renderer. Without `forcePrompt: true`
  //     a prior `AllowForSession` could silence it, and without putting
  //     this branch ahead of every other auto-allow `full-access` would
  //     short-circuit the prompt entirely.
  if (toolName === "ExitPlanMode") {
    return { kind: "prompt", forcePrompt: true };
  }
  // 0b. Our own AskUserQuestion is the user-facing prompt — gating it
  //     behind a separate "Use tool AskUserQuestion?" toast is double
  //     prompting. Always auto-allow.
  if (isAskUserQuestion(toolName)) {
    return { kind: "auto-allow" };
  }
  // 0b. Agent browser login submits saved (dummy) credentials into a page.
  //     Always prompt, even in full-access mode — a login attempt should
  //     never fire silently. Treated like a sensitive path.
  if (toolName.endsWith("__browser_login")) {
    return { kind: "prompt", forcePrompt: true };
  }
  // 1. Sensitive paths — checked before any auto-allow. Even YOLO mode prompts.
  if (toolName === "Read") {
    const path =
      typeof toolInput.file_path === "string" ? toolInput.file_path : "";
    if (path.length > 0 && isSensitivePath(path)) {
      return { kind: "prompt", forcePrompt: true };
    }
  }
  if (FILE_EDIT_TOOLS.has(toolName)) {
    const path = editPathOf(toolInput);
    if (path.length > 0 && isSensitivePath(path)) {
      return { kind: "prompt", forcePrompt: true };
    }
  }

  // 2. Read-only tools — always free, regardless of mode.
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { kind: "auto-allow" };
  }

  // 3. auto-accept-edits — file edits skip the prompt; everything else falls
  //    through to the regular prompt flow.
  if (runtimeMode === "auto-accept-edits" && FILE_EDIT_TOOLS.has(toolName)) {
    return { kind: "auto-allow" };
  }

  // 3b. auto-accept-edits-and-bash — file edits AND Bash auto-allow;
  //     WebFetch / WebSearch / MCP / Other still prompt.
  if (runtimeMode === "auto-accept-edits-and-bash") {
    if (FILE_EDIT_TOOLS.has(toolName)) return { kind: "auto-allow" };
    if (toolName === "Bash") return { kind: "auto-allow" };
  }

  // 4. full-access — auto-allow anything that survived the sensitive-path
  //    + plan-mode checks above.
  if (runtimeMode === "full-access") {
    return { kind: "auto-allow" };
  }

  return { kind: "prompt", forcePrompt: false };
};

/**
 * Map a Claude SDK tool invocation onto a wire `PermissionKind`. Tools we
 * don't classify drop into `Other`; the server treats those as auto-allow
 * for now (logged) so the agent loop isn't stalled by every internal `Read`
 * or `Glob`. Adding a classification is a one-line change here.
 */
const kindForTool = (
  toolName: string,
  toolInput: Record<string, unknown>,
): PermissionKind => {
  switch (toolName) {
    case "Bash": {
      const command =
        typeof toolInput.command === "string"
          ? toolInput.command
          : JSON.stringify(toolInput);
      return { _tag: "Bash", command };
    }
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit": {
      const path =
        typeof toolInput.file_path === "string"
          ? toolInput.file_path
          : typeof toolInput.notebook_path === "string"
            ? (toolInput.notebook_path as string)
            : "(unknown)";
      return { _tag: "FileWrite", path };
    }
    case "WebFetch":
    case "WebSearch": {
      const url =
        typeof toolInput.url === "string"
          ? toolInput.url
          : typeof toolInput.query === "string"
            ? `search:${toolInput.query as string}`
            : "(unknown)";
      return { _tag: "Network", url };
    }
    default: {
      const summary = JSON.stringify(toolInput).slice(0, 120);
      return { _tag: "Other", tool: toolName, summary };
    }
  }
};

/**
 * Hook the driver passes into the SDK's `canUseTool`. Returning a
 * `PermissionDecision` lets the orchestrator (`ProviderService`) plug
 * `PermissionService.request` in directly without the driver reaching
 * across modules. `forcePrompt` flows through to the broker so sensitive
 * paths can't be silenced by prior `AllowForSession` / `AlwaysAllow` rows.
 */
export type RequestPermission = (
  sessionId: AgentSessionId,
  kind: PermissionKind,
  options: { readonly forcePrompt: boolean },
) => Promise<PermissionDecision>;

/**
 * Resolve the SDK `effort` field and the per-session `settings` slice from
 * the FE picker's `modelOptions`:
 *   - `ultracode`  → `effort: "xhigh"` + `settings.ultracode: true`
 *   - `ultrathink` → prompt-injected (driver-side prefix added at send()
 *                    time); SDK `effort` stays unset so the model still
 *                    uses its default tier.
 *   - `low | medium | high | xhigh | max` pass straight through, clamped
 *     by what the SDK type accepts.
 *   - Anything else (or missing) falls back to `"high"`.
 *
 * `fastMode` (Opus only) and `thinking` (Haiku 4.5) ride on `settings`.
 *
 * The returned object is spread into the `Options` literal so omitted
 * fields don't override SDK defaults.
 */
type ClaudeSdkEffort = "low" | "medium" | "high" | "xhigh" | "max";
type EffortAndSettings = {
  effort?: ClaudeSdkEffort;
  settings?: Record<string, unknown>;
};
const effortAndSettings = (
  modelOptions: Readonly<Record<string, string>> | undefined,
): EffortAndSettings => {
  const raw =
    modelOptions?.["effort"] ?? modelOptions?.["reasoning"] ?? undefined;
  const ultracode = raw === "ultracode";
  const ultrathink = raw === "ultrathink";
  const sdkEffort: ClaudeSdkEffort | undefined = (() => {
    if (ultrathink) return undefined; // prompt-injected; no SDK knob
    if (ultracode) return "xhigh"; // Claude Code preset → xhigh + ultracode flag
    if (
      raw === "low" ||
      raw === "medium" ||
      raw === "high" ||
      raw === "xhigh" ||
      raw === "max"
    ) {
      return raw;
    }
    return "high";
  })();

  const settings: Record<string, unknown> = {};
  if (ultracode) settings["ultracode"] = true;
  if (modelOptions?.["fastMode"] === "true") settings["fastMode"] = true;
  if (modelOptions?.["thinking"] === "true") {
    settings["alwaysThinkingEnabled"] = true;
  } else if (modelOptions?.["thinking"] === "false") {
    settings["alwaysThinkingEnabled"] = false;
  }

  return {
    ...(sdkEffort !== undefined ? { effort: sdkEffort } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
};

/**
 * If the user's effort selection is `ultrathink`, prepend the literal word
 * to the prompt and unset the SDK effort knob. Driver hooks call this before
 * forwarding the user's text to the SDK.
 */
export const applyUltrathinkPrefix = (
  modelOptions: Readonly<Record<string, string>> | undefined,
  text: string,
): string => {
  const raw =
    modelOptions?.["effort"] ?? modelOptions?.["reasoning"] ?? undefined;
  return raw === "ultrathink" ? `ultrathink\n\n${text}` : text;
};

/**
 * Spin up a streaming-input Claude conversation. The SDK is driven by an
 * AsyncIterable we push into from `send()`; the SDK's outbound async generator
 * is consumed by a forked daemon that translates messages into wire events
 * and offers them to the per-session mailbox.
 *
 * `apiKey` is the keychain-stored API key, if any. When non-null we set
 * `ANTHROPIC_API_KEY` on the spawned `claude` subprocess. When null we omit
 * the SDK's `env` option entirely so `process.env` is inherited — that lets
 * the spawned `claude` CLI find its own OAuth credentials (macOS keychain
 * entry "Claude Code-credentials" or `~/.claude/.credentials.json`). This
 * is the primary auth path; API keys are a fallback.
 *
 * `requestPermission` is the bridge to `PermissionService`. It returns a
 * decision the caller honors via the SDK's allow/deny contract; the driver
 * itself stays free of any DB or PubSub wiring.
 */
/**
 * Live read of the per-session runtime mode. Called inside `canUseTool` so
 * the user toggling the chat header takes effect on the next tool call —
 * no SDK restart needed.
 */
export type GetRuntimeMode = () => RuntimeMode;

export const startClaudeSession = (
  input: StartSessionInput,
  cwd: string,
  apiKey: string | null,
  claudeExecutablePath: string | null,
  sessionId: AgentSessionId,
  requestPermission: RequestPermission,
  getRuntimeMode: GetRuntimeMode,
  resumeCursor: string | null = null,
  // Extra MCP tools to register inside the in-process zuse MCP server. Tools
  // arrive already bound to their session-specific backing service, so the
  // driver itself stays path-agnostic. Typed loosely because the SDK's
  // `SdkMcpToolDefinition` is parameterized by each tool's zod schema and
  // doesn't compose across distinct shapes in an array.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraTools: ReadonlyArray<any> = [],
  // Provider-neutral orchestration tools are intentionally registered under a
  // separate server name (`zuse-orchestration`) so Claude, Codex, and Grok see
  // the same MCP surface and smoke-test instructions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orchestrationTools: ReadonlyArray<any> = [],
): Effect.Effect<
  ClaudeSessionHandle,
  AgentSessionStartError,
  AttachmentService
> =>
  Effect.gen(function* () {
    const attachments = yield* AttachmentService;
    const events = yield* Queue.make<AgentEvent, Cause.Done>();
    const inputChannel = new UserInputChannel();
    const abort = new AbortController();

    const buildAttachmentBlocks = (
      refs: ReadonlyArray<AttachmentRef>,
    ): Promise<ReadonlyArray<UserContentBlock>> =>
      Promise.all(
        refs.map(async (ref): Promise<UserContentBlock | null> => {
          if (ref.id.startsWith("pending-")) {
            console.warn(
              `[claude.attach] skipping pending attachment id=${ref.id} (upload didn't finish before send)`,
            );
            return null;
          }
          // Browsers report "image/jpg" sometimes — Anthropic only accepts
          // the canonical "image/jpeg" name.
          const normalizedMime =
            ref.mimeType.toLowerCase() === "image/jpg"
              ? "image/jpeg"
              : ref.mimeType.toLowerCase();
          const isImage = SUPPORTED_IMAGE_MIME.has(normalizedMime);
          const isPdf = normalizedMime === "application/pdf";
          if (!isImage && !isPdf) {
            console.warn(
              `[claude.attach] dropping unsupported mime id=${ref.id} mime=${ref.mimeType}`,
            );
            return null;
          }
          const blob = await Effect.runPromise(attachments.read(ref.id));
          if (blob === null) {
            console.warn(
              `[claude.attach] blob not found id=${ref.id} (db row missing or file deleted)`,
            );
            return null;
          }
          const base64 = Buffer.from(blob.bytes).toString("base64");
          console.log(
            `[claude.attach] built ${
              isPdf ? "document" : "image"
            } block id=${ref.id} mime=${normalizedMime} bytes=${blob.bytes.byteLength} base64Len=${base64.length}`,
          );
          if (isPdf) {
            return {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: base64,
              },
              title: ref.originalName,
            };
          }
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: normalizedMime as AnthropicImageMediaType,
              data: base64,
            },
          };
        }),
      ).then((blocks) =>
        blocks.filter((b): b is NonNullable<typeof b> => b !== null),
      );

    if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
      inputChannel.push(userMessageOf(input.initialPrompt, sessionId));
    }

    // Pass `process.env` through, but scrub any "we are inside another
    // Claude Code session" markers that Claude Code injects into its child
    // shells. When memoize is launched from a Claude Code terminal (very
    // common during dev), the shell inherits CLAUDECODE=1,
    // CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_EXECPATH, and friends — which
    // confuses the spawned `claude` binary's auth resolver into thinking
    // it's a nested SDK call from a different Claude installation, and the
    // `EXECPATH` even redirects to a sibling app's bundled binary with its
    // own auth state. The result is "Invalid API key · Fix external API
    // key" even with a perfectly valid `claude /login`.
    //
    // The SDK adds back its own `CLAUDE_CODE_ENTRYPOINT="sdk-ts"` for
    // telemetry purposes (we read it back in error messages); that's fine
    // because it lets the binary know IT is the SDK process, not its parent.
    //
    // `pathToClaudeCodeExecutable` points at the user's globally-installed
    // `claude`. Without it, the SDK falls back to its bundled native CLI —
    // shipped as an optional native dep that doesn't always install (yields
    // "Native CLI binary for darwin-arm64 not found").
    // Shared driver-side state. Lives outside `options` so the pump (which
    // calls `translate`) and the `canUseTool` callback see the same map of
    // pending Agent invocations and the same `latestParentItemId`. Built
    // here, populated by `translate`, read by `canUseTool`.
    const translateState = newTranslateState();

    /**
     * Outstanding `AskUserQuestion` calls. Keyed by the MCP tool's
     * generated itemId (= the `tool_use.id` the model emitted) so the
     * renderer's `answerQuestion(itemId, …)` resolves the right one.
     * Resolves with the answers (which our handler returns as the tool
     * result) or with `null` for cancellation (the SDK turn unwinds
     * with an `is_error: true` row).
     */
    type QuestionResolver = (
      answers: ReadonlyArray<UserQuestionAnswer> | null,
    ) => void;
    const pendingQuestions = new Map<string, QuestionResolver>();

    /**
     * Map from question `itemId` → its `tool_use.id` if known. The MCP
     * SDK doesn't pass the tool_use_id into our handler, so we mint our
     * own id and surface it on the `UserQuestion` event. The handle's
     * `answerQuestion` then looks the id up here. (The SDK's translator
     * sees the underlying `tool_use.id` separately and uses *that* to
     * suppress the matching tool_result row — see
     * `state.askUserQuestionIds`.)
     */
    const askUserQuestionToolDefinition = tool(
      ASK_USER_QUESTION_TOOL,
      "Ask the user a structured multiple-choice question, with optional 'Other' free-text. Use when implementation requires a decision the agent cannot infer from context (preferred direction, taste call, scope cut). Each question carries `options[]` the user picks from; the renderer always offers an additional 'Other' free-text field — never include 'Other' in `options`.",
      {
        questions: z
          .array(
            z.object({
              question: z.string(),
              options: z.array(z.string()),
              multiSelect: z.boolean().optional(),
            }),
          )
          .min(1),
      },
      async (args) => {
        const itemId = nextItemId();
        const userQuestions: ReadonlyArray<UserQuestion> = args.questions.map(
          (q) => ({
            question: q.question,
            options: q.options,
            ...(q.multiSelect !== undefined
              ? { multiSelect: q.multiSelect }
              : {}),
          }),
        );
        Queue.offerUnsafe(events, {
          _tag: "UserQuestion",
          itemId,
          questions: userQuestions,
          parentItemId: translateState.latestParentItemId,
        });
        const answers =
          await new Promise<ReadonlyArray<UserQuestionAnswer> | null>(
            (resolve) => {
              pendingQuestions.set(itemId, resolve);
            },
          );
        if (answers === null) {
          return {
            content: [
              {
                type: "text",
                text: "User cancelled the question.",
              },
            ],
            isError: true,
          };
        }
        // Render the answers compactly for the model. Per question:
        //   - "Q: <text> → <selected option labels>" if any options picked
        //   - "  (other: <free text>)" appended if free-text given
        // The structured JSON is included too for unambiguous parsing.
        const lines: string[] = [];
        for (const a of answers) {
          const q = userQuestions[a.questionIndex];
          if (q === undefined) continue;
          const picks = a.selected.map((i) => q.options[i] ?? `#${i}`);
          const head = picks.length > 0 ? picks.join(", ") : "(no preset)";
          lines.push(`Q: ${q.question}\nA: ${head}`);
          if (typeof a.other === "string" && a.other.length > 0) {
            lines.push(`  (other: ${a.other})`);
          }
        }
        return {
          content: [
            { type: "text", text: lines.join("\n\n") },
            { type: "text", text: JSON.stringify({ answers }) },
          ],
        };
      },
      { alwaysLoad: true },
    );

    const memoizeMcpServer = createSdkMcpServer({
      name: ZUSE_MCP_NAME,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [askUserQuestionToolDefinition, ...extraTools] as any,
      alwaysLoad: !(input.toolSearch ?? false),
    });
    const orchestrationMcpServer =
      orchestrationTools.length === 0
        ? null
        : createSdkMcpServer({
            name: ORCHESTRATION_MCP_SERVER_NAME,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            tools: orchestrationTools as any,
            alwaysLoad: !(input.toolSearch ?? false),
          });

    const env = applyClaudeWorktreeEnv(
      scrubInheritedClaudeMarkers(process.env),
      cwd,
    );
    if (apiKey !== null) env.ANTHROPIC_API_KEY = apiKey;
    // Sub-agent map → SDK Options.agents. When at least one preset is
    // present and the master toggle is on, also add `Agent` to
    // allowedTools so the model can actually call it. Sessions without
    // sub-agents leave allowedTools alone and behave identically to the
    // pre-feature path.
    const agentsMap = input.agents ?? {};
    const subagentsEffective =
      (input.enableSubagents ?? Object.keys(agentsMap).length > 0) &&
      Object.keys(agentsMap).length > 0;
    // `allowedTools` is a strict allow-list when set: anything not listed
    // gets disallowed. So when sub-agents are on we must also list our
    // in-process AskUserQuestion tool by its fully-qualified name.
    const subagentOptions = subagentsEffective
      ? ({
          agents: agentsMap,
          allowedTools: [
            "Agent",
            ASK_USER_QUESTION_FQN,
            ...ORCHESTRATION_TOOL_FQNS,
          ],
        } as Pick<Options, "agents" | "allowedTools">)
      : {};
    // The SDK ships a built-in `AskUserQuestion` tool that opens its
    // own dialog flow. We disable it so the model is steered to our
    // MCP version, which the renderer paints as the question card in
    // the composer slot. Without this, the model would default to the
    // built-in (it has a nicer name) and trigger the permission toast
    // for every question.
    const disallowedTools: ReadonlyArray<string> = [
      SDK_BUILTIN_ASK_USER_QUESTION,
    ];
    const initialPermissionMode = input.permissionMode ?? "default";
    const initialSdkPermissionMode = runtimeModeToSdkPermissionMode(
      getRuntimeMode(),
      initialPermissionMode,
    );
    const options: Options = {
      cwd,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: [input.workspaceInstructions, claudeWorktreePrompt(cwd)]
          .filter((part): part is string => part !== undefined)
          .join("\n\n"),
      },
      abortController: abort,
      ...(claudeExecutablePath !== null
        ? { pathToClaudeCodeExecutable: claudeExecutablePath }
        : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...subagentOptions,
      disallowedTools: [
        ...(subagentOptions.allowedTools === undefined
          ? disallowedTools
          : disallowedTools.filter(
              (t) => !subagentOptions.allowedTools!.includes(t),
            )),
      ],
      mcpServers: {
        [ZUSE_MCP_NAME]: memoizeMcpServer,
        ...(orchestrationMcpServer === null
          ? {}
          : { [ORCHESTRATION_MCP_SERVER_NAME]: orchestrationMcpServer }),
      },
      permissionMode: initialSdkPermissionMode,
      ...(initialSdkPermissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      // Trim the SDK's stock plan-mode body to nudge the agent toward
      // memoize's two structured-interaction tools. The SDK still wraps
      // this with its read-only enforcement preamble + ExitPlanMode
      // protocol footer.
      planModeInstructions: [
        "Phase 1 — Explore. Use only read-only tools (Read, Glob, Grep).",
        "Phase 2 — Track. Maintain a TodoWrite list as you discover work; keep it crisp.",
        `Phase 3 — Ask. When a real fork in the road exists (which library, which scope, which approach), call ${ASK_USER_QUESTION_FQN} with the choices instead of guessing.`,
        "Phase 4 — Propose. Call ExitPlanMode with a concise plan: what changes, where, and how to verify.",
      ].join("\n"),
      // Reasoning effort: mapped from FE picker via `input.modelOptions
      // .effort` (or legacy `reasoning`). The per-model descriptor in
      // `MODELS_BY_PROVIDER[claude]` declares which tiers each model
      // exposes. Special values:
      //   - `ultracode`  → SDK `effort: "xhigh"` + `settings.ultracode: true`
      //   - `ultrathink` → prompt-injected at `send()` time; SDK `effort`
      //                    stays unset.
      // Falls back to "high" when omitted.
      //
      // We pair it with an explicit `display: "summarized"` because Opus
      // 4.7 defaults the adaptive-thinking display to "omitted" — without
      // this override our `thinking_delta` chunks arrive empty (only
      // signatures), which would break the streaming thinking UI. Other
      // Claude 4 models default to "summarized" so this is a no-op for
      // them.
      ...effortAndSettings(input.modelOptions),
      thinking: { type: "adaptive", display: "summarized" },
      forwardSubagentText: true,
      // Surfaces thinking deltas in the partial-message stream so we
      // can render thinking as it streams in.
      includePartialMessages: true,
      env: env as Options["env"],
      // Bridge the SDK's permission callback to the server-side
      // `PermissionService`. The renderer's toast eventually fulfills the
      // promise this awaits.
      canUseTool: async (toolName, toolInput) => {
        const policy = policyFor(toolName, toolInput, getRuntimeMode());
        // One-line debug so if the auto-allow ever misses (e.g. SDK
        // changes the MCP-tool naming convention) we can see the
        // exact toolName arriving and patch `isAskUserQuestion`.
        // eslint-disable-next-line no-console
        console.log(
          `[claude.canUseTool] tool=${toolName} policy=${policy.kind}`,
        );
        if (policy.kind === "auto-allow") {
          // Read / LS / Glob / Grep / NotebookRead / BashOutput / TodoWrite
          // skip the prompt entirely. We deliberately don't surface a
          // `PermissionRequest` event for these — the timeline already
          // shows the underlying `tool_use`, and a second "I asked for
          // permission and was given it" row would be pure noise.
          return { behavior: "allow", updatedInput: toolInput };
        }
        const kind = kindForTool(toolName, toolInput);
        Queue.offerUnsafe(events, {
          _tag: "PermissionRequest",
          itemId: nextItemId(),
          kind: toolName,
          details: toolInput,
          // Best-effort attribution. SDK's `canUseTool` callback doesn't
          // include `parent_tool_use_id`, so we tag with the most recent
          // value seen on an SDK message. Sub-agents currently run
          // serially in the SDK; if that changes, this attribution races.
          parentItemId: translateState.latestParentItemId,
        });
        const decision = await requestPermission(sessionId, kind, {
          forcePrompt: policy.forcePrompt,
        });
        if (decision._tag === "Deny") {
          return {
            behavior: "deny",
            message: "User denied this tool call.",
          };
        }
        // AllowOnce / AllowForSession / AlwaysAllow → allow. The session
        // and folder scopes are enforced server-side: a second request
        // with the same (sessionId|projectId, kindKey) short-circuits to
        // AllowOnce without prompting (unless `forcePrompt` is set).
        return { behavior: "allow", updatedInput: toolInput };
      },
    };

    Queue.offerUnsafe(events, {
      _tag: "Started",
      sessionId,
      providerId: "claude",
      mode: "sdk",
    });

    // If the caller has a resume cursor, hand it to the SDK before opening
    // the conversation. When `forkFromResume` is set (the "Fork chat"
    // feature), also pass `forkSession: true` so the SDK branches the resumed
    // transcript into a NEW session_id — the source session's transcript is
    // left untouched and both can run independently.
    if (resumeCursor !== null) {
      options.resume = resumeCursor;
      if (input.forkFromResume === true) {
        options.forkSession = true;
      }
    }

    let q: Query;
    try {
      q = query({ prompt: inputChannel, options });
    } catch (cause) {
      yield* Queue.end(events);
      return yield* Effect.fail(
        new AgentSessionStartError({
          providerId: "claude",
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }

    // Pump SDK messages → AgentEvents in a forked daemon. Sessions outlive the
    // start RPC; `close()` is what ends the pump (input close + abort, which
    // makes the SDK loop terminate). On the first message that has a
    // populated `session_id` we surface it as `SessionCursor` so MessageStore
    // can persist it for resume.
    let cursorAnnounced = false;
    const pump = Effect.tryPromise({
      try: async () => {
        for await (const msg of q) {
          if (!cursorAnnounced) {
            const sid = (msg as { session_id?: unknown }).session_id;
            if (typeof sid === "string" && sid.length > 0) {
              cursorAnnounced = true;
              Queue.offerUnsafe(events, {
                _tag: "SessionCursor",
                cursor: sid,
                strategy: "claude-session-id",
              });
            }
          }
          const translated = translate(msg, translateState);
          for (const ev of translated) {
            Queue.offerUnsafe(events, ev);
          }
        }
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          // If the SDK threw out of the `for await` because the user
          // interrupted (rather than yielding an `error_during_execution`
          // result), surface the muted interrupted badge, not an error. Emit a
          // non-error completion too so the turn isn't left pinned at running.
          if (translateState.interrupted) {
            translateState.interrupted = false;
            Queue.offerUnsafe(events, { _tag: "Interrupted" });
            Queue.offerUnsafe(events, { _tag: "Completed", reason: "interrupted" });
            return;
          }
          Queue.offerUnsafe(events, {
            _tag: "Error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }),
      ),
      Effect.ensuring(Queue.end(events)),
    );

    yield* Effect.forkDetach(pump);

    const handle: ClaudeSessionHandle = {
      events: Stream.fromQueue(events),
      send: (text, attachmentRefs) =>
        Effect.promise(async () => {
          const compactCommand = isCompactCommand(text);
          if (compactCommand) {
            translateState.pendingCompact = startCompactSnapshot(
              translateState.lastContextUsedTokens,
            );
            Queue.offerUnsafe(events,
              startCompactEvent({
                providerId: "claude",
                snapshot: translateState.pendingCompact,
              }),
            );
          }
          // Ultrathink is the only `effort` tier that's not forwarded to
          // the SDK as a knob — instead the literal word `"ultrathink"` is
          // prepended to the user's prompt. The session-level modelOptions
          // were captured at start() so we can apply the prefix here.
          const promptText = compactCommand
            ? text.trim()
            : applyUltrathinkPrefix(input.modelOptions, text);
          console.log(
            `[claude.send] sessionId=${sessionId} textLen=${promptText.length} attachments=${attachmentRefs?.length ?? 0}`,
          );
          const attachmentBlocks =
            attachmentRefs !== undefined && attachmentRefs.length > 0
              ? await buildAttachmentBlocks(attachmentRefs)
              : [];
          console.log(
            `[claude.send] pushing user message: attachmentBlocks=${attachmentBlocks.length} content=${JSON.stringify(
              [
                ...attachmentBlocks.map((b) =>
                  b.type === "text"
                    ? { type: "text", textLen: b.text.length }
                    : {
                        type: b.type,
                        media_type: b.source.media_type,
                        base64Len: b.source.data.length,
                      },
                ),
                { type: "text", textLen: promptText.length },
              ],
            )}`,
          );
          inputChannel.push(
            userMessageOf(promptText, sessionId, attachmentBlocks),
          );
        }),
      interrupt: () =>
        Effect.sync(() => {
          // Mark the turn as interrupted so the terminal `result`
          // (`error_during_execution`) is translated into an `Interrupted`
          // badge instead of an error bubble.
          translateState.interrupted = true;
        }).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () => q.interrupt(),
              catch: (cause) => cause,
            }),
          ),
          Effect.catch(() => Effect.void),
        ),
      close: () =>
        Effect.sync(() => {
          // Unblock any in-flight AskUserQuestion calls so the SDK turn
          // can unwind cleanly instead of leaking the MCP handler's
          // pending Promise.
          for (const resolve of pendingQuestions.values()) resolve(null);
          pendingQuestions.clear();
          inputChannel.close();
          abort.abort();
        }),
      setPermissionMode: (mode) =>
        Effect.tryPromise({
          try: () => q.setPermissionMode(toSdkPermissionMode(mode)),
          catch: (cause) => cause,
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              Queue.offerUnsafe(events, { _tag: "PermissionModeChanged", mode });
            }),
          ),
          Effect.catch(() => Effect.void),
        ),
      answerQuestion: (itemId, answers) =>
        Effect.sync(() => {
          const resolve = pendingQuestions.get(itemId as string);
          if (resolve === undefined) return;
          pendingQuestions.delete(itemId as string);
          resolve(answers);
        }),
    };
    return handle;
  });
