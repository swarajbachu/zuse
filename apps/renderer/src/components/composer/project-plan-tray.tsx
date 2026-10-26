import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type { EnvironmentId, Message, SessionId } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { CheckListIcon, Tick02Icon } from "@zuse/icons/solid-rounded";
import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";

import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

import { useRendererSessionTimeline } from "../../lib/session-timeline-hooks.ts";
import { TrayPill, trayPillActionClass } from "./tray-pill.tsx";

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

const asString = (v: unknown): string | undefined =>
	typeof v === "string" ? v : undefined;

const asStatus = (v: unknown): TodoStatus => {
	if (COMPLETED_STATUS_VALUES.has(v)) return TODO_STATUS.completed;
	if (IN_PROGRESS_STATUS_VALUES.has(v)) return TODO_STATUS.inProgress;
	return TODO_STATUS.pending;
};

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

const parseTodosFromInput = (input: unknown): Todo[] => {
	if (input === null || typeof input !== "object") return [];
	return toTodos((input as Record<string, unknown>).todos);
};

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

const outputToString = (output: unknown): string => {
	if (typeof output === "string") return output;
	if (Array.isArray(output)) return output.map(outputToString).join("\n");
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
 * tools instead of `TodoWrite`'s single snapshot. A create's structured result
 * carries `task: { id, subject }`; older CLIs return a text confirmation. An update's
 * *input* carries `{ taskId, status }`. Reconstruct the live list from those.
 */
const parseTaskCreated = (
	output: unknown,
): { id: string; subject: string } | null => {
	if (output !== null && typeof output === "object" && "task" in output) {
		const task = output.task;
		if (
			task !== null &&
			typeof task === "object" &&
			"id" in task &&
			"subject" in task &&
			typeof task.id === "string" &&
			typeof task.subject === "string"
		) {
			return { id: task.id, subject: task.subject };
		}
	}
	const m = outputToString(output).match(/Task #(\d+) created[^:]*:\s*(.+)/i);
	if (m === null) return null;
	const id = m[1];
	const subject = m[2];
	if (id === undefined || subject === undefined) return null;
	return { id, subject: subject.trim() };
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
	const id = r.taskId ?? r.id ?? r.task_id;
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

const tasksFromMessages = (messages: ReadonlyArray<Message>): Todo[] => {
	const tasks = new Map<string, ReconstructedTask>();
	let order = 0;
	for (const m of messages) {
		const c = m.content;
		if (c._tag === "tool_result") {
			if (c.isError) continue;
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

export const projectPlanFromMessages = (
	allMessages: ReadonlyArray<Message>,
): Todo[] => {
	const messages = allMessages.filter(
		(m) =>
			!("parentItemId" in m.content) || m.content.parentItemId === undefined,
	);
	const latestSnapshot = messages.findLastIndex(
		(m) => m.content._tag === "tool_use" && m.content.tool === "TodoWrite",
	);
	const incrementalMessages = messages.slice(latestSnapshot + 1);
	if (
		incrementalMessages.some(
			(m) =>
				m.content._tag === "tool_use" &&
				(m.content.tool === "TaskCreate" || m.content.tool === "TaskUpdate"),
		)
	) {
		return tasksFromMessages(incrementalMessages);
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const content = messages[i]?.content;
		if (content === undefined) continue;
		if (content._tag === "tool_use" && content.tool === "TodoWrite") {
			return parseTodosFromInput(content.input);
		} else if (content._tag === "tool_result") {
			const parsed = parseTodosFromOutput(content.output);
			if (parsed.length > 0) return parsed;
		}
	}
	return [];
};

/**
 * "Project Plan" panel docked above the composer. Surfaces the agent's live
 * plan — reconstructed from the newer `TaskCreate`/`TaskUpdate` tools, falling
 * back to a `TodoWrite` snapshot (including native Codex plans) — as a
 * glanceable, collapsible progress view: header with an `X of Y Done` count and
 * a spinner while the turn runs, expanding to a timeline of items with per-item
 * status icons. Renders nothing until a session has produced a task list,
 * and persists after the turn ends.
 */
export function ProjectPlanTray({
	sessionId,
	environmentId,
}: {
	sessionId: SessionId;
	environmentId: EnvironmentId;
}) {
	const { messages } = useRendererSessionTimeline(
		sessionId,
		"connect",
		environmentId,
	);

	const [expanded, setExpanded] = useState(false);

	const todos = useMemo(() => {
		return projectPlanFromMessages(messages);
	}, [messages]);

	if (todos.length === 0) return null;

	const done = todos.filter((t) => t.status === TODO_STATUS.completed).length;
	const total = todos.length;
	const headerTodo = activeHeaderTodo(todos);

	const icon =
		headerTodo === undefined ? (
			<HugeiconsIcon
				icon={CheckListIcon}
				strokeWidth={2}
				className="size-3.5"
				aria-hidden="true"
			/>
		) : (
			<TodoStatusIcon status={headerTodo.status} />
		);

	return (
		<TrayPill
			flush
			className="bg-primary/10 hover:bg-primary/15"
			icon={icon}
			title={
				headerTodo?.text ?? uiMessage("projects:project_plan_tray_project_plan")
			}
			subtitle={`${done} of ${total} Done`}
			onPillClick={() => setExpanded((v) => !v)}
			ariaExpanded={expanded}
			ariaLabel={
				expanded
					? uiMessage("common:collapse_plan")
					: uiMessage("common:expand_plan")
			}
			actions={
				<button
					type="button"
					className={trayPillActionClass}
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
					aria-label={
						expanded
							? uiMessage("common:collapse_plan")
							: uiMessage("common:expand_plan")
					}
				>
					<ChevronDown
						className={cn(
							"size-4 text-muted-foreground transition-transform",
							expanded ? "rotate-180" : "",
						)}
						aria-hidden="true"
					/>
				</button>
			}
			expanded={
				expanded ? (
					<ul className="max-h-64 space-y-0.5 overflow-y-auto px-3 py-2">
						{todos.map((t, i) => (
							<li key={i} className="relative flex items-start gap-2.5 pb-1.5">
								{i < todos.length - 1 ? (
									<span
										className="absolute left-[6.5px] top-4 bottom-0 border-l border-dashed border-border/60"
										aria-hidden="true"
									/>
								) : null}
								<span className="relative z-10 mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
									<TodoStatusIcon status={t.status} />
								</span>
								<span
									className={cn(
										"text-[13px] leading-snug",
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
				) : undefined
			}
		/>
	);
}

function TodoStatusIcon({ status }: { status: TodoStatus }) {
	const { message: uiMessage } = useUiMessages(["projects"]);

	if (status === TODO_STATUS.completed) {
		return (
			<HugeiconsIcon
				icon={Tick02Icon}
				strokeWidth={2.5}
				className="size-3.5 text-primary"
				aria-label={uiMessage("projects:project_plan_tray_completed")}
			/>
		);
	}
	if (status === TODO_STATUS.inProgress) {
		return <Spinner className="size-3.5 text-primary" />;
	}
	return (
		<span
			role="img"
			className="size-3 rounded-full border border-dashed border-muted-foreground/50"
			aria-label={uiMessage("projects:project_plan_tray_pending")}
		/>
	);
}
