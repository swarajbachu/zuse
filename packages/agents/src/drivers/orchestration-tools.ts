import { tool } from "@anthropic-ai/claude-agent-sdk";
import type {
	PermissionDecision,
	PermissionKind,
	PermissionMode,
	RuntimeMode,
	SessionWaitOptions,
	SessionWaitResult,
} from "@zuse/contracts";
import { generativeUiComponentLines } from "@zuse/utils/generative-ui";
import { z } from "zod";
import { getToolPolicy } from "../kernel/policy.ts";
import {
	AUTOMATION_TOOL_DEFINITIONS,
	type AutomationToolDependencies,
	type AutomationToolName,
	buildAutomationTools,
	callAutomationTool,
} from "./automation-tools.ts";
import { generativeUiResponseInstructions } from "./generative-ui-instructions.ts";
import {
	booleanProp,
	type JsonSchemaObject,
	objectSchema,
	stringProp,
} from "./mcp-tool-schema.ts";
import {
	ORCHESTRATION_READ_LIMIT,
	ORCHESTRATION_TEXT_LIMIT,
	type OrchestrationCapabilitiesResult,
	type OrchestrationReadInput,
} from "./orchestration-discovery.ts";

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
			readonly worktreeId: string;
			readonly path: string;
			readonly branch: string;
	  }
	| { readonly ok: false; readonly error: string };

export type CreateSessionResult =
	| {
			readonly ok: true;
			readonly chatId: string;
			readonly sessionId: string;
			readonly title: string;
			readonly worktreeId: string | null;
	  }
	| { readonly ok: false; readonly error: string };

export type SendToThreadResult =
	| {
			readonly ok: true;
			readonly queued: boolean;
			readonly chatId: string;
			readonly wait?: SessionWaitResult;
	  }
	| { readonly ok: false; readonly error: string };

export interface ThreadMessage {
	readonly id?: string;
	readonly nextTextOffset?: number | null;
	readonly truncated?: boolean;
	readonly role: string;
	readonly text: string;
}

export type ReadThreadResult =
	| {
			readonly ok: true;
			readonly status: string;
			readonly messages: ReadonlyArray<ThreadMessage>;
			readonly nextMessageId?: string | null;
			readonly hasMore?: boolean;
	  }
	| { readonly ok: false; readonly error: string };

export interface ThreadSummary {
	readonly chatId: string;
	readonly sessionId: string;
	readonly title: string;
	readonly worktreeId: string | null;
	readonly status: string;
	readonly spawnedByMe: boolean;
	/** Durable managed-task lineage; native provider children are not session tabs. */
	readonly parentSessionId?: string | null;
	/** Chat-level lineage may exist without a managed task (for older chats). */
	readonly chatOriginSessionId?: string | null;
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
	readonly permissionMode?: PermissionMode;
	readonly runtimeMode?: RuntimeMode;
	readonly sessionId: string;
	readonly chatId: string | null;
	readonly projectId: string;
	readonly worktreeId: string | null;
	readonly providerId: string;
	readonly model: string;
	readonly autonomyLevel: string;
}

export type EmitUiResult =
	| { readonly ok: true; readonly messageId: string }
	| { readonly ok: false; readonly error: string };

/**
 * The Effect-free surface `ConversationServices` binds. Each call resolves to a result
 * object; rejections are not expected (ConversationServices catches Effect failures).
 */
export type DelegateTaskInput = {
	readonly task: string;
	readonly clientRequestId: string;
	readonly role?: string;
	readonly title?: string;
	readonly providerId?: string;
	readonly model?: string;
};
export type TaskResult =
	| {
			readonly ok: true;
			readonly taskId: string;
			readonly sessionId: string;
			readonly status: string;
			readonly workState:
				| "working"
				| "waiting_for_children"
				| "result_available"
				| "cancelled";
			readonly result?: string;
	  }
	| { readonly ok: false; readonly error: string };
export type ThreadSendMode = "auto" | "queue" | "steer" | "restart";
export interface OrchestrationToolDeps {
	readonly projectAutomation?: (input?: {
		readonly configJson: string;
		readonly requestId: string;
		readonly id?: string;
		readonly expectedRevision?: number;
	}) => Promise<unknown>;
	readonly automation?: AutomationToolDependencies;
	readonly capabilities?: () => Promise<OrchestrationCapabilitiesResult>;
	readonly delegateTask?: (input: DelegateTaskInput) => Promise<TaskResult>;
	readonly taskStatus?: (input: {
		readonly taskId: string;
	}) => Promise<TaskResult>;
	readonly taskCancel?: (input: {
		readonly taskId: string;
	}) => Promise<TaskResult>;
	readonly interruptThread?: (input: {
		readonly sessionId: string;
		readonly commandId?: string;
	}) => Promise<
		{ readonly ok: true } | { readonly ok: false; readonly error: string }
	>;
	readonly master?: (
		commandJson?: string,
		readOnly?: boolean,
		/** Stable per operation so a retried action returns its first result. */
		commandId?: string,
	) => Promise<unknown>;
	readonly createWorktree: (input: {
		readonly baseBranch?: string;
	}) => Promise<CreateWorktreeResult>;
	readonly createThread: (input: {
		readonly task: string;
		readonly title?: string;
		readonly baseBranch?: string;
		readonly providerId?: string;
		readonly model?: string;
	}) => Promise<CreateThreadResult>;
	readonly createSession: (input: {
		readonly task: string;
		readonly chatId?: string;
		readonly title?: string;
		readonly providerId?: string;
		readonly model?: string;
	}) => Promise<CreateSessionResult>;
	readonly sendToThread: (input: {
		readonly sessionId: string;
		readonly text: string;
		readonly commandId?: string;
		readonly mode?: ThreadSendMode;
		readonly wait?: SessionWaitOptions;
	}) => Promise<SendToThreadResult>;
	readonly waitForThread?: (input: {
		readonly sessionId: string;
		readonly turnId?: string;
		readonly attemptId?: string;
		readonly target: "idle" | "blocked" | "done";
		readonly timeoutMs?: number;
	}) => Promise<
		| { readonly ok: true; readonly wait: SessionWaitResult }
		| { readonly ok: false; readonly error: string }
	>;
	readonly readThread: (
		input: OrchestrationReadInput,
	) => Promise<ReadThreadResult>;
	readonly listThreads: (input: {
		readonly includeArchived?: boolean;
	}) => Promise<ListThreadsResult>;
	readonly listModels: (input: {
		readonly providerId?: string;
	}) => Promise<ListModelsResult>;
	readonly whoami: () => Promise<WhoamiResult>;
	/**
	 * Persist a generative-UI block (OpenUI Lang spec) into this session's
	 * transcript. Display-only — the block carries no callbacks or actions.
	 */
	readonly emitUi: (input: { readonly spec: string }) => Promise<EmitUiResult>;
}

export interface OrchestrationPermissionOptions {
	readonly requestPermission: (
		kind: PermissionKind,
		options: { readonly forcePrompt: boolean },
	) => Promise<PermissionDecision>;
	readonly getRuntimeMode: () => RuntimeMode;
	readonly getPermissionMode: () => PermissionMode;
}

export interface OrchestrationSessionTools {
	readonly instructions?: string;
	readonly deps: OrchestrationToolDeps;
	readonly claudeTools: ReturnType<typeof buildOrchestrationTools>;
}

type JsonObject = JsonSchemaObject;

export type OrchestrationMcpToolResult = {
	readonly content: Array<{ readonly type: "text"; readonly text: string }>;
	readonly isError?: boolean;
};

export type OrchestrationToolName =
	| AutomationToolName
	| "orchestrator_capabilities"
	| "delegate_task"
	| "task_status"
	| "task_cancel"
	| "interrupt_thread"
	| "create_thread"
	| "create_session"
	| "send_to_thread"
	| "wait_for_thread"
	| "read_thread"
	| "list_threads"
	| "list_models"
	| "whoami"
	| "emit_ui"
	| "automation_catalog"
	| "automation_save"
	| "master_state"
	| "master_action";

export type OrchestrationMcpToolDef = {
	readonly name: OrchestrationToolName;
	readonly description: string;
	readonly inputSchema: JsonObject;
};

export const ORCHESTRATION_MCP_SERVER_NAME = "zuse-orchestration";

const CREATE_THREAD_DESCRIPTION =
	"Spawn ISOLATED parallel work: create_thread ALWAYS creates a new Zuse workspace (a fresh git worktree on its own branch, visible in the sidebar) and then opens a new sidebar chat with an initial session inside it. Use this when the task needs its own branch/PR and must not collide with existing work. To open another tab in an EXISTING sidebar chat, use create_session instead. Input task is the work to assign. Returns { chatId, sessionId, title, worktreeId, path, branch }; use sessionId with send_to_thread / read_thread. If you override providerId but omit model, Zuse uses that provider's configured default model rather than inheriting your current model.";

const CREATE_SESSION_DESCRIPTION =
	"Open a NEW SESSION TAB inside an EXISTING sidebar chat; this never creates a worktree and never creates a new sidebar chat. Omit chatId to add the tab to YOUR OWN current chat, or pass a chatId from list_threads. The new session inherits that chat's workspace/worktree. Use this for another tab/conversation sharing the same sidebar chat and checkout. Input task is the work to assign. Returns { chatId, sessionId, title, worktreeId }. If you override providerId but omit model, Zuse uses that provider's configured default model rather than inheriting your current model.";

const SEND_TO_THREAD_DESCRIPTION =
	"Send a follow-up message to an existing thread's session (e.g. one you spawned with create_thread). The message is admitted durably; it does not create a new thread or workspace. Use to deliver review feedback, a next instruction, or a 'you're done, stop' signal. Returns { ok, chatId, queued } — queued reports durable queued delivery. mode auto queues behind active work; queue always queues, steer and restart both interrupt the current turn and schedule a successor through the engine.  With default/auto mode, provide wait:{target:idle|blocked|done,timeoutMs} for direct submission and an exact execution wait (requires an idle target). Other modes use wait_for_thread separately. Reuse commandId to retry a send safely; a wait timeout does not cancel execution.";

const WAIT_DESCRIPTION =
	"Wait for a pinned execution to become idle, blocked on input, or done. Timeout or cancelling this observation never stops execution. Returns the exact turn and attempt plus outcome; a newer execution cannot satisfy this wait.";
const waitFields = {
	target: z.enum(["idle", "blocked", "done"]),
	timeoutMs: z.number().optional(),
};
const waitInputSchema = z.object({
	sessionId: z.string().min(1),
	turnId: z.string().optional(),
	attemptId: z.string().optional(),
	...waitFields,
});
const sendInputSchema = z.object({
	sessionId: z.string().min(1),
	text: z.string().min(1),
	commandId: z.string().optional(),
	mode: z.enum(["auto", "queue", "steer", "restart"]).optional(),
	wait: z.object(waitFields).optional(),
});
const waitProperties = {
	target: { type: "string", enum: ["idle", "blocked", "done"] },
	timeoutMs: {
		type: "number",
		description: "Deadline in milliseconds, default 30000, maximum 300000.",
	},
};

const readInputSchema = z.object({
	sessionId: z.string().min(1),
	limit: z.number().int().min(1).max(ORCHESTRATION_READ_LIMIT).optional(),
	afterMessageId: z.string().optional(),
	messageId: z.string().min(1).optional(),
	textOffset: z.number().int().min(0).optional(),
	maxTextChars: z
		.number()
		.int()
		.min(1)
		.max(ORCHESTRATION_TEXT_LIMIT)
		.optional(),
	view: z.enum(["messages", "activity"]).optional(),
});
const READ_THREAD_DESCRIPTION =
	"Read bounded messages and current session status. Without a cursor returns recent messages; afterMessageId (empty string) starts from the beginning. Continue with nextMessageId while hasMore. view:messages filters conversation text; activity includes tools and other events. For a truncated item, call with its messageId and nextTextOffset until complete before advancing. Text may change during streaming; reread that messageId to refresh it. Read-only.";

const LIST_THREADS_DESCRIPTION =
	"List every session tab in this project, including background managed children, with its workspace (worktreeId — null means the project's main checkout), status, chatId, parentSessionId, and whether you spawned it. Managed task IDs equal their sessionId; use task_status or task_cancel for your direct children. chatOriginSessionId describes chat-level provenance only; it does not make every tab a managed child. Sessions that share a chatId are tabs in one sidebar chat; chats that share a worktreeId share one workspace. Use to see the topology before spawning isolated work with create_thread or adding a session tab with create_session. Read-only.";

const LIST_MODELS_DESCRIPTION =
	"List providers and model slugs available for create_thread and create_session. Use this before overriding providerId/model so you can choose a valid pair. Pass providerId to narrow the result. Returns { providers: [{ providerId, defaultModel, models: [{ id, label, defaultModel }] }] }. Read-only.";

const WHOAMI_DESCRIPTION =
	"Return your own session id, chat id, project id, workspace (worktreeId — null means the project's main checkout), providerId, model, and autonomy level. Use to reason about your own constraints and location before spawning more work. Read-only.";

const EMIT_UI_DESCRIPTION = `Render visuals inline in your reply: diagrams, comparisons, charts, dashboards, and plans. This is Zuse's default way to show anything visual; prefer it over HTML. Input spec is OpenUI Lang text. It renders directly in the chat (no card or background), between your text messages.

Display-only snapshots: no tools, callbacks, or live data. A Form submission sends its answers as the user's next message.

${generativeUiResponseInstructions}

Syntax rules:
- One statement per line: name = Expression
- root = ... is REQUIRED — it is the top-level component
- Component arguments are POSITIONAL only: Stat("Downloads", "12k") — never name: value
- Strings are double-quoted; nest components inside array args: Card([s1, s2])
- Card title: Card([children], "Title"); do not use CardHeader. KeyValue entries are objects with key and value strings, never tuples or label fields.
- Define parts on their own lines and reference them by name; every defined name (except root) must be reachable from root
- Pass null for an optional arg you want to skip
- Use literal data only. No reactive state, expressions, Query(), Mutation(), or actions.
- Fields (Input, TextArea, Select, RadioGroup, Checkbox, Slider) must be inside a Form, with unique names. Forms cannot nest.
- Keep specs under 32,768 characters. Containers hold at most 64 components; charts hold 1-100 points; tables hold 1-20 columns and at most 200 rows.

Example — measured before/after comparison (replace with actual measurements):
root = BarChart("Page load · same fixture and environment", [{label: "Before", value: 820}, {label: "After", value: 540}], "ms")

Example — an architecture explanation without numerical data:
root = Flow([{label: "GitHub webhook"}, {label: "Control plane", detail: "Leases, retries", highlight: true}, {label: "Isolated worker"}, {label: "Check + comments"}], "The control plane dispatches reviews to isolated workers.")

Example — a dashboard:
root = Card([metrics, caveat, breakdown, trend], "Usage · Oct 1–2 · USD")
metrics = Grid([Stat("Recorded spend", "$120", "Request records"), Stat("Requests", "3,000", "Two days")], 2)
caveat = Callout("Budget data is unavailable; no budget projection is shown.", "warn", "Missing source")
breakdown = DonutChart("Spend by model", [{label: "Model A", value: 80}, {label: "Model B", value: 40}], "USD")
trend = LineChart("Daily spend", [{label: "Oct 1", value: 50}, {label: "Oct 2", value: 70}], "USD")

Example — a final coding summary (replace the example facts with actual results):
root = Card([changes, checks, caveat], "Reconnect recovery")
changes = List(["Keeps partial replies after reconnect", "Resumes the existing session"])
checks = KeyValue([{key: "Biome", value: "Passed"}, {key: "Types", value: "Passed"}, {key: "Recovery tests", value: "12 passed"}])
caveat = Callout("Desktop smoke test not run: this environment has no desktop session.", "warn", "Verification limit")

Components (signature — purpose):
${generativeUiComponentLines()}

Returns { ok, messageId } once the block is persisted to the transcript; a validation error lists what to fix and nothing renders.`;

const delegateSchema = z.object({
	task: z.string().min(1),
	clientRequestId: z.string().min(1).max(200),
	role: z.string().optional(),
	title: z.string().optional(),
	providerId: z.string().optional(),
	model: z.string().optional(),
});
const taskSchema = z.object({ taskId: z.string().min(1) });
const interruptSchema = z.object({
	sessionId: z.string().min(1),
	commandId: z.string().optional(),
});
const automationSaveSchema = z.object({
	configJson: z.string().min(1).max(200_000),
	requestId: z.string().min(1).max(200),
	id: z.string().min(1).optional(),
	expectedRevision: z.number().int().positive().optional(),
});
const extraTools = [
	{
		name: "automation_catalog",
		description:
			"Discover your current project's persisted automations, full definition schema, templates and runtime capabilities. Use before automation_save. These are the same definitions shown in the Automations page. No CLI installation required.",
		schema: z.object({}),
	},
	{
		name: "automation_save",
		description:
			"Create or update a persisted automation for the current project. Read automation_catalog first; configJson must match its definitionSchema and projectId. Save proposals with enabled:false for review; enable only within the user's authorized request. Reuse requestId and identical configJson on a creation retry. Updates require id and expectedRevision. Confirm the returned persisted ID instead of merely describing a proposal.",
		schema: automationSaveSchema,
	},
	{
		name: "orchestrator_capabilities",
		description:
			"Discover available providers, models, orchestration tools, limits and current session constraints.",
		schema: z.object({}),
	},
	{
		name: "delegate_task",
		description:
			"Delegate a bounded task to a durable child session in your current checkout. Supply all needed context in task and optional role; parent history is not copied. Use a stable clientRequestId for safe retries. Completion is delivered to the parent automatically. Use create_thread for isolated worktree work.",
		schema: delegateSchema,
	},
	{
		name: "task_status",
		description:
			"Read a delegated task's durable status and captured result. A completed response may still be waiting for nested children.",
		schema: taskSchema,
	},
	{
		name: "task_cancel",
		description:
			"Cancel a task and its nested delegated work, pause their queues and suppress completion delivery.",
		schema: taskSchema,
	},
	{
		name: "interrupt_thread",
		description:
			"Request interruption of the target session's current turn. Does not resend any message.",
		schema: interruptSchema,
	},
] as const;

export const ORCHESTRATION_MCP_TOOLS: ReadonlyArray<OrchestrationMcpToolDef> = [
	...AUTOMATION_TOOL_DEFINITIONS.map(({ name, description, schema }) => ({
		name,
		description,
		inputSchema: z.toJSONSchema(schema) as JsonObject,
	})),
	...extraTools.map(({ name, description, schema }) => ({
		name,
		description,
		inputSchema: z.toJSONSchema(schema) as JsonObject,
	})),
	{
		name: "master_state",
		description:
			"Read this Zot’s repositories, workers, durable notes and supported action schema. Read-only; available to Zot coordinators.",
		inputSchema: objectSchema({
			commandJson: stringProp(
				"Optional query JSON from the state querySchema.",
			),
		}),
	},
	{
		name: "master_action",
		description:
			"Execute a scoped Zot action. Read master_state first for the action schema. Use for delegation across repositories, worker messaging, notes, todos and versioned generated screens. Mutating; obeys current session permissions.",
		inputSchema: objectSchema(
			{
				commandJson: stringProp(
					"JSON matching the Zot action schema from master_state.",
				),
				commandId: stringProp(
					"A unique ID for this operation. Reuse it, with identical commandJson, when retrying so the action runs once.",
				),
			},
			["commandJson", "commandId"],
		),
	},
	{
		name: "create_thread",
		description: CREATE_THREAD_DESCRIPTION,
		inputSchema: objectSchema(
			{
				task: stringProp("The task/instructions for the spawned agent."),
				title: stringProp(
					"Optional short human-readable chat title. Defaults from task.",
				),
				baseBranch: stringProp(
					"Branch to fork from. Defaults to the project's main branch.",
				),
				providerId: stringProp(
					"Provider for the new thread. Defaults to yours.",
				),
				model: stringProp(
					"Model slug for the new thread. Defaults to yours when providerId is omitted; if providerId is overridden, defaults to that provider's configured default model.",
				),
			},
			["task"],
		),
	},
	{
		name: "create_session",
		description: CREATE_SESSION_DESCRIPTION,
		inputSchema: objectSchema(
			{
				task: stringProp("The task/instructions for the spawned agent."),
				chatId: stringProp(
					"Existing sidebar chat for the new session tab. Omit to use your own current chat.",
				),
				title: stringProp(
					"Optional short human-readable session tab title. Defaults from task.",
				),
				providerId: stringProp(
					"Provider for the new session. Defaults to yours.",
				),
				model: stringProp(
					"Model slug for the new session. Defaults to yours when providerId is omitted; if providerId is overridden, defaults to that provider's configured default model.",
				),
			},
			["task"],
		),
	},
	{
		name: "send_to_thread",
		description: SEND_TO_THREAD_DESCRIPTION,
		inputSchema: objectSchema(
			{
				sessionId: stringProp("Target session id from create_thread."),
				text: stringProp("Message to send to the target thread."),
				mode: { type: "string", enum: ["auto", "queue", "steer", "restart"] },
				commandId: stringProp(
					"Stable idempotency key when retrying this send.",
				),
				wait: objectSchema(waitProperties, ["target"]),
			},
			["sessionId", "text"],
		),
	},
	{
		name: "wait_for_thread",
		description: WAIT_DESCRIPTION,
		inputSchema: objectSchema(
			{
				sessionId: stringProp("Target session id."),
				turnId: stringProp("Pin this turn."),
				attemptId: stringProp("Pin this attempt."),
				...waitProperties,
			},
			["sessionId", "target"],
		),
	},
	{
		name: "read_thread",
		description: READ_THREAD_DESCRIPTION,
		inputSchema: z.toJSONSchema(readInputSchema) as JsonObject,
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
	{
		name: "emit_ui",
		description: EMIT_UI_DESCRIPTION,
		inputSchema: objectSchema(
			{
				spec: stringProp(
					"OpenUI Lang source text for the UI block. Must define `root = Component(...)`.",
				),
			},
			["spec"],
		),
	},
];

export const READ_ONLY_ORCHESTRATION_TOOLS = new Set<OrchestrationToolName>([
	"automation_catalog",
	"list_scheduled_tasks",
	"list_secret_requests",
	"orchestrator_capabilities",
	"task_status",
	"wait_for_thread",
	"master_state",
	"read_thread",
	"list_threads",
	"list_models",
	"whoami",

	"emit_ui",
]);

export const MUTATING_ORCHESTRATION_TOOLS = new Set<OrchestrationToolName>([
	"automation_save",
	"schedule_task",
	"update_scheduled_task",
	"delete_scheduled_task",
	"trigger_scheduled_task",
	"request_secret",
	"delegate_task",
	"task_cancel",
	"interrupt_thread",
	"master_action",
	"create_thread",
	"create_session",
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

export const isOrchestrationToolName = (
	name: string,
): name is OrchestrationToolName =>
	ORCHESTRATION_MCP_TOOLS.some((tool) => tool.name === name);

const permissionSummary = (name: string, args: JsonObject): string => {
	switch (name) {
		case "create_thread":
			return `Create isolated Zuse thread "${asString(args, "title") ?? "untitled"}"`;
		case "create_session":
			return `Create Zuse session tab "${asString(args, "title") ?? "untitled"}"`;
		case "send_to_thread":
			return `Send a message to Zuse session ${asString(args, "sessionId") ?? ""}`;
		default:
			return name;
	}
};

export const ensureOrchestrationPermission = async (
	name: string,
	args: JsonObject,
	opts: OrchestrationPermissionOptions,
): Promise<void> => {
	if (!isOrchestrationToolName(name)) throw new Error(`Unknown tool: ${name}`);
	if (!MUTATING_ORCHESTRATION_TOOLS.has(name)) return;

	const policy = getToolPolicy(
		"delegate",
		opts.getRuntimeMode(),
		opts.getPermissionMode(),
	);
	if (policy.kind === "auto-deny") {
		throw new Error(`Orchestration action blocked in plan mode: ${name}.`);
	}

	if (policy.kind === "auto-allow") return;

	const decision = await opts.requestPermission(
		{
			_tag: "Other",
			tool: name,
			summary: permissionSummary(name, args),
		},
		{ forcePrompt: false },
	);
	if (decision._tag === "Deny") {
		throw new Error(`Permission denied for ${name}.`);
	}
};

export const callOrchestrationTool = async (
	deps: OrchestrationToolDeps,
	name: OrchestrationToolName,
	rawArgs: unknown,
): Promise<OrchestrationMcpToolResult> => {
	const args = asRecord(rawArgs);
	switch (name) {
		case "schedule_task":
		case "list_scheduled_tasks":
		case "update_scheduled_task":
		case "delete_scheduled_task":
		case "trigger_scheduled_task":
		case "request_secret":
		case "list_secret_requests":
			return callAutomationTool(deps.automation, name, args);
		case "orchestrator_capabilities":
			return settle(
				deps.capabilities
					? await deps.capabilities()
					: { ok: false, error: "Capabilities unavailable." },
			);
		case "delegate_task": {
			const parsed = delegateSchema.safeParse(args);
			return settle(
				parsed.success && deps.delegateTask
					? await deps.delegateTask(parsed.data)
					: { ok: false, error: "Invalid or unavailable delegation." },
			);
		}
		case "task_status":
		case "task_cancel": {
			const parsed = taskSchema.safeParse(args);
			const handler =
				name === "task_status" ? deps.taskStatus : deps.taskCancel;
			return settle(
				parsed.success && handler
					? await handler(parsed.data)
					: { ok: false, error: "Invalid or unavailable task operation." },
			);
		}
		case "interrupt_thread": {
			const parsed = interruptSchema.safeParse(args);
			return settle(
				parsed.success && deps.interruptThread
					? await deps.interruptThread(parsed.data)
					: { ok: false, error: "Invalid or unavailable interruption." },
			);
		}
		case "automation_catalog":
		case "automation_save": {
			const parsed =
				name === "automation_save"
					? automationSaveSchema.safeParse(args)
					: null;
			if (name === "automation_save" && !parsed?.success)
				return settle({
					ok: false,
					error:
						"Invalid automation definition input. Read automation_catalog first.",
				});
			if (!deps.projectAutomation)
				return settle({
					ok: false,
					error: "Project automation tools are unavailable.",
				});
			const result = await deps.projectAutomation(
				parsed?.success ? parsed.data : undefined,
			);
			const failed =
				typeof result === "object" &&
				result !== null &&
				"ok" in result &&
				result.ok === false;
			return { ...jsonResult(result), ...(failed ? { isError: true } : {}) };
		}

		case "master_state":
		case "master_action": {
			const commandJson = asString(args, "commandJson");
			const commandId = asString(args, "commandId")?.trim() || undefined;
			const result =
				name === "master_action" && commandJson === undefined
					? { ok: false, error: "commandJson is required." }
					: name === "master_action" && commandId === undefined
						? {
								ok: false,
								error:
									"commandId is required. Use a unique ID per operation and reuse it when retrying.",
							}
						: deps.master
							? await deps.master(
									commandJson,
									name === "master_state",
									commandId,
								)
							: { ok: false, error: "This session has no Zot." };
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				isError:
					typeof result === "object" &&
					result !== null &&
					"ok" in result &&
					result.ok === false,
			};
		}
		case "create_thread": {
			const task = asString(args, "task");
			if (task === undefined) {
				return {
					content: [{ type: "text", text: "create_thread requires task." }],
					isError: true,
				};
			}
			return settle(
				await deps.createThread({
					task,
					title: asString(args, "title"),
					baseBranch: asString(args, "baseBranch"),
					providerId: asString(args, "providerId"),
					model: asString(args, "model"),
				}),
			);
		}
		case "create_session": {
			const task = asString(args, "task");
			if (task === undefined) {
				return {
					content: [{ type: "text", text: "create_session requires task." }],
					isError: true,
				};
			}
			return settle(
				await deps.createSession({
					task,
					chatId: asString(args, "chatId"),
					title: asString(args, "title"),
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
			const parsed = sendInputSchema.safeParse(args);
			if (!parsed.success)
				return settle({ ok: false, error: "Invalid send_to_thread options." });
			return settle(await deps.sendToThread(parsed.data));
		}
		case "wait_for_thread": {
			const parsed = waitInputSchema.safeParse(args);
			if (!parsed.success)
				return settle({ ok: false, error: "Invalid wait_for_thread options." });
			return settle(
				deps.waitForThread
					? await deps.waitForThread(parsed.data)
					: { ok: false, error: "Semantic waits are unavailable." },
			);
		}
		case "read_thread": {
			const parsed = readInputSchema.safeParse(args);
			return settle(
				parsed.success
					? await deps.readThread(parsed.data)
					: { ok: false, error: "Invalid read_thread options." },
			);
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
		case "emit_ui": {
			const spec = asString(args, "spec");
			if (spec === undefined) {
				return {
					content: [{ type: "text", text: "emit_ui requires spec." }],
					isError: true,
				};
			}
			return settle(await deps.emitUi({ spec }));
		}
	}
};

export { orchestrationMcpPromptHint } from "./orchestration-instructions.ts";

/**
 * Build the control-plane tool definitions. Descriptions are blunt on purpose
 * — the agent reads them to decide whether to spawn a separate thread (own
 * worktree, own PR, own transcript the user can watch) versus delegating to an
 * in-conversation sub-agent (Agent/Task) that shares this chat.
 */
export const buildOrchestrationTools = (deps: OrchestrationToolDeps) => [
	...buildAutomationTools(deps.automation),
	...extraTools.map(({ name, description, schema }) =>
		tool(name, description, schema.shape, async (args) =>
			callOrchestrationTool(deps, name, args),
		),
	),
	tool(
		"master_state",
		"Read scoped Zot state, worker progress, or an artifact version.",
		{ commandJson: z.string().optional() },
		async (args) => callOrchestrationTool(deps, "master_state", args),
	),
	tool(
		"master_action",
		"Execute a scoped Zot action using the schema from master_state.",
		{ commandJson: z.string() },
		async (args) => callOrchestrationTool(deps, "master_action", args),
	),
	tool(
		"create_thread",
		CREATE_THREAD_DESCRIPTION,
		{
			task: z
				.string()
				.min(1)
				.describe("The task/instructions for the spawned agent."),
			title: z
				.string()
				.optional()
				.describe(
					"Optional short human-readable chat title. Defaults from task.",
				),
			baseBranch: z
				.string()
				.optional()
				.describe(
					"Branch to fork from. Defaults to the project's main branch.",
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
					task: args.task,
					title: args.title,
					baseBranch: args.baseBranch,
					providerId: args.providerId,
					model: args.model,
				}),
			),
	),

	tool(
		"create_session",
		CREATE_SESSION_DESCRIPTION,
		{
			task: z
				.string()
				.min(1)
				.describe("The task/instructions for the spawned agent."),
			chatId: z
				.string()
				.optional()
				.describe(
					"Existing sidebar chat for the new session tab. Omit to use your own current chat.",
				),
			title: z
				.string()
				.optional()
				.describe(
					"Optional short human-readable session tab title. Defaults from task.",
				),
			providerId: z
				.string()
				.optional()
				.describe(
					"Provider for the new session (e.g. 'claude'). Defaults to yours.",
				),
			model: z
				.string()
				.optional()
				.describe(
					"Model slug for the new session. Defaults to yours when providerId is omitted; if providerId is overridden, defaults to that provider's configured default model.",
				),
		},
		async (args) =>
			settle(
				await deps.createSession({
					task: args.task,
					chatId: args.chatId,
					title: args.title,
					providerId: args.providerId,
					model: args.model,
				}),
			),
	),

	tool(
		"send_to_thread",
		SEND_TO_THREAD_DESCRIPTION,
		sendInputSchema.shape,
		async (args) => settle(await deps.sendToThread(args)),
	),
	tool(
		"wait_for_thread",
		WAIT_DESCRIPTION,
		waitInputSchema.shape,
		async (args) =>
			settle(
				deps.waitForThread
					? await deps.waitForThread(args)
					: { ok: false, error: "Semantic waits are unavailable." },
			),
	),

	tool(
		"read_thread",
		READ_THREAD_DESCRIPTION,
		readInputSchema.shape,
		async (args) => settle(await deps.readThread(args)),
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

	tool(
		"emit_ui",
		EMIT_UI_DESCRIPTION,
		{
			spec: z
				.string()
				.min(1)
				.describe(
					"OpenUI Lang source text for the UI block. Must define `root = Component(...)`.",
				),
		},
		async (args) => settle(await deps.emitUi({ spec: args.spec })),
	),
];
