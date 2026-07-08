import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * In-process MCP "control-plane" tools — the primitives that let an agent
 * orchestrate its OWN work the way a human operator would: spin up a git
 * worktree, open a new chat/session ("thread"), hand that thread a task, and
 * read back its progress. This is the Layer-1 foundation the loop engine
 * (heartbeat / goal loops) builds on in a later phase.
 *
 * These mirror `buildIndexTools` / `buildBrowserTools`: the handlers are plain
 * async functions the Claude SDK invokes directly, kept free of any Effect
 * wiring. `MessageStore` binds the deps below to its own Effect methods via
 * `Runtime.runPromise`, and — crucially — translates every failure into a
 * `{ ok: false, error }` result so these handlers never throw. That keeps the
 * tool surface free of raw try/catch and matches the `BrowserCommandResult`
 * convention.
 *
 * Registration is gated on autonomy: `MessageStore` only builds + passes these
 * when the session's autonomy level is not `"off"`. The mutating tools
 * (create_worktree / create_thread / send_to_thread) fall through the driver's
 * permission policy to a prompt, which IS the approval gate for the
 * `approval-gated` level; the read-only tools (read_thread / list_threads /
 * list_models / whoami) are auto-allowed by the driver alongside the index
 * reads.
 */

// ── Result contracts (set by MessageStore, never thrown) ────────────────────

export type CreateWorktreeResult =
  | {
      readonly ok: true;
      readonly worktreeId: string;
      readonly path: string;
      readonly branch: string;
    }
  | { readonly ok: false; readonly error: string };

export type CreateThreadResult =
  | {
      readonly ok: true;
      readonly chatId: string;
      readonly sessionId: string;
      readonly title: string;
    }
  | { readonly ok: false; readonly error: string };

export type SendToThreadResult =
  | { readonly ok: true; readonly queued: boolean; readonly chatId: string }
  | { readonly ok: false; readonly error: string };

export interface ThreadMessage {
  readonly role: string;
  readonly text: string;
}

export type ReadThreadResult =
  | {
      readonly ok: true;
      readonly status: string;
      readonly messages: ReadonlyArray<ThreadMessage>;
    }
  | { readonly ok: false; readonly error: string };

export interface ThreadSummary {
  readonly chatId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly worktreeId: string | null;
  readonly status: string;
  readonly spawnedByMe: boolean;
}

export type ListThreadsResult =
  | { readonly ok: true; readonly threads: ReadonlyArray<ThreadSummary> }
  | { readonly ok: false; readonly error: string };

export interface ProviderModelSummary {
  readonly id: string;
  readonly label: string;
  readonly defaultModel: boolean;
}

export interface ProviderSummary {
  readonly providerId: string;
  readonly defaultModel: string;
  readonly models: ReadonlyArray<ProviderModelSummary>;
}

export type ListModelsResult =
  | {
      readonly ok: true;
      readonly providers: ReadonlyArray<ProviderSummary>;
    }
  | { readonly ok: false; readonly error: string };

export interface WhoamiResult {
  readonly sessionId: string;
  readonly chatId: string | null;
  readonly projectId: string;
  readonly worktreeId: string | null;
  readonly providerId: string;
  readonly model: string;
  readonly autonomyLevel: string;
}

/**
 * The Effect-free surface `MessageStore` binds. Each call resolves to a result
 * object; rejections are not expected (MessageStore catches Effect failures).
 */
export interface OrchestrationToolDeps {
  readonly createWorktree: (input: {
    readonly baseBranch?: string;
  }) => Promise<CreateWorktreeResult>;
  readonly createThread: (input: {
    readonly title: string;
    readonly prompt: string;
    readonly worktreeId?: string;
    readonly providerId?: string;
    readonly model?: string;
  }) => Promise<CreateThreadResult>;
  readonly sendToThread: (input: {
    readonly sessionId: string;
    readonly text: string;
  }) => Promise<SendToThreadResult>;
  readonly readThread: (input: {
    readonly sessionId: string;
    readonly limit?: number;
  }) => Promise<ReadThreadResult>;
  readonly listThreads: (input: {
    readonly includeArchived?: boolean;
  }) => Promise<ListThreadsResult>;
  readonly listModels: (input: {
    readonly providerId?: string;
  }) => Promise<ListModelsResult>;
  readonly whoami: () => Promise<WhoamiResult>;
}

export interface OrchestrationSessionTools {
  readonly deps: OrchestrationToolDeps;
  readonly claudeTools: ReadonlyArray<unknown>;
}

// ── MCP text-result helpers ─────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

export type OrchestrationMcpToolResult = {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: boolean;
};

export type OrchestrationToolName =
  | "create_worktree"
  | "create_thread"
  | "send_to_thread"
  | "read_thread"
  | "list_threads"
  | "list_models"
  | "whoami";

export type OrchestrationMcpToolDef = {
  readonly name: OrchestrationToolName;
  readonly description: string;
  readonly inputSchema: JsonObject;
};

const objectSchema = (
  properties: JsonObject,
  required: ReadonlyArray<string> = [],
): JsonObject => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const stringProp = (description: string): JsonObject => ({
  type: "string",
  description,
});

const booleanProp = (description: string): JsonObject => ({
  type: "boolean",
  description,
});

const numberProp = (description: string, maximum?: number): JsonObject => ({
  type: "number",
  description,
  ...(maximum !== undefined ? { maximum } : {}),
});

export const ORCHESTRATION_MCP_SERVER_NAME = "zuse-orchestration";

const CREATE_WORKTREE_DESCRIPTION =
  "Create a new WORKSPACE: a fresh git worktree (isolated checkout on its own branch) in this project. Zuse's model is project -> workspaces (worktrees) -> chat threads, and ONE workspace can host MANY chat threads. A workspace is NOT a chat: only call this when the new work needs its own branch + PR that must not collide with other work. To start another conversation in an EXISTING workspace (including this one), skip this tool and call create_thread with that worktreeId, or omit worktreeId to use the project's main checkout. Returns { worktreeId, path, branch } — pass worktreeId to create_thread. This is a real, user-visible workspace (it appears in the sidebar), not a temp dir.";

const CREATE_THREAD_DESCRIPTION =
  "Open a NEW chat thread (a conversation with its own agent session) and hand it a task. This is how you spawn parallel work the user can watch in the sidebar. A thread lives inside a workspace: pass a worktreeId (from create_worktree, or reuse one from list_threads) to run it in that workspace; omit worktreeId to run in the project's main checkout. Creating a thread does NOT create a workspace — multiple threads can share one workspace, and you should NOT call create_worktree per thread unless the task needs its own branch/PR. Returns { chatId, sessionId, title }; use the sessionId with send_to_thread / read_thread to steer and inspect it. If you override providerId but omit model, Zuse uses that provider's configured default model rather than inheriting your current model.";

const SEND_TO_THREAD_DESCRIPTION =
  "Send a follow-up message to an existing thread's session (e.g. one you spawned with create_thread). The message is handed to the target session immediately and the receiving agent sees it attributed to you; it does not create a new thread or workspace. Use to deliver review feedback, a next instruction, or a 'you're done, stop' signal. Returns { ok, chatId, queued } — queued is always false today (delivery is immediate).";

const READ_THREAD_DESCRIPTION =
  "Read a thread's recent messages and current status (idle / running / closed / error). Use to check what a spawned thread has done — e.g. read a review thread's findings before deciding to merge. Returns { status, messages: [{ role, text }] }. Read-only.";

const LIST_THREADS_DESCRIPTION =
  "List the chat threads in this project with their workspace (worktreeId — null means the project's main checkout), status, and whether you spawned them. Threads that share a worktreeId share one workspace. Use to see the topology of work (which workspaces exist, which threads live in them) before creating more workspaces or threads. Read-only.";

const LIST_MODELS_DESCRIPTION =
  "List providers and model slugs available for create_thread. Use this before overriding providerId/model so you can choose a valid pair. Pass providerId to narrow the result. Returns { providers: [{ providerId, defaultModel, models: [{ id, label, defaultModel }] }] }. Read-only.";

const WHOAMI_DESCRIPTION =
  "Return your own session id, chat id, project id, workspace (worktreeId — null means the project's main checkout), providerId, model, and autonomy level. Use to reason about your own constraints and location before spawning more work. Read-only.";

export const ORCHESTRATION_MCP_TOOLS: ReadonlyArray<OrchestrationMcpToolDef> = [
  {
    name: "create_worktree",
    description: CREATE_WORKTREE_DESCRIPTION,
    inputSchema: objectSchema({
      baseBranch: stringProp(
        "Branch to fork from. Defaults to the project's main branch.",
      ),
    }),
  },
  {
    name: "create_thread",
    description: CREATE_THREAD_DESCRIPTION,
    inputSchema: objectSchema(
      {
        title: stringProp("Short human-readable thread title."),
        prompt: stringProp(
          "The initial task/instructions for the spawned agent.",
        ),
        worktreeId: stringProp(
          "Run the thread in this workspace (a worktreeId from create_worktree or list_threads). Omit to run in the project's main checkout.",
        ),
        providerId: stringProp(
          "Provider for the new thread. Defaults to yours.",
        ),
        model: stringProp(
          "Model slug for the new thread. Defaults to yours when providerId is omitted; if providerId is overridden, defaults to that provider's configured default model.",
        ),
      },
      ["title", "prompt"],
    ),
  },
  {
    name: "send_to_thread",
    description: SEND_TO_THREAD_DESCRIPTION,
    inputSchema: objectSchema(
      {
        sessionId: stringProp("Target session id from create_thread."),
        text: stringProp("Message to send to the target thread."),
      },
      ["sessionId", "text"],
    ),
  },
  {
    name: "read_thread",
    description: READ_THREAD_DESCRIPTION,
    inputSchema: objectSchema(
      {
        sessionId: stringProp("Target session id from create_thread."),
        limit: numberProp(
          "Max messages to return (most recent). Default 20.",
          50,
        ),
      },
      ["sessionId"],
    ),
  },
  {
    name: "list_threads",
    description: LIST_THREADS_DESCRIPTION,
    inputSchema: objectSchema({
      includeArchived: booleanProp("Include archived chats/threads."),
    }),
  },
  {
    name: "list_models",
    description: LIST_MODELS_DESCRIPTION,
    inputSchema: objectSchema({
      providerId: stringProp(
        "Provider to inspect. Omit to list all providers.",
      ),
    }),
  },
  {
    name: "whoami",
    description: WHOAMI_DESCRIPTION,
    inputSchema: objectSchema({}),
  },
];

export const READ_ONLY_ORCHESTRATION_TOOLS = new Set<OrchestrationToolName>([
  "read_thread",
  "list_threads",
  "list_models",
  "whoami",
]);

export const MUTATING_ORCHESTRATION_TOOLS = new Set<OrchestrationToolName>([
  "create_worktree",
  "create_thread",
  "send_to_thread",
]);

const jsonResult = (value: unknown): OrchestrationMcpToolResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const settle = <T extends { readonly ok: boolean }>(
  result: T & { readonly error?: string },
): OrchestrationMcpToolResult =>
  result.ok
    ? jsonResult(result)
    : {
        content: [
          {
            type: "text" as const,
            text: result.error ?? "Orchestration action failed.",
          },
        ],
        isError: true as const,
      };

const asRecord = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};

const asString = (args: JsonObject, key: string): string | undefined =>
  typeof args[key] === "string" && args[key].length > 0
    ? (args[key] as string)
    : undefined;

const asBoolean = (args: JsonObject, key: string): boolean | undefined =>
  typeof args[key] === "boolean" ? (args[key] as boolean) : undefined;

const asLimit = (args: JsonObject): number | undefined =>
  typeof args["limit"] === "number" &&
  Number.isInteger(args["limit"]) &&
  args["limit"] > 0
    ? Math.min(args["limit"] as number, 50)
    : undefined;

export const isOrchestrationToolName = (
  name: string,
): name is OrchestrationToolName =>
  ORCHESTRATION_MCP_TOOLS.some((tool) => tool.name === name);

export const callOrchestrationTool = async (
  deps: OrchestrationToolDeps,
  name: OrchestrationToolName,
  rawArgs: unknown,
): Promise<OrchestrationMcpToolResult> => {
  const args = asRecord(rawArgs);
  switch (name) {
    case "create_worktree":
      return settle(
        await deps.createWorktree({ baseBranch: asString(args, "baseBranch") }),
      );
    case "create_thread": {
      const title = asString(args, "title");
      const prompt = asString(args, "prompt");
      if (title === undefined || prompt === undefined) {
        return {
          content: [
            { type: "text", text: "create_thread requires title and prompt." },
          ],
          isError: true,
        };
      }
      return settle(
        await deps.createThread({
          title,
          prompt,
          worktreeId: asString(args, "worktreeId"),
          providerId: asString(args, "providerId"),
          model: asString(args, "model"),
        }),
      );
    }
    case "send_to_thread": {
      const sessionId = asString(args, "sessionId");
      const text = asString(args, "text");
      if (sessionId === undefined || text === undefined) {
        return {
          content: [
            {
              type: "text",
              text: "send_to_thread requires sessionId and text.",
            },
          ],
          isError: true,
        };
      }
      return settle(await deps.sendToThread({ sessionId, text }));
    }
    case "read_thread": {
      const sessionId = asString(args, "sessionId");
      if (sessionId === undefined) {
        return {
          content: [{ type: "text", text: "read_thread requires sessionId." }],
          isError: true,
        };
      }
      return settle(await deps.readThread({ sessionId, limit: asLimit(args) }));
    }
    case "list_threads":
      return settle(
        await deps.listThreads({
          includeArchived: asBoolean(args, "includeArchived"),
        }),
      );
    case "list_models":
      return settle(
        await deps.listModels({
          providerId: asString(args, "providerId"),
        }),
      );
    case "whoami":
      return jsonResult(await deps.whoami());
  }
};

export const orchestrationMcpPromptHint = (): string => {
  const signature = (toolDef: OrchestrationMcpToolDef): string => {
    const properties =
      (toolDef.inputSchema["properties"] as
        | Record<string, unknown>
        | undefined) ?? {};
    const required = new Set(
      (toolDef.inputSchema["required"] as ReadonlyArray<string> | undefined) ??
        [],
    );
    const args = Object.keys(properties)
      .map((key) => (required.has(key) ? key : `${key}?`))
      .join(",");
    return `${toolDef.name}{${args}}`;
  };
  return [
    "<zuse-orchestration-tools>",
    `The "${ORCHESTRATION_MCP_SERVER_NAME}" MCP server lets this Zuse chat create real Zuse worktrees and real Zuse chat threads that appear in the sidebar.`,
    `Tools: ${ORCHESTRATION_MCP_TOOLS.map(signature).join(", ")}.`,
    "Model: project -> workspaces (worktrees) -> chat threads; one workspace hosts many threads. create_worktree makes a workspace, create_thread makes a thread — do not create a workspace per thread unless it needs its own branch/PR.",
    "Smoke flow: whoami -> list_threads -> list_models -> create_worktree -> create_thread -> read_thread.",
    "Do not substitute built-in Agent/Task, Codex worker/explorer/default subagents, or EnterWorktree/ExitWorktree. Those test different provider-native features, not Zuse self-orchestration.",
    "</zuse-orchestration-tools>",
  ].join("\n");
};

/**
 * Build the control-plane tool definitions. Descriptions are blunt on purpose
 * — the agent reads them to decide whether to spawn a separate thread (own
 * worktree, own PR, own transcript the user can watch) versus delegating to an
 * in-conversation sub-agent (Agent/Task) that shares this chat.
 */
export const buildOrchestrationTools = (deps: OrchestrationToolDeps) => [
  tool(
    "create_worktree",
    CREATE_WORKTREE_DESCRIPTION,
    {
      baseBranch: z
        .string()
        .optional()
        .describe(
          "Branch to fork from. Defaults to the project's main branch.",
        ),
    },
    async (args) =>
      settle(await deps.createWorktree({ baseBranch: args.baseBranch })),
  ),

  tool(
    "create_thread",
    CREATE_THREAD_DESCRIPTION,
    {
      title: z.string().min(1).describe("Short human-readable thread title."),
      prompt: z
        .string()
        .min(1)
        .describe("The initial task/instructions for the spawned agent."),
      worktreeId: z
        .string()
        .optional()
        .describe(
          "Run the thread in this workspace (a worktreeId from create_worktree or list_threads). Omit to run in the project's main checkout.",
        ),
      providerId: z
        .string()
        .optional()
        .describe(
          "Provider for the new thread (e.g. 'claude'). Defaults to yours.",
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Model slug for the new thread. Defaults to yours when providerId is omitted; if providerId is overridden, defaults to that provider's configured default model.",
        ),
    },
    async (args) =>
      settle(
        await deps.createThread({
          title: args.title,
          prompt: args.prompt,
          worktreeId: args.worktreeId,
          providerId: args.providerId,
          model: args.model,
        }),
      ),
  ),

  tool(
    "send_to_thread",
    SEND_TO_THREAD_DESCRIPTION,
    {
      sessionId: z.string().min(1),
      text: z.string().min(1),
    },
    async (args) =>
      settle(
        await deps.sendToThread({ sessionId: args.sessionId, text: args.text }),
      ),
  ),

  tool(
    "read_thread",
    READ_THREAD_DESCRIPTION,
    {
      sessionId: z.string().min(1),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Max messages to return (most recent). Default 20."),
    },
    async (args) =>
      settle(
        await deps.readThread({ sessionId: args.sessionId, limit: args.limit }),
      ),
  ),

  tool(
    "list_threads",
    LIST_THREADS_DESCRIPTION,
    {
      includeArchived: z.boolean().optional(),
    },
    async (args) =>
      settle(await deps.listThreads({ includeArchived: args.includeArchived })),
  ),

  tool(
    "list_models",
    LIST_MODELS_DESCRIPTION,
    {
      providerId: z
        .string()
        .optional()
        .describe("Provider to inspect. Omit to list all providers."),
    },
    async (args) =>
      settle(await deps.listModels({ providerId: args.providerId })),
  ),

  tool("whoami", WHOAMI_DESCRIPTION, {}, async () =>
    jsonResult(await deps.whoami()),
  ),
];
