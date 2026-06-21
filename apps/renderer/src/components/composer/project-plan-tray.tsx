import {
  ArrowDown01Icon,
  CheckListIcon,
  Tick02Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";

import type { Message, SessionId } from "@memoize/wire";

import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

import { useMessagesStore } from "../../store/messages.ts";

const TODO_STATUS = {
  pending: "pending",
  inProgress: "in_progress",
  completed: "completed",
} as const;

type TodoStatus = (typeof TODO_STATUS)[keyof typeof TODO_STATUS];

const TASK_DELETED_STATUS = "deleted";

const COMPLETED_STATUS_VALUES = new Set<unknown>([TODO_STATUS.completed]);
const IN_PROGRESS_STATUS_VALUES = new Set<unknown>([
  TODO_STATUS.inProgress,
  "inProgress",
  "running",
]);

interface Todo {
  readonly text: string;
  readonly status: TodoStatus;
}

const EMPTY_MESSAGES: ReadonlyArray<Message> = [];

const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

const asStatus = (v: unknown): TodoStatus => {
  if (COMPLETED_STATUS_VALUES.has(v)) return TODO_STATUS.completed;
  if (IN_PROGRESS_STATUS_VALUES.has(v)) return TODO_STATUS.inProgress;
  return TODO_STATUS.pending;
};

/** Normalize a raw `[{ content, activeForm, status }]` array into our shape. */
const toTodos = (raw: unknown): Todo[] => {
  if (!Array.isArray(raw)) return [];
  const out: Todo[] = [];
  for (const t of raw) {
    if (t === null || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    const text = asString(r.content) ?? asString(r.activeForm) ?? "";
    if (text.length === 0) continue;
    out.push({ text, status: asStatus(r.status) });
  }
  return out;
};

/**
 * Parse a `TodoWrite` tool *input* (`{ todos: [...] }`). This is the shape the
 * Claude driver emits directly on the tool_use event.
 */
const parseTodosFromInput = (input: unknown): Todo[] => {
  if (input === null || typeof input !== "object") return [];
  return toTodos((input as Record<string, unknown>).todos);
};

/**
 * Parse a `TodoWrite` tool *result* `output`. Grok (via ACP) only carries a
 * title on the tool_use input — the actual list arrives on the tool_result as
 * `{ type: "Todo", TodosUpdated: { todos: [{ content, priority, status }] } }`.
 * We detect that self-identifying shape so we don't mistake an unrelated
 * tool result for a plan.
 */
const parseTodosFromOutput = (output: unknown): Todo[] => {
  if (output === null || typeof output !== "object") return [];
  const o = output as Record<string, unknown>;
  const updated = o.TodosUpdated;
  if (updated !== null && typeof updated === "object") {
    const todos = toTodos((updated as Record<string, unknown>).todos);
    if (todos.length > 0) return todos;
  }
  if (o.type === "Todo") return toTodos(o.todos);
  return [];
};

/** Coerce an arbitrary tool `output` into searchable text. */
const outputToString = (output: unknown): string => {
  if (typeof output === "string") return output;
  if (output !== null && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.content === "string") return o.content;
    if (typeof o.text === "string") return o.text;
    try {
      return JSON.stringify(output);
    } catch {
      return "";
    }
  }
  return "";
};

/**
 * The newer Claude Agent SDK plans with incremental `TaskCreate`/`TaskUpdate`
 * tools instead of `TodoWrite`'s single snapshot. A create's *result* carries
 * both the id and title (`Task #4 created successfully: <subject>`); an update's
 * *input* carries `{ taskId, status }`. Reconstruct the live list from those.
 */
const parseTaskCreated = (
  output: unknown,
): { id: string; subject: string } | null => {
  const m = outputToString(output).match(/Task #(\d+) created[^:]*:\s*(.+)/i);
  if (m === null) return null;
  return { id: m[1]!, subject: m[2]!.trim() };
};

const parseTaskUpdate = (
  input: unknown,
): {
  id: string;
  status?: TodoStatus | typeof TASK_DELETED_STATUS;
  subject?: string;
} | null => {
  if (input === null || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  const id = r.taskId;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const raw = r.status;
  const status =
    raw === undefined
      ? undefined
      : raw === TASK_DELETED_STATUS
        ? TASK_DELETED_STATUS
        : asStatus(raw);
  return {
    id: String(id),
    status,
    subject: typeof r.subject === "string" ? r.subject : undefined,
  };
};

interface ReconstructedTask {
  text: string;
  status: TodoStatus;
  order: number;
}

/** Build the current task list by replaying TaskCreate/TaskUpdate events. */
const tasksFromMessages = (messages: ReadonlyArray<Message>): Todo[] => {
  const tasks = new Map<string, ReconstructedTask>();
  let order = 0;
  for (const m of messages) {
    const c = m.content;
    if (c._tag === "tool_result") {
      const created = parseTaskCreated(c.output);
      if (created !== null) {
        const existing = tasks.get(created.id);
        if (existing === undefined) {
          tasks.set(created.id, {
            text: created.subject,
            status: TODO_STATUS.pending,
            order: order++,
          });
        } else {
          existing.text = created.subject;
        }
      }
    } else if (c._tag === "tool_use" && c.tool === "TaskUpdate") {
      const upd = parseTaskUpdate(c.input);
      if (upd === null) continue;
      if (upd.status === TASK_DELETED_STATUS) {
        tasks.delete(upd.id);
        continue;
      }
      const existing = tasks.get(upd.id);
      if (existing === undefined) {
        tasks.set(upd.id, {
          text: upd.subject ?? `Task ${upd.id}`,
          status: upd.status ?? TODO_STATUS.pending,
          order: order++,
        });
      } else {
        if (upd.status !== undefined) existing.status = upd.status;
        if (upd.subject !== undefined) existing.text = upd.subject;
      }
    }
  }
  return Array.from(tasks.values())
    .sort((a, b) => a.order - b.order)
    .map((t) => ({ text: t.text, status: t.status }));
};

const activeHeaderTodo = (todos: ReadonlyArray<Todo>): Todo | undefined =>
  todos.find((t) => t.status === TODO_STATUS.inProgress) ??
  todos.find((t) => t.status !== TODO_STATUS.completed) ??
  todos.at(-1);

/**
 * "Project Plan" panel docked above the composer. Surfaces the agent's live
 * plan — reconstructed from the newer `TaskCreate`/`TaskUpdate` tools, falling
 * back to a legacy `TodoWrite` snapshot — as a
 * glanceable, collapsible progress view: header with an `X of Y Done` count and
 * a spinner while the turn runs, expanding to a timeline of items with per-item
 * status icons. Renders nothing until a session has produced a TodoWrite list,
 * and persists after the turn ends.
 */
export function ProjectPlanTray({ sessionId }: { sessionId: SessionId }) {
  // Select the stable message-array reference and derive the latest plan with
  // useMemo — selecting a freshly-built array would re-render on every store tick.
  const messages = useMessagesStore(
    (s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES,
  );
  const running = useMessagesStore(
    (s) => s.runningBySession[sessionId] === true,
  );

  // Collapsed by default; keyed per session so the expand state doesn't bleed
  // across session switches (see `key` at the call site).
  const [expanded, setExpanded] = useState(false);

  const todos = useMemo(() => {
    // Preferred: the newer Task tools (TaskCreate/TaskUpdate), replayed into a
    // live list. This is what current Claude (Agent SDK ≥ 0.2.x) sessions emit
    // instead of TodoWrite.
    const tasks = tasksFromMessages(messages);
    if (tasks.length > 0) return tasks;
    // Fallback: legacy TodoWrite single-snapshot. Walk newest→oldest and take
    // the first signal — Claude puts the list on the tool_use input; Grok (ACP)
    // puts it on the tool_result output. Whichever is latest wins.
    for (let i = messages.length - 1; i >= 0; i--) {
      const c = messages[i]!.content;
      if (c._tag === "tool_use" && c.tool === "TodoWrite") {
        const parsed = parseTodosFromInput(c.input);
        if (parsed.length > 0) return parsed;
      } else if (c._tag === "tool_result") {
        const parsed = parseTodosFromOutput(c.output);
        if (parsed.length > 0) return parsed;
      }
    }
    return [];
  }, [messages]);

  if (todos.length === 0) return null;

  const done = todos.filter((t) => t.status === TODO_STATUS.completed).length;
  const total = todos.length;
  const headerTodo = activeHeaderTodo(todos);

  return (
    <div className="mb-1.5 overflow-hidden rounded-lg border border-border/60 bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors",
          "bg-primary/10 hover:bg-primary/15",
        )}
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {headerTodo === undefined ? (
            <HugeiconsIcon
              icon={CheckListIcon}
              strokeWidth={2}
              className="size-3.5 text-muted-foreground"
              aria-hidden="true"
            />
          ) : (
            <TodoStatusIcon status={headerTodo.status} running={running} />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {headerTodo?.text ?? "Project Plan"}
        </span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {done} of {total} Done
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            expanded ? "rotate-180" : "",
          )}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <ul className="max-h-64 space-y-0.5 overflow-y-auto px-3 py-2">
          {todos.map((t, i) => (
            <li key={i} className="relative flex items-start gap-2.5 pb-1.5">
              {/* Dashed timeline connector running between item icons. */}
              {i < todos.length - 1 ? (
                <span
                  className="absolute left-[6.5px] top-4 bottom-0 border-l border-dashed border-border/60"
                  aria-hidden="true"
                />
              ) : null}
              <span className="relative z-10 mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
                <TodoStatusIcon status={t.status} running={running} />
              </span>
              <span
                className={cn(
                  "text-sm leading-snug",
                  t.status === TODO_STATUS.completed
                    ? "text-muted-foreground"
                    : "text-foreground",
                )}
              >
                {t.text}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TodoStatusIcon({
  status,
  running,
}: {
  status: TodoStatus;
  running: boolean;
}) {
  if (status === TODO_STATUS.completed) {
    return (
      <HugeiconsIcon
        icon={Tick02Icon}
        strokeWidth={2.5}
        className="size-3.5 text-primary"
        aria-label="Completed"
      />
    );
  }
  if (status === TODO_STATUS.inProgress) {
    // Only animate while the turn is actually running. Once the agent stops
    // (or finishes) the item stays marked current in the data, so a
    // spinning loader would imply work is still happening when it isn't — and
    // makes the whole composer read as "busy". Show a static filled ring
    // instead to mark "current step, not running".
    if (running)
      return (
        <Spinner className="size-3.5 text-primary" />
      );
    return (
      <span
        className="flex size-3.5 items-center justify-center rounded-full border-2 border-primary"
        aria-label="In progress (paused)"
      >
        <span className="size-1 rounded-full bg-primary" />
      </span>
    );
  }
  return (
    <span
      className="size-3 rounded-full border border-dashed border-muted-foreground/50"
      aria-label="Pending"
    />
  );
}
