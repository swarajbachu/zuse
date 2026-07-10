import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Queue, Stream } from "effect";

import {
  AgentSessionStartError,
  type AgentEvent,
  type AgentItemId,
  type AgentSessionId,
  type AttachmentRef,
  type OpencodeCustomProvider,
  type OpencodeInventory,
  type OpencodeInventoryAgent,
  type OpencodeInventoryProvider,
  type PermissionMode,
  type StartSessionInput,
  type UserQuestionAnswer,
} from "@zuse/wire";

import {
  createOpencodeClient,
  type Agent as SdkAgent,
  type Event as SdkEvent,
  type Part as SdkPart,
  type ToolPart as SdkToolPart,
} from "@opencode-ai/sdk";

import { AttachmentService } from "../../attachment/services/attachment-service.ts";
import {
  finishCompactEvent,
  isCompactCommand,
  startCompactEvent,
  startCompactSnapshot,
} from "./compact.ts";
import { prefixFirstPromptWithWorkspaceInstructions } from "../workspace-instructions.ts";

/**
 * Live handle for one OpenCode conversation. Mirrors the other driver
 * handles so `ProviderService` routes RPCs uniformly.
 *
 * Transport is HTTP — we spawn `opencode serve` as a local subprocess and
 * talk to it via `@opencode-ai/sdk`. The conversation is identified by an
 * opencode-minted session id returned from `session.create`; we surface
 * that as `SessionCursor { strategy: "opencode-session-id" }`.
 *
 * "Mode" in opencode = the named **agent** (build, plan, or any custom
 * `~/.config/opencode/agent/*.json`). The agent the renderer picks comes
 * through on `input.modelOptions.agent`; we default to "plan" when
 * `permissionMode === "plan"` and otherwise "build" to match the
 * upstream defaults.
 *
 * `input.model` is expected as the `<providerID>/<modelID>` slug exposed
 * by `agent.opencodeInventory` (e.g. `anthropic/claude-sonnet-4-5`). The
 * driver splits on the first `/` and feeds the two halves to
 * `client.session.prompt({ model: { providerID, modelID } })`. A plain id
 * without a slash falls back to the user's connected default provider.
 */
export interface OpencodeSessionHandle {
  readonly events: Stream.Stream<AgentEvent>;
  readonly send: (
    text: string,
    attachments?: ReadonlyArray<AttachmentRef>,
  ) => Effect.Effect<void>;
  readonly interrupt: () => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Effect.Effect<void>;
  readonly answerQuestion: (
    itemId: AgentItemId,
    answers: ReadonlyArray<UserQuestionAnswer>,
  ) => Effect.Effect<void>;
}

// Default off — set MEMOIZE_DEBUG_OPENCODE=1 to re-enable when debugging
// opencode server boot, SSE, or auth issues.
const OPENCODE_DEBUG = process.env.MEMOIZE_DEBUG_OPENCODE === "1";

// Tee all debug to a file so bun's dev-server stdout multiplexing
// doesn't swallow the trace. Path is logged at startup.
const LOG_PATH = ((): string => {
  try {
    const base = process.env.HOME ? homedir() : tmpdir();
    const dir = join(base, ".cache", "zuse");
    mkdirSync(dir, { recursive: true });
    return join(dir, "opencode.log");
  } catch {
    return join(tmpdir(), "zuse-opencode.log");
  }
})();

const writeLog = (line: string): void => {
  process.stderr.write(line);
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    // ignore — file logging is best-effort
  }
};

const dlog = (msg: string): void => {
  if (OPENCODE_DEBUG) writeLog(`[opencode] ${msg}\n`);
};

// Truncated JSON dump for noisy payloads (parts, events). Keeps stderr
// readable when a tool input contains a 50KB file blob.
const ddump = (label: string, value: unknown, maxLen = 2000): void => {
  if (!OPENCODE_DEBUG) return;
  let json: string;
  try {
    json = JSON.stringify(value, (_, v) =>
      typeof v === "string" && v.length > 600 ? `${v.slice(0, 600)}…` : v,
    );
  } catch {
    json = String(value);
  }
  if (json.length > maxLen) json = `${json.slice(0, maxLen)}…(${json.length}B)`;
  writeLog(`[opencode] ${label} ${json}\n`);
};

if (OPENCODE_DEBUG) {
  writeLog(`\n[opencode] ==== driver loaded; logs at ${LOG_PATH} ====\n`);
}

const OPENCODE_EMPTY_CONFIG = "{}";

/**
 * Resolve opencode's global `auth.json` — the same file `opencode auth login`
 * writes, so credentials we manage in-app are shared with the user's terminal
 * opencode. Honours `XDG_DATA_HOME`, else the platform default.
 */
const opencodeAuthPath = (): string => {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode", "auth.json");
};

/**
 * Build the `OPENCODE_CONFIG_CONTENT` JSON handed to `opencode serve`. It
 * injects the user's custom OpenAI-compatible providers so both inventory
 * scans and live sessions see them. API keys are deliberately NOT included
 * here — opencode reads them from its own `auth.json` (written via
 * `auth.set`), keyed by provider id. Returns `"{}"` when there are no custom
 * providers, preserving the original behaviour.
 */
const buildOpencodeConfigContent = (
  customProviders: ReadonlyArray<OpencodeCustomProvider>,
): string => {
  if (customProviders.length === 0) return OPENCODE_EMPTY_CONFIG;
  const provider: Record<string, unknown> = {};
  for (const p of customProviders) {
    const models: Record<string, { name: string }> = {};
    for (const m of p.models) models[m.id] = { name: m.name };
    provider[p.id] = {
      name: p.name,
      npm: p.npm.length > 0 ? p.npm : "@ai-sdk/openai-compatible",
      options: { baseURL: p.baseURL },
      models,
    };
  }
  return JSON.stringify({ provider });
};

type OpencodeClient = ReturnType<typeof createOpencodeClient>;

// stdout marker the opencode server prints once it's bound to the port. We
// grep for either the
// human-readable line or any naked URL on a line by itself so future
// server message tweaks don't break the handshake.
const SERVER_READY_REGEX = /(https?:\/\/[^\s]+)/;

/**
 * Grab a free TCP port. We bind to port 0, read the kernel-assigned port,
 * close the socket, and hand the number to `opencode serve`. A tiny race
 * window remains (another process could grab the port between our close
 * and opencode's bind); the worst case is a clean spawn error we surface as
 * `AgentSessionStartError`.
 */
const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a free port for opencode serve"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });

interface OpencodeServerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly url: string;
}

/**
 * Spawn `opencode serve` on a fresh local port and wait for the URL it
 * prints to stdout. Resolves with the running child + the resolved URL.
 * Caller owns the child — call `child.kill("SIGTERM")` (or close stdin)
 * to tear it down.
 */
const spawnOpencodeServer = (
  opencodePath: string,
  cwd: string,
  configContent: string = OPENCODE_EMPTY_CONFIG,
  timeoutMs = 10_000,
): Promise<OpencodeServerProcess> =>
  // eslint-disable-next-line no-async-promise-executor
  new Promise<OpencodeServerProcess>(async (resolve, reject) => {
    let port: number;
    try {
      port = await findFreePort();
    } catch (err) {
      reject(err);
      return;
    }

    const args = ["serve", `--hostname=127.0.0.1`, `--port=${port}`];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(opencodePath, args, {
        cwd,
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: configContent,
        },
        // Detach so SIGTERM can take down the whole process group on Unix.
        // On Windows we leave the default — `child.kill` walks the tree.
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (cause) {
      reject(cause);
      return;
    }

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore — child may already be gone
      }
      const stderrTail = stderrBuf.trim().slice(-512);
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for opencode serve to start` +
            (stderrTail.length > 0 ? ` — stderr: ${stderrTail}` : ""),
        ),
      );
    }, timeoutMs);

    const onStdout = (chunk: string): void => {
      stdoutBuf += chunk;
      if (OPENCODE_DEBUG) process.stderr.write(`[opencode.stdout] ${chunk}`);
      if (settled) return;
      const match = stdoutBuf.match(SERVER_READY_REGEX);
      if (match !== null) {
        settled = true;
        clearTimeout(timer);
        child.stdout.off("data", onStdout);
        resolve({ child, url: match[1]! });
      }
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", (chunk: string) => {
      stderrBuf = (stderrBuf + chunk).slice(-4096);
      if (OPENCODE_DEBUG) process.stderr.write(`[opencode.stderr] ${chunk}`);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderrTail = stderrBuf.trim().slice(-512);
      reject(
        new Error(
          `opencode serve exited before ready (code ${code ?? "null"}, signal ${signal ?? "null"})` +
            (stderrTail.length > 0 ? ` — stderr: ${stderrTail}` : ""),
        ),
      );
    });
  });

/**
 * Split `<providerID>/<modelID>` slugs into the two halves the SDK wants.
 * Inventory ids always carry the prefix; user-typed bare ids return
 * `{ providerID: null, modelID: slug }` and the caller falls back to the
 * server's default provider.
 */
const splitModelSlug = (
  slug: string | undefined,
): { providerID: string | null; modelID: string | null } => {
  if (slug === undefined || slug.length === 0) {
    return { providerID: null, modelID: null };
  }
  const idx = slug.indexOf("/");
  if (idx < 0) return { providerID: null, modelID: slug };
  return {
    providerID: slug.slice(0, idx),
    modelID: slug.slice(idx + 1),
  };
};

const isToolPart = (part: SdkPart): part is SdkToolPart =>
  (part as { type?: string }).type === "tool";

/**
 * Map opencode's lowercase tool names onto the Title-case names worcester's
 * `tool-row.tsx:buildToolView` switch already understands. Anything not
 * in this table passes through as-is — the renderer's default branch
 * renders it as a generic tool row.
 */
const OPENCODE_TOOL_NAME: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  multiedit: "MultiEdit",
  bash: "Bash",
  glob: "Glob",
  grep: "Grep",
  task: "Task",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  list: "ListDir",
};

const asStr = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/**
 * Reshape an opencode tool's `state.input` into the canonical key bag the
 * renderer expects (e.g. `file_path` instead of opencode's `filePath`).
 * Mirrors `acp/translate.ts:buildCanonicalInput`. When the input is missing
 * a key but `state.title` carries it (opencode often puts the relative
 * file path there), fall back to the title so the row still shows a chip.
 */
const canonicalizeOpencodeInput = (
  canonicalTool: string,
  rawInput: unknown,
  title: string | null,
): unknown => {
  const obj =
    rawInput !== null && typeof rawInput === "object"
      ? (rawInput as Record<string, unknown>)
      : {};

  switch (canonicalTool) {
    case "Read": {
      const file_path =
        asStr(obj["filePath"]) ?? asStr(obj["file_path"]) ?? title;
      const out: Record<string, unknown> = {};
      if (file_path !== null) out["file_path"] = file_path;
      if (typeof obj["offset"] === "number") out["offset"] = obj["offset"];
      if (typeof obj["limit"] === "number") out["limit"] = obj["limit"];
      return out;
    }
    case "Edit": {
      const file_path =
        asStr(obj["filePath"]) ?? asStr(obj["file_path"]) ?? title;
      const out: Record<string, unknown> = {};
      if (file_path !== null) out["file_path"] = file_path;
      const oldS = asStr(obj["oldString"]) ?? asStr(obj["old_string"]);
      const newS = asStr(obj["newString"]) ?? asStr(obj["new_string"]);
      if (oldS !== null) out["old_string"] = oldS;
      if (newS !== null) out["new_string"] = newS;
      const replaceAll = obj["replaceAll"] ?? obj["replace_all"];
      if (typeof replaceAll === "boolean") out["replace_all"] = replaceAll;
      return out;
    }
    case "MultiEdit": {
      const file_path =
        asStr(obj["filePath"]) ?? asStr(obj["file_path"]) ?? title;
      const rawEdits = Array.isArray(obj["edits"]) ? obj["edits"] : [];
      // Renderer's `extractEdits` reads `{old_string,new_string}` per entry.
      const edits = rawEdits.map((e) => {
        if (e === null || typeof e !== "object") return {};
        const r = e as Record<string, unknown>;
        return {
          old_string: asStr(r["oldString"]) ?? asStr(r["old_string"]) ?? "",
          new_string: asStr(r["newString"]) ?? asStr(r["new_string"]) ?? "",
        };
      });
      const out: Record<string, unknown> = { edits };
      if (file_path !== null) out["file_path"] = file_path;
      return out;
    }
    case "Write": {
      const file_path =
        asStr(obj["filePath"]) ?? asStr(obj["file_path"]) ?? title;
      const out: Record<string, unknown> = {};
      if (file_path !== null) out["file_path"] = file_path;
      if (typeof obj["content"] === "string") out["content"] = obj["content"];
      return out;
    }
    case "Bash": {
      const command = asStr(obj["command"]) ?? asStr(obj["cmd"]) ?? title;
      const out: Record<string, unknown> = {};
      if (command !== null) out["command"] = command;
      const description = asStr(obj["description"]);
      if (description !== null) out["description"] = description;
      return out;
    }
    case "Glob": {
      const out: Record<string, unknown> = {};
      const pattern = asStr(obj["pattern"]) ?? title;
      if (pattern !== null) out["pattern"] = pattern;
      const path = asStr(obj["path"]);
      if (path !== null) out["path"] = path;
      return out;
    }
    case "Grep": {
      const out: Record<string, unknown> = {};
      const pattern = asStr(obj["pattern"]) ?? title;
      if (pattern !== null) out["pattern"] = pattern;
      const path = asStr(obj["path"]);
      if (path !== null) out["path"] = path;
      // Opencode names the filename filter `include`; the renderer reads `glob`.
      const glob = asStr(obj["include"]) ?? asStr(obj["glob"]);
      if (glob !== null) out["glob"] = glob;
      return out;
    }
    case "Task": {
      const out: Record<string, unknown> = {};
      const description = asStr(obj["description"]) ?? title;
      if (description !== null) out["description"] = description;
      const prompt = asStr(obj["prompt"]);
      if (prompt !== null) out["prompt"] = prompt;
      const subagent =
        asStr(obj["subagent_type"]) ?? asStr(obj["subagentType"]);
      if (subagent !== null) out["subagent_type"] = subagent;
      return out;
    }
    case "TodoWrite": {
      return { todos: Array.isArray(obj["todos"]) ? obj["todos"] : [] };
    }
    case "WebFetch": {
      const out: Record<string, unknown> = {};
      const url = asStr(obj["url"]) ?? title;
      if (url !== null) out["url"] = url;
      return out;
    }
    case "WebSearch": {
      const out: Record<string, unknown> = {};
      const query = asStr(obj["query"]) ?? asStr(obj["q"]) ?? title;
      if (query !== null) out["query"] = query;
      return out;
    }
    default:
      return obj;
  }
};

/**
 * Strip opencode's `<path>…</path><type>file</type><content>\n…\n</content>`
 * wrapper from a `read` tool's output, so `lineCountOf` measures file
 * lines instead of wrapper lines. If the wrapper isn't present (e.g.
 * opencode upstream changes the format), the original text is returned
 * untouched.
 */
const unwrapReadOutput = (text: string): string => {
  const contentOpen = text.indexOf("<content>");
  const contentClose = text.lastIndexOf("</content>");
  if (contentOpen < 0 || contentClose < 0 || contentClose <= contentOpen) {
    return text;
  }
  const inner = text.slice(contentOpen + "<content>".length, contentClose);
  // Trim the single \n that wraps the content body inside the tag pair.
  return inner.replace(/^\n/, "").replace(/\n$/, "");
};

const toOutputString = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/**
 * Translate an opencode SDK Part snapshot into the equivalent worcester
 * `AgentEvent`s. Called from the event pump on every `message.part.updated`
 * frame. The renderer dedupes events by `itemId`, so re-emitting the same
 * tool part as it transitions pending → running → completed updates the
 * existing row in place rather than spawning a new one.
 */
const translatePart = (
  part: SdkPart,
  state: DeltaState,
): ReadonlyArray<AgentEvent> => {
  const partType = (part as { type?: string }).type;
  switch (partType) {
    case "text": {
      const text = (part as { text?: string }).text ?? "";
      if (text.length === 0) return [];
      return [
        {
          _tag: "AssistantMessage",
          itemId: (part as { id: string }).id as AgentItemId,
          text,
        },
      ];
    }
    case "reasoning": {
      const text = (part as { text?: string }).text ?? "";
      if (text.length === 0) return [];
      return [
        {
          _tag: "Thinking",
          itemId: (part as { id: string }).id as AgentItemId,
          text,
          redacted: false,
        },
      ];
    }
    case "tool": {
      if (!isToolPart(part)) return [];
      // Prefer `callID` for the itemId so SSE updates (which keep the same
      // call but bump `part.id` between snapshots in some opencode builds)
      // collapse onto a single tool row in the renderer. Falls back to
      // `id` when callID isn't present.
      const id = (part.callID ?? part.id) as string as AgentItemId;
      const status = part.state.status;
      const rawTool = part.tool;
      const canonicalTool =
        OPENCODE_TOOL_NAME[rawTool.toLowerCase()] ??
        rawTool.charAt(0).toUpperCase() + rawTool.slice(1);
      const title = asStr((part.state as { title?: unknown }).title) ?? null;
      const canonicalInput = canonicalizeOpencodeInput(
        canonicalTool,
        part.state.input,
        title,
      );
      dlog(
        `tool ${rawTool}→${canonicalTool} status=${status} callID=${part.callID ?? "(none)"} id=${part.id}`,
      );
      ddump(`  tool.state`, part.state);
      // Opencode emits a `message.part.updated` frame for every state
      // transition (pending → running → completed). The persistence layer
      // doesn't dedupe by itemId, so each ToolUse becomes its own row.
      // Emit ToolUse exactly once per call — when we first see input or
      // hit a terminal state — and emit ToolResult only on completion.
      const events: AgentEvent[] = [];
      const inputObj =
        canonicalInput !== null && typeof canonicalInput === "object"
          ? (canonicalInput as Record<string, unknown>)
          : {};
      const hasUsefulInput = Object.keys(inputObj).length > 0;
      const isTerminal = status === "completed" || status === "error";
      if (!state.emittedToolUseIds.has(id) && (hasUsefulInput || isTerminal)) {
        events.push({
          _tag: "ToolUse",
          itemId: id,
          tool: canonicalTool,
          input: canonicalInput,
        });
        state.emittedToolUseIds.add(id);
      }
      if (status === "completed") {
        const raw = toOutputString(part.state.output);
        const output = canonicalTool === "Read" ? unwrapReadOutput(raw) : raw;
        events.push({
          _tag: "ToolResult",
          itemId: id,
          output,
          isError: false,
        });
      } else if (status === "error") {
        events.push({
          _tag: "ToolResult",
          itemId: id,
          output: toOutputString(part.state.error),
          isError: true,
        });
      }
      return events;
    }
    default:
      return [];
  }
};

/**
 * Per-part delta buffer. Opencode 1.15 streams text + reasoning as
 * `message.part.delta` frames (one token per event); the SDK's typed
 * `EventMessagePartUpdated` *never* fires for these. We accumulate the
 * deltas keyed by `partID` and flush each buffer as a single
 * `AssistantMessage` / `Thinking` event on turn end (`session.idle`),
 * so the renderer renders ONE assistant bubble per part instead of 158.
 *
 * Stored at session scope by `startOpencodeSession`.
 */
interface DeltaState {
  readonly textByPartId: Map<string, string>;
  readonly reasoningByPartId: Map<string, string>;
  /** PartIDs we've already emitted as full AssistantMessage / Thinking
   *  via the prompt-response fallback — skip the SSE flush for these
   *  so we don't duplicate rows. */
  readonly flushedPartIds: Set<string>;
  /** Tool itemIds we've already emitted a `ToolUse` for. Opencode pushes
   *  a `message.part.updated` frame for every state transition (pending →
   *  running → completed), but the renderer/message-store doesn't dedupe
   *  by itemId — each event becomes a new row. So we emit ToolUse once
   *  (the first frame with real input or the completed snapshot) and
   *  only emit ToolResult on the terminal transition. */
  readonly emittedToolUseIds: Set<string>;
  /** Message IDs we've learned belong to the *user* (from `message.updated`
   *  with role=user). Opencode also emits `message.part.updated` /
   *  `message.part.delta` for the user message's text part, and our
   *  translator would otherwise re-emit that text as an `AssistantMessage`,
   *  duplicating the user's prompt on the left side. */
  readonly userMessageIds: Set<string>;
}

const makeDeltaState = (): DeltaState => ({
  textByPartId: new Map(),
  reasoningByPartId: new Map(),
  flushedPartIds: new Set(),
  emittedToolUseIds: new Set(),
  userMessageIds: new Set(),
});

const flushDeltaState = (state: DeltaState): ReadonlyArray<AgentEvent> => {
  const out: AgentEvent[] = [];
  for (const [partId, text] of state.textByPartId.entries()) {
    if (state.flushedPartIds.has(partId)) continue;
    if (text.length === 0) continue;
    out.push({
      _tag: "AssistantMessage",
      itemId: partId as AgentItemId,
      text,
    });
    state.flushedPartIds.add(partId);
  }
  for (const [partId, text] of state.reasoningByPartId.entries()) {
    if (state.flushedPartIds.has(partId)) continue;
    if (text.length === 0) continue;
    out.push({
      _tag: "Thinking",
      itemId: partId as AgentItemId,
      text,
      redacted: false,
    });
    state.flushedPartIds.add(partId);
  }
  state.textByPartId.clear();
  state.reasoningByPartId.clear();
  return out;
};

/**
 * Translate one SDK event into zero-or-more worcester `AgentEvent`s.
 * The session id is bound at session-start time so we can ignore events
 * from sibling sessions sharing the same server process — important
 * because the SDK subscribes to a global event stream.
 *
 * The `state` carries cross-event accumulators (text/reasoning deltas).
 */
const translateEvent = (
  ev: SdkEvent,
  sessionID: string,
  state: DeltaState,
): ReadonlyArray<AgentEvent> => {
  switch (ev.type) {
    case "message.part.updated": {
      const part = ev.properties.part;
      if (part.sessionID !== sessionID) return [];
      // Opencode persists the user's message-as-text part too; skip parts
      // owned by user messages so we don't echo the prompt back as an
      // AssistantMessage on the left.
      const partMessageId = (part as { messageID?: string }).messageID;
      if (
        partMessageId !== undefined &&
        state.userMessageIds.has(partMessageId)
      ) {
        return [];
      }
      const partId = (part as { id?: string }).id;
      if (partId !== undefined) state.flushedPartIds.add(partId);
      return translatePart(part, state);
    }
    // SDK 1.15.1's typed `Event` union is missing this case, but the
    // opencode server emits it as the canonical streaming-text frame
    // (one event per token). We accumulate by `partID` and flush on
    // turn end, so the renderer sees one assistant bubble per part.
    case "message.part.delta" as SdkEvent["type"]: {
      const props = (
        ev as unknown as {
          properties: {
            sessionID: string;
            messageID?: string;
            partID: string;
            field: string;
            delta: string;
          };
        }
      ).properties;
      if (props.sessionID !== sessionID) return [];
      // Same user-text guard as above — the user message's text part can
      // arrive as deltas in some opencode builds.
      if (
        props.messageID !== undefined &&
        state.userMessageIds.has(props.messageID)
      ) {
        return [];
      }
      if (state.flushedPartIds.has(props.partID)) return [];
      if (props.field === "text") {
        const prev = state.textByPartId.get(props.partID) ?? "";
        state.textByPartId.set(props.partID, prev + props.delta);
      } else if (props.field === "reasoning") {
        const prev = state.reasoningByPartId.get(props.partID) ?? "";
        state.reasoningByPartId.set(props.partID, prev + props.delta);
      }
      return [];
    }
    case "message.updated": {
      const info = ev.properties.info;
      if (info.sessionID !== sessionID) return [];
      // Remember user message ids so subsequent part/delta frames for
      // those messages get dropped (see the two guards above).
      if (info.role === "user") {
        state.userMessageIds.add(info.id);
        return [];
      }
      if (info.role !== "assistant") return [];
      const tokens = info.tokens;
      if (info.time.completed === undefined) return [];
      return [
        {
          _tag: "UsageDelta",
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          cacheReadTokens: tokens.cache.read,
          cacheCreationTokens: tokens.cache.write,
          model: info.modelID,
        },
      ];
    }
    case "session.idle": {
      if (ev.properties.sessionID !== sessionID) return [];
      // Flush buffered text/reasoning deltas before signalling turn end so
      // the renderer sees the full assistant bubble before the spinner stops.
      const flushed = flushDeltaState(state);
      return [
        ...flushed,
        { _tag: "Status", status: "idle" },
        { _tag: "Completed", reason: "ended" },
      ];
    }
    case "session.error": {
      if (
        ev.properties.sessionID !== undefined &&
        ev.properties.sessionID !== sessionID
      ) {
        return [];
      }
      const errorData = ev.properties.error;
      const message =
        errorData === undefined
          ? "OpenCode session error"
          : ((errorData.data as { message?: string }).message ??
            errorData.name);
      return [
        {
          _tag: "Error",
          message,
          providerId: "opencode",
        },
      ];
    }
    case "permission.updated": {
      const perm = ev.properties;
      if (perm.sessionID !== sessionID) return [];
      return [
        {
          _tag: "PermissionRequest",
          itemId: perm.id as AgentItemId,
          kind: perm.type,
          details: {
            title: perm.title,
            metadata: perm.metadata,
            pattern: perm.pattern,
            callID: perm.callID,
          },
        },
      ];
    }
    default:
      return [];
  }
};

/**
 * Spin up a single opencode conversation. The HTTP server is spawned
 * lazily inside `start()` so failures (binary missing version, port
 * exhaustion, auth missing) surface there as `AgentSessionStartError`.
 */
export const startOpencodeSession = (
  input: StartSessionInput,
  cwd: string,
  customProviders: ReadonlyArray<OpencodeCustomProvider>,
  opencodePath: string,
  sessionId: AgentSessionId,
  resumeCursor: string | null = null,
): Effect.Effect<
  OpencodeSessionHandle,
  AgentSessionStartError,
  AttachmentService
> =>
  Effect.gen(function* () {
    yield* AttachmentService;
    const events = yield* Queue.make<AgentEvent>();

    let currentMode: PermissionMode = input.permissionMode ?? "default";
    let closed = false;
    const deltaState = makeDeltaState();

    Queue.offerUnsafe(events, {
      _tag: "Started",
      sessionId,
      providerId: "opencode",
      mode: "sdk",
    });

    if (resumeCursor !== null) {
      dlog(`resumeCursor=${resumeCursor} ignored — using fresh session`);
    }

    // === Boot: spawn server, open SSE FIRST, then create session. ===
    // Opening the SSE channel before session creation matters because the
    // opencode HTTP server pushes events as soon as a turn starts; any
    // late-binding listener silently misses everything up to the moment
    // it connects, which manifests as "I sent a message and saw nothing".
    const boot = Effect.tryPromise({
      try: async () => {
        const proc = await spawnOpencodeServer(
          opencodePath,
          cwd,
          buildOpencodeConfigContent(customProviders),
        );
        dlog(`server ready at ${proc.url}`);
        const c = createOpencodeClient({ baseUrl: proc.url });
        const ac = new AbortController();
        const sse = await c.event.subscribe({ signal: ac.signal });
        dlog("SSE subscribed");
        const session = await c.session.create({
          throwOnError: true,
          body: { title: "Zuse session" },
        });
        const sessionData = session.data;
        if (sessionData === undefined || typeof sessionData.id !== "string") {
          throw new Error("opencode session.create returned no session id");
        }
        dlog(`session created: ${sessionData.id}`);
        return {
          server: proc,
          client: c,
          abort: ac,
          stream: sse.stream as AsyncIterable<unknown>,
          sid: sessionData.id,
        };
      },
      catch: (cause) =>
        new AgentSessionStartError({
          providerId: "opencode",
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    const booted = yield* boot;
    const server = booted.server;
    const client = booted.client;
    const eventAbort = booted.abort;
    const opencodeSessionId = booted.sid;

    Queue.offerUnsafe(events, {
      _tag: "SessionCursor",
      cursor: opencodeSessionId,
      strategy: "opencode-session-id",
    });

    // Auto-accept permissions for v1.
    const respondToPermission = async (permissionID: string): Promise<void> => {
      try {
        await client.postSessionIdPermissionsPermissionId({
          throwOnError: true,
          body: { response: "once" },
          path: { id: opencodeSessionId, permissionID },
        });
      } catch (cause) {
        dlog(
          `permission respond failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    };

    // === Event pump — translate SSE frames into AgentEvents. ===
    dlog(`==== EVENT PUMP STARTED for session ${opencodeSessionId} ====`);
    let eventCount = 0;
    void (async () => {
      try {
        for await (const ev of booted.stream) {
          if (closed) break;
          eventCount += 1;
          const sdkEvent = ev as SdkEvent;
          const type = sdkEvent.type;
          // Always dump the full event payload, regardless of type. If
          // opencode is invoking tools we expect to see message.part.updated
          // frames with part.type=tool in this stream; if those never
          // appear, the model isn't actually issuing tool calls (or the
          // agent's permission policy is blocking them server-side).
          dlog(`#${eventCount} event=${type}`);
          ddump(`  raw`, sdkEvent);
          if (type === "message.part.updated") {
            const part = sdkEvent.properties.part;
            const partType = (part as { type?: string }).type ?? "(unknown)";
            if (partType === "tool") {
              dlog(`  *** TOOL PART RECEIVED ***`);
            }
          }
          if (
            type === "permission.updated" &&
            sdkEvent.properties.sessionID === opencodeSessionId
          ) {
            void respondToPermission(sdkEvent.properties.id);
          }
          const translated = translateEvent(
            sdkEvent,
            opencodeSessionId,
            deltaState,
          );
          if (translated.length > 0) {
            dlog(
              `  → emit ${translated.length}: ${translated.map((e) => e._tag).join(", ")}`,
            );
          } else if (type === "message.part.updated") {
            // Translator dropped a part frame — log so we can see what was
            // discarded (e.g. a part.sessionID mismatch on the global event
            // bus, or a part.type we don't translate yet).
            dlog(`  (translator dropped this frame)`);
          }
          for (const out of translated) {
            Queue.offerUnsafe(events, out);
          }
        }
        dlog(`event stream ended after ${eventCount} events`);
      } catch (cause) {
        if (closed) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (/abort/i.test(message)) return;
        dlog(`event stream failed after ${eventCount} events: ${message}`);
        Queue.offerUnsafe(events, {
          _tag: "Error",
          message: `OpenCode event stream failed: ${message}`,
          providerId: "opencode",
        });
      }
    })();

    // Watch for the server process dying out from under us.
    server.child.on("exit", (code, signal) => {
      if (closed) return;
      Queue.offerUnsafe(events, {
        _tag: "Error",
        message: `OpenCode server exited (code ${code ?? "null"}, signal ${signal ?? "null"}).`,
        providerId: "opencode",
      });
      Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
    });

    // === Prompt queue — serializes turns inside a single session. ===
    let inflight: Promise<void> = Promise.resolve();
    let workspaceInstructionsPending = input.workspaceInstructions;
    const enqueuePrompt = (text: string): void => {
      const compactSnapshot = isCompactCommand(text)
        ? startCompactSnapshot(null)
        : null;
      if (compactSnapshot !== null) {
        Queue.offerUnsafe(events,
          startCompactEvent({
            providerId: "opencode",
            snapshot: compactSnapshot,
          }),
        );
      }
      const promptText =
        compactSnapshot !== null
          ? text.trim()
          : prefixFirstPromptWithWorkspaceInstructions(
              workspaceInstructionsPending,
              text,
            );
      if (compactSnapshot === null) workspaceInstructionsPending = undefined;
      inflight = inflight
        .then(async () => {
          if (closed) return;
          const agentOpt = input.modelOptions?.["agent"];
          const agent =
            currentMode === "plan"
              ? "plan"
              : agentOpt && agentOpt.length > 0
                ? agentOpt
                : "build";
          const { providerID, modelID } = splitModelSlug(input.model);
          // `reasoning` is the renderer's per-session key for the variant
          // picker (shared with other providers that have reasoning
          // levels). Opencode SDK v1 typings don't expose `variant` on the
          // prompt body's model field, but the server accepts it — pass
          // through via a cast so the variant survives the round-trip.
          const variantOpt = input.modelOptions?.["reasoning"];
          const modelField =
            providerID !== null && modelID !== null
              ? ({
                  providerID,
                  modelID,
                  ...(variantOpt && variantOpt.length > 0
                    ? { variant: variantOpt }
                    : {}),
                } as { providerID: string; modelID: string })
              : null;
          const body = {
            agent,
            ...(modelField !== null ? { model: modelField } : {}),
            parts: [{ type: "text" as const, text: promptText }],
          };
          dlog(
            `prompt: agent=${agent} providerID=${providerID ?? "(default)"} modelID=${modelID ?? "(default)"} variant=${variantOpt ?? "(default)"} textLen=${promptText.length}`,
          );
          ddump(`  prompt.body`, body);
          try {
            const res = await client.session.prompt({
              throwOnError: true,
              path: { id: opencodeSessionId },
              body,
            });
            dlog("prompt resolved");
            // Fallback: if the SSE pump missed the final assistant text
            // (race with subscribe handshake, server restart, etc.), pull
            // it directly from the prompt response so the user still sees
            // *something* instead of a silent turn.
            const data = res.data as
              | {
                  info?: {
                    error?: { data?: { message?: string }; name?: string };
                  };
                  parts?: ReadonlyArray<unknown>;
                }
              | undefined;
            const errInfo = data?.info?.error;
            if (errInfo !== undefined) {
              const message =
                errInfo.data?.message ??
                errInfo.name ??
                "OpenCode reported an error on this turn.";
              Queue.offerUnsafe(events, {
                _tag: "Error",
                message,
                providerId: "opencode",
              });
            }
            const parts = data?.parts ?? [];
            dlog(
              `prompt fallback: ${parts.length} parts in response: ${parts
                .map((p) => (p as { type?: string }).type ?? "?")
                .join(", ")}`,
            );
            ddump(`  prompt.info`, data?.info);
            for (const part of parts) {
              const partId = (part as { id?: string }).id;
              // Skip text/reasoning parts already streamed via SSE deltas —
              // those were flushed on session.idle and double-emitting would
              // produce duplicate bubbles.
              if (
                partId !== undefined &&
                deltaState.flushedPartIds.has(partId)
              ) {
                continue;
              }
              ddump(`  prompt.part`, part);
              const out = translatePart(part as SdkPart, deltaState);
              if (out.length > 0) {
                dlog(`    → emit ${out.map((e) => e._tag).join(", ")}`);
              }
              if (partId !== undefined) deltaState.flushedPartIds.add(partId);
              for (const evt of out) {
                Queue.offerUnsafe(events, evt);
              }
            }
            // Catch-all flush in case session.idle never fired (e.g. the
            // prompt resolved before the SSE got there).
            for (const evt of flushDeltaState(deltaState)) {
              Queue.offerUnsafe(events, evt);
            }
            if (compactSnapshot !== null && !closed) {
              Queue.offerUnsafe(events,
                finishCompactEvent({
                  itemId: compactSnapshot.itemId,
                  providerId: "opencode",
                  snapshot: compactSnapshot,
                  afterTokens: null,
                }),
              );
            }
            Queue.offerUnsafe(events, { _tag: "Completed", reason: "ended" });
          } catch (cause) {
            if (closed) return;
            const reason =
              cause instanceof Error ? cause.message : String(cause);
            const isCancellation = /abort|cancel/i.test(reason);
            if (!isCancellation) {
              dlog(`prompt failed: ${reason}`);
              Queue.offerUnsafe(events, {
                _tag: "Error",
                message: `OpenCode prompt failed: ${reason}`,
                providerId: "opencode",
              });
              Queue.offerUnsafe(events, { _tag: "Completed", reason: "error" });
            }
          }
        })
        .catch(() => undefined);
    };

    if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
      enqueuePrompt(input.initialPrompt);
    }

    const handle: OpencodeSessionHandle = {
      events: Stream.fromQueue(events),
      send: (text, attachmentRefs) =>
        Effect.sync(() => {
          if (attachmentRefs !== undefined && attachmentRefs.length > 0) {
            // OpenCode supports FilePartInput but we haven't wired the
            // attachment → URL bridge yet; drop with a warn so the rest
            // of the turn still works.
            // eslint-disable-next-line no-console
            console.warn(
              `[opencode.attach] dropping ${attachmentRefs.length} attachment(s) — file part bridge not wired`,
            );
          }
          enqueuePrompt(text);
        }),
      interrupt: () =>
        Effect.promise(async () => {
          try {
            await client.session.abort({
              throwOnError: true,
              path: { id: opencodeSessionId },
            });
          } catch (cause) {
            dlog(
              `interrupt failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
        }),
      close: () =>
        Effect.gen(function* () {
          closed = true;
          try {
            eventAbort.abort();
          } catch {
            // ignore
          }
          try {
            server.child.kill("SIGTERM");
          } catch {
            // ignore — child may already be gone
          }
          yield* events.end;
        }),
      setPermissionMode: (mode) =>
        Effect.sync(() => {
          if (mode === currentMode) return;
          currentMode = mode;
          Queue.offerUnsafe(events, { _tag: "PermissionModeChanged", mode });
          // No in-band toggle on opencode — the next `enqueuePrompt`
          // swaps the agent to "plan" or back to the user's selection.
        }),
      answerQuestion: () => Effect.void,
    };
    return handle;
  });

// ---------------------------------------------------------------------------
// Inventory loader — short-lived `opencode serve` used by the
// `agent.opencodeInventory` RPC to read the user's locally-connected
// providers, models, and agents (build/plan/custom). The server is torn
// down as soon as both SDK calls return.
// ---------------------------------------------------------------------------

const filterPrimaryAgents = (
  agents: ReadonlyArray<SdkAgent>,
): ReadonlyArray<OpencodeInventoryAgent> =>
  agents
    .filter((a) => a.mode === "primary" || a.mode === "all")
    .map((a) => ({
      name: a.name,
      mode: a.mode as "primary" | "all",
      ...(a.description !== undefined ? { description: a.description } : {}),
    }));

interface InventoryProviderModel {
  readonly id: string;
  readonly name: string;
  // Opencode SDK v1 typings don't expose `variants`, but the wire
  // protocol does carry it on each model — `Object.keys` of this map gives
  // the variant names (e.g. `["high", "medium", "low"]`).
  readonly variants?: Record<string, unknown>;
  readonly status?: "alpha" | "beta" | "deprecated" | "active";
  readonly capabilities?: {
    readonly toolcall?: boolean;
  };
}

interface InventoryProvider {
  readonly id: string;
  readonly name: string;
  // Env var(s) the provider's key is read from (e.g. `["OPENAI_API_KEY"]`).
  readonly env?: ReadonlyArray<string>;
  readonly models: { readonly [key: string]: InventoryProviderModel };
}

/**
 * Best-effort fetch of models.dev's catalog to pull each provider's
 * "get an API key" doc URL (opencode's `provider.list()` doesn't expose it).
 * Returns an id→doc-url map; on any failure returns an empty map so inventory
 * still loads (the UI just omits the doc link). opencode already fetches
 * models.dev for its own catalog, so the data is authoritative.
 */
const fetchModelsDevDocs = async (): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch("https://models.dev/api.json", {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return out;
    const json = (await resp.json()) as Record<string, { doc?: string }>;
    for (const [id, meta] of Object.entries(json)) {
      if (typeof meta?.doc === "string" && meta.doc.length > 0) {
        out.set(id, meta.doc);
      }
    }
  } catch {
    // offline / models.dev down — inventory loads without doc links
  }
  return out;
};

// OpenCode reports every model its provider definitions know about — alpha,
// beta, deprecated, audio-only, etc. For agentic chat we need active models
// that support tool calls; everything else just clutters the picker (and
// would fail mid-session). Mirrors what the SDK type declares on `Model`
// (status + capabilities.toolcall).
const isUsableInventoryModel = (m: InventoryProviderModel): boolean => {
  if (m.status !== undefined && m.status !== "active") return false;
  if (m.capabilities?.toolcall === false) return false;
  return true;
};

const collectInventoryProviders = (
  all: ReadonlyArray<InventoryProvider>,
  connected: ReadonlyArray<string>,
  customIds: ReadonlySet<string>,
  docById: ReadonlyMap<string, string>,
): ReadonlyArray<OpencodeInventoryProvider> => {
  const connectedSet = new Set(connected);
  return (
    all
      .map((p) => {
        const isConnected = connectedSet.has(p.id);
        return {
          id: p.id,
          name: p.name,
          connected: isConnected,
          custom: customIds.has(p.id),
          apiKeyEnv: p.env?.[0] ?? "",
          apiKeyUrl: docById.get(p.id) ?? "",
          // Only enumerate models for connected providers. The catalog carries
          // ~150 providers with thousands of models between them; shipping every
          // unconnected provider's full model list would bloat the RPC payload
          // and the renderer's localStorage cache. The picker only ever renders
          // connected providers' models, and connecting one triggers a refresh
          // that fills them in.
          models: isConnected
            ? Object.values(p.models)
                .filter(isUsableInventoryModel)
                .map((m) => ({
                  id: `${p.id}/${m.id}`,
                  label: m.name,
                  variants: Object.keys(m.variants ?? {}),
                }))
                .sort((a, b) => a.label.localeCompare(b.label))
            : [],
        };
      })
      // Connected providers first (each with usable models), then the rest of
      // the catalog alphabetically for the "add provider" browser.
      .sort((a, b) => {
        if (a.connected !== b.connected) return a.connected ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
  );
};

export const loadOpencodeInventory = (
  opencodePath: string,
  cwd: string,
  customProviders: ReadonlyArray<OpencodeCustomProvider> = [],
): Effect.Effect<OpencodeInventory, AgentSessionStartError> =>
  Effect.tryPromise({
    try: async () => {
      dlog(`inventory: spawning opencode server`);
      const proc = await spawnOpencodeServer(
        opencodePath,
        cwd,
        buildOpencodeConfigContent(customProviders),
      );
      const client = createOpencodeClient({ baseUrl: proc.url });
      const customIds = new Set(customProviders.map((p) => p.id));
      try {
        const [providersResp, agentsResp, docById] = await Promise.all([
          client.provider.list({ throwOnError: true }),
          client.app.agents({ throwOnError: true }),
          fetchModelsDevDocs(),
        ]);
        const providersData = providersResp.data;
        const agentsData = agentsResp.data;
        if (providersData !== undefined) {
          dlog(
            `inventory: connected providers [${providersData.connected.join(", ")}]`,
          );
          dlog(
            `inventory: all providers [${providersData.all.map((p) => `${p.id}(${Object.keys(p.models).length} models)`).join(", ")}]`,
          );
        } else {
          dlog(`inventory: provider.list() returned undefined`);
        }
        if (agentsData !== undefined) {
          dlog(
            `inventory: agents [${agentsData.map((a) => `${a.name}(${a.mode})`).join(", ")}]`,
          );
        }
        const providers =
          providersData === undefined
            ? []
            : collectInventoryProviders(
                providersData.all as ReadonlyArray<InventoryProvider>,
                providersData.connected,
                customIds,
                docById,
              );
        const agents =
          agentsData === undefined
            ? []
            : filterPrimaryAgents(agentsData as ReadonlyArray<SdkAgent>);
        dlog(
          `inventory: returning ${providers.length} providers, ${agents.length} agents`,
        );
        ddump(`  inventory.result`, { providers, agents });
        return { providers, agents } satisfies OpencodeInventory;
      } finally {
        try {
          proc.child.kill("SIGTERM");
        } catch {
          // ignore — child may already be gone
        }
      }
    },
    catch: (cause) =>
      new AgentSessionStartError({
        providerId: "opencode",
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });

/**
 * Short-live an `opencode serve`, run `fn` against its SDK client, and tear
 * the server down — the shared shape behind the provider-management effects
 * below (mirrors `loadOpencodeInventory`'s spawn/try/finally). Failures wrap
 * into `AgentSessionStartError` so the renderer surfaces them the same way as
 * inventory / session-start errors.
 */
const withOpencodeServer = <A>(
  opencodePath: string,
  cwd: string,
  configContent: string,
  fn: (client: OpencodeClient) => Promise<A>,
): Effect.Effect<A, AgentSessionStartError> =>
  Effect.tryPromise({
    try: async () => {
      const proc = await spawnOpencodeServer(opencodePath, cwd, configContent);
      const client = createOpencodeClient({ baseUrl: proc.url });
      try {
        return await fn(client);
      } finally {
        try {
          proc.child.kill("SIGTERM");
        } catch {
          // ignore — child may already be gone
        }
      }
    },
    catch: (cause) =>
      new AgentSessionStartError({
        providerId: "opencode",
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });

/**
 * Store an API key for an opencode provider (catalog or custom) by writing it
 * through to opencode's persistent `auth.json` via the SDK `auth.set` (PUT
 * /auth/{id}). Once set, `provider.list()` reports the provider as
 * `connected` and its models become usable — in this app AND in the user's
 * terminal `opencode`.
 */
export const setOpencodeProviderAuth = (
  opencodePath: string,
  cwd: string,
  providerId: string,
  apiKey: string,
): Effect.Effect<void, AgentSessionStartError> =>
  withOpencodeServer(
    opencodePath,
    cwd,
    OPENCODE_EMPTY_CONFIG,
    async (client) => {
      await client.auth.set({
        throwOnError: true,
        path: { id: providerId },
        body: { type: "api", key: apiKey },
      });
    },
  );

/**
 * Remove an opencode provider's stored credential. The SDK exposes no
 * generic "delete credential" endpoint (its `auth.remove` is MCP-only), so we
 * edit `auth.json` directly — the same file `auth.set` writes — which keeps
 * the change consistent with terminal opencode. A missing file or missing key
 * is a no-op.
 */
export const removeOpencodeProviderAuth = (
  providerId: string,
): Effect.Effect<void, AgentSessionStartError> =>
  Effect.tryPromise({
    try: async () => {
      const authPath = opencodeAuthPath();
      const raw = await readFile(authPath, "utf8").catch(() => null);
      if (raw === null) return;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!(providerId in json)) return;
      delete json[providerId];
      await writeFile(authPath, `${JSON.stringify(json, null, 2)}\n`);
    },
    catch: (cause) =>
      new AgentSessionStartError({
        providerId: "opencode",
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });
