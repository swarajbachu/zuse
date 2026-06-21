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
 * whoami) are auto-allowed by the driver alongside the index reads.
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
  | { readonly ok: true; readonly queued: boolean }
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
  readonly status: string;
  readonly spawnedByMe: boolean;
}

export type ListThreadsResult =
  | { readonly ok: true; readonly threads: ReadonlyArray<ThreadSummary> }
  | { readonly ok: false; readonly error: string };

export interface WhoamiResult {
  readonly sessionId: string;
  readonly chatId: string | null;
  readonly projectId: string;
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
  readonly whoami: () => Promise<WhoamiResult>;
}

// ── MCP text-result helpers ─────────────────────────────────────────────────

const jsonResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const settle = <T extends { readonly ok: boolean }>(
  result: T & { readonly error?: string },
) =>
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

/**
 * Build the control-plane tool definitions. Descriptions are blunt on purpose
 * — the agent reads them to decide whether to spawn a separate thread (own
 * worktree, own PR, own transcript the user can watch) versus delegating to an
 * in-conversation sub-agent (Agent/Task) that shares this chat.
 */
export const buildOrchestrationTools = (deps: OrchestrationToolDeps) => [
  tool(
    "create_worktree",
    "Create a fresh git worktree (isolated checkout on its own branch) in this project. Use BEFORE create_thread when the new work needs its own branch + PR so it can't collide with what you're doing now. Returns { worktreeId, path, branch } — pass the worktreeId to create_thread. This is a real, user-visible worktree (it appears in the sidebar), not a temp dir.",
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
    "Open a NEW chat thread with its own agent session and hand it a task. This is how you spawn parallel work the user can watch in the sidebar — Codex-style 'a thread spawns another thread'. Prefer this over an in-conversation sub-agent when the work deserves its own worktree/PR/review cycle. Pass a worktreeId (from create_worktree) to isolate it. Returns { chatId, sessionId, title }; use the sessionId with send_to_thread / read_thread to steer and inspect it.",
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
          "Run the thread in this worktree (from create_worktree). Omit to run in the project's main checkout.",
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
        .describe("Model slug for the new thread. Defaults to yours."),
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
    "Send a follow-up message to an existing thread's session (e.g. one you spawned with create_thread). If the target is mid-turn the message is queued and delivered when it goes idle. Use to deliver review feedback, a next instruction, or a 'you're done, stop' signal. Returns { ok, queued }.",
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
    "Read a thread's recent messages and current status (idle / running / closed / error). Use to check what a spawned thread has done — e.g. read a review thread's findings before deciding to merge. Returns { status, messages: [{ role, text }] }. Read-only.",
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
    "List the chat threads in this project with their status and whether you spawned them. Use to see the tree of work you've created before spawning more or deciding what to merge. Read-only.",
    {
      includeArchived: z.boolean().optional(),
    },
    async (args) =>
      settle(await deps.listThreads({ includeArchived: args.includeArchived })),
  ),

  tool(
    "whoami",
    "Return your own session id, chat id, project id, and autonomy level. Use to reason about your own constraints before spawning more work. Read-only.",
    {},
    async () => jsonResult(await deps.whoami()),
  ),
];
