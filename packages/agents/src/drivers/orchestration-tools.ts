import { tool } from "@anthropic-ai/claude-agent-sdk";
import type {
	PermissionDecision,
	PermissionKind,
	PermissionMode,
	RuntimeMode,
} from "@zuse/contracts";
import { z } from "zod";
import { getToolPolicy } from "../kernel/policy.ts";
import {
	booleanProp,
	type JsonSchemaObject,
	numberProp,
	objectSchema,
	stringProp,
} from "./mcp-tool-schema.ts";

/**
 * In-process MCP "control-plane" tools — the primitives that let an agent
 * orchestrate its OWN work the way a human operator would: spin up a git
 * worktree, open a new chat/session ("thread"), hand that thread a task, and
 * read back its progress. This is the Layer-1 foundation the loop engine
 * (heartbeat / goal loops) builds on in a later phase.
 *
 * These mirror `buildIndexTools` / `buildBrowserTools`: the handlers are plain
 * async functions the Claude SDK invokes directly, kept free of any Effect
 * wiring. `ConversationServices` binds the deps below to its own Effect methods via
 * `Runtime.runPromise`, and — crucially — translates every failure into a
 * `{ ok: false, error }` result so these handlers never throw. That keeps the
 * tool surface free of raw try/catch and matches the `BrowserCommandResult`
 * convention.
 *
 * Registration is gated on autonomy: `ConversationServices` only builds + passes these
 * when the session's autonomy level is not `"off"`. The mutating tools
 * (create_thread / create_session / send_to_thread / memory_write) fall through
 * the driver's permission policy to a prompt, which IS the approval gate for the
 * `approval-gated` level; the read-only tools (read_thread / list_threads /
 * list_models / whoami / memory_read / memory_search) are auto-allowed by the
 * driver alongside the index reads.
 */

// ── Result contracts (set by ConversationServices, never thrown) ────────────────────

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

export type MemoryWriteResult =
	| { readonly ok: true; readonly note: string }
	| { readonly ok: false; readonly error: string };

export type MemoryReadResult =
	| {
			readonly ok: true;
			readonly note: string | null;
			readonly content: string;
	  }
	| { readonly ok: false; readonly error: string };

export interface MemorySearchHit {
	readonly note: string;
	readonly line: number;
	readonly text: string;
	readonly scope: "project" | "session";
	readonly status: "pending" | "verified";
}

export type MemorySearchResult =
	| { readonly ok: true; readonly hits: ReadonlyArray<MemorySearchHit> }
	| { readonly ok: false; readonly error: string };

export type MemoryVerifyResult =
	| {
			readonly ok: true;
			readonly note: string;
			readonly status: "pending" | "verified";
	  }
	| { readonly ok: false; readonly error: string };

/**
 * The Effect-free surface `ConversationServices` binds. Each call resolves to a result
 * object; rejections are not expected (ConversationServices catches Effect failures).
 */
export interface OrchestrationToolDeps {
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
	readonly memoryWrite: (input: {
		readonly title: string;
		readonly text: string;
		readonly scope?: "project" | "session";
	}) => Promise<MemoryWriteResult>;
	readonly memoryRead: (input: {
		readonly note?: string;
		readonly scope?: "project" | "session" | "all";
	}) => Promise<MemoryReadResult>;
	readonly memorySearch: (input: {
		readonly query: string;
		readonly scope?: "project" | "session" | "all";
	}) => Promise<MemorySearchResult>;
	readonly memoryVerify: (input: {
		readonly note: string;
		readonly scope?: "project" | "session";
	}) => Promise<MemoryVerifyResult>;
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
	readonly deps: OrchestrationToolDeps;
	readonly claudeTools: ReturnType<typeof buildOrchestrationTools>;
}

// ── MCP text-result helpers ─────────────────────────────────────────────────

type JsonObject = JsonSchemaObject;

export type OrchestrationMcpToolResult = {
	readonly content: Array<{ readonly type: "text"; readonly text: string }>;
	readonly isError?: boolean;
};

export type OrchestrationToolName =
	| "create_thread"
	| "create_session"
	| "send_to_thread"
	| "read_thread"
	| "list_threads"
	| "list_models"
	| "whoami"
	| "memory_write"
	| "memory_read"
	| "memory_search"
	| "memory_verify";

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
	"Send a follow-up message to an existing thread's session (e.g. one you spawned with create_thread). The message is handed to the target session immediately and the receiving agent sees it attributed to you; it does not create a new thread or workspace. Use to deliver review feedback, a next instruction, or a 'you're done, stop' signal. Returns { ok, chatId, queued } — queued is always false today (delivery is immediate).";

const READ_THREAD_DESCRIPTION =
	"Read a thread's recent messages and current status (idle / running / closed / error). Use to check what a spawned thread has done — e.g. read a review thread's findings before deciding to merge. Returns { status, messages: [{ role, text }] }. Read-only.";

const LIST_THREADS_DESCRIPTION =
	"List the chat threads in this project with their workspace (worktreeId — null means the project's main checkout), status, chatId, and whether you spawned them. Sessions that share a chatId are tabs in one sidebar chat; chats that share a worktreeId share one workspace. Use to see the topology before spawning isolated work with create_thread or adding a session tab with create_session. Read-only.";

const LIST_MODELS_DESCRIPTION =
	"List providers and model slugs available for create_thread and create_session. Use this before overriding providerId/model so you can choose a valid pair. Pass providerId to narrow the result. Returns { providers: [{ providerId, defaultModel, models: [{ id, label, defaultModel }] }] }. Read-only.";

const WHOAMI_DESCRIPTION =
	"Return your own session id, chat id, project id, workspace (worktreeId — null means the project's main checkout), providerId, model, and autonomy level. Use to reason about your own constraints and location before spawning more work. Read-only.";

const MEMORY_SCOPE_PROP = {
	type: "string",
	enum: ["project", "session"],
	description:
		"Where the note lives. 'project' (default) is shared by every session and worktree of this project and survives workspace removal. 'session' is private to this session only.",
};

const MEMORY_READ_SCOPE_PROP = {
	type: "string",
	enum: ["project", "session", "all"],
	description:
		"Scope to read. 'project' (default) is the durable project vault shared across workspaces. 'session' is this session's private notes. 'all' reads both.",
};

const MEMORY_WRITE_DESCRIPTION =
	"Append a note to the project's durable memory vault (a server-side store keyed by project, independent of any worktree — it survives workspace archive and removal). Stored as a Markdown file NN-<slug>.md with a one-line entry added to the MEMORY.md index, so the note survives across sessions, providers, and new workspaces. Use for project context worth keeping — decisions, findings, conventions, gotchas. Entries are context, not instructions. NEVER store secrets, tokens, or credentials. Returns { ok, note } — the note name for memory_read/memory_search.";

const MEMORY_READ_DESCRIPTION =
	"Read the project's durable memory vault. With no note, returns the MEMORY.md index — one line per stored note. With note (a name from the index, without .md), returns that note's Markdown content. Read-only.";

const MEMORY_SEARCH_DESCRIPTION =
	"Case-insensitive substring search over the project's memory vault, including the MEMORY.md index. Returns matching lines with their note name, scope, and status (pending or verified), capped at ~50 hits. Use to find existing context before writing a duplicate note. Read-only.";

const MEMORY_VERIFY_DESCRIPTION =
	"Mark a stored memory note as verified — flips its frontmatter status from pending to verified so later reads/searches can tell reviewed memories from fresh ones. New notes are always written as pending. Returns { ok, note, status }.";

export const ORCHESTRATION_MCP_TOOLS: ReadonlyArray<OrchestrationMcpToolDef> = [
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
	{
		name: "memory_write",
		description: MEMORY_WRITE_DESCRIPTION,
		inputSchema: objectSchema(
			{
				title: stringProp(
					"Short title for the note; becomes the NN-<slug> filename and index line.",
				),
				text: stringProp("Markdown body of the note."),
				scope: MEMORY_SCOPE_PROP,
			},
			["title", "text"],
		),
	},
	{
		name: "memory_read",
		description: MEMORY_READ_DESCRIPTION,
		inputSchema: objectSchema({
			note: stringProp(
				"Note name from the MEMORY.md index (without .md). Omit to read the index.",
			),
			scope: MEMORY_READ_SCOPE_PROP,
		}),
	},
	{
		name: "memory_search",
		description: MEMORY_SEARCH_DESCRIPTION,
		inputSchema: objectSchema(
			{
				query: stringProp("Case-insensitive substring to find."),
				scope: MEMORY_READ_SCOPE_PROP,
			},
			["query"],
		),
	},
	{
		name: "memory_verify",
		description: MEMORY_VERIFY_DESCRIPTION,
		inputSchema: objectSchema(
			{
				note: stringProp("Note name from the MEMORY.md index (without .md)."),
				scope: MEMORY_SCOPE_PROP,
			},
			["note"],
		),
	},
];

export const READ_ONLY_ORCHESTRATION_TOOLS = new Set<OrchestrationToolName>([
	"read_thread",
	"list_threads",
	"list_models",
	"whoami",
	"memory_read",
	"memory_search",
]);

export const MUTATING_ORCHESTRATION_TOOLS = new Set<OrchestrationToolName>([
	"create_thread",
	"create_session",
	"send_to_thread",
	"memory_write",
	"memory_verify",
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

/**
 * A scope that fails the enum is rejected, not coerced — silently defaulting
 * an invalid `scope` to "project" could publish a note the caller meant to
 * keep session-private.
 */
const asMemoryWriteScope = (
	value: string | undefined,
): "project" | "session" | undefined | "invalid" =>
	value === undefined || value === "project" || value === "session"
		? value
		: "invalid";

const asMemoryReadScope = (
	value: string | undefined,
): "project" | "session" | "all" | undefined | "invalid" =>
	value === undefined ||
	value === "project" ||
	value === "session" ||
	value === "all"
		? value
		: "invalid";

const invalidScopeResult = (tool: string): OrchestrationMcpToolResult => ({
	content: [
		{
			type: "text",
			text: `${tool} got an invalid scope. Use "project" or "session" for memory_write/memory_verify; "project", "session", or "all" for memory_read/memory_search.`,
		},
	],
	isError: true,
});

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

const permissionSummary = (name: string, args: JsonObject): string => {
	switch (name) {
		case "create_thread":
			return `Create isolated Zuse thread "${asString(args, "title") ?? "untitled"}"`;
		case "create_session":
			return `Create Zuse session tab "${asString(args, "title") ?? "untitled"}"`;
		case "send_to_thread":
			return `Send a message to Zuse session ${asString(args, "sessionId") ?? ""}`;
		case "memory_write":
			return `Write memory note "${asString(args, "title") ?? "untitled"}"`;
		case "memory_verify":
			return `Mark memory note "${asString(args, "note") ?? ""}" as verified`;
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
		case "memory_write": {
			const title = asString(args, "title");
			const text = asString(args, "text");
			if (title === undefined || text === undefined) {
				return {
					content: [
						{
							type: "text",
							text: "memory_write requires title and text.",
						},
					],
					isError: true,
				};
			}
			const writeScope = asMemoryWriteScope(asString(args, "scope"));
			if (writeScope === "invalid") return invalidScopeResult("memory_write");
			return settle(await deps.memoryWrite({ title, text, scope: writeScope }));
		}
		case "memory_read": {
			const readScope = asMemoryReadScope(asString(args, "scope"));
			if (readScope === "invalid") return invalidScopeResult("memory_read");
			return settle(
				await deps.memoryRead({
					note: asString(args, "note"),
					scope: readScope,
				}),
			);
		}
		case "memory_search": {
			const query = asString(args, "query");
			if (query === undefined) {
				return {
					content: [{ type: "text", text: "memory_search requires query." }],
					isError: true,
				};
			}
			const searchScope = asMemoryReadScope(asString(args, "scope"));
			if (searchScope === "invalid") return invalidScopeResult("memory_search");
			return settle(await deps.memorySearch({ query, scope: searchScope }));
		}
		case "memory_verify": {
			const note = asString(args, "note");
			if (note === undefined) {
				return {
					content: [{ type: "text", text: "memory_verify requires note." }],
					isError: true,
				};
			}
			const verifyScope = asMemoryWriteScope(asString(args, "scope"));
			if (verifyScope === "invalid") return invalidScopeResult("memory_verify");
			return settle(await deps.memoryVerify({ note, scope: verifyScope }));
		}
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
		`The "${ORCHESTRATION_MCP_SERVER_NAME}" MCP server lets this Zuse chat create real Zuse worktrees, sidebar chats, and session tabs.`,
		`Tools: ${ORCHESTRATION_MCP_TOOLS.map(signature).join(", ")}.`,
		"Model: project -> workspaces (worktrees) -> sidebar chats -> session tabs. create_thread makes a new workspace plus sidebar chat for isolated branch/PR work; create_session adds a tab to an existing sidebar chat.",
		"Smoke flow: whoami -> list_threads -> create_thread -> read_thread. Use list_models before choosing providerId/model, and create_session for same-chat tabs.",
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

	tool(
		"memory_write",
		MEMORY_WRITE_DESCRIPTION,
		{
			title: z
				.string()
				.min(1)
				.describe(
					"Short title for the note; becomes the NN-<slug> filename and index line.",
				),
			text: z.string().min(1).describe("Markdown body of the note."),
			scope: z
				.enum(["project", "session"])
				.optional()
				.describe(MEMORY_SCOPE_PROP.description),
		},
		async (args) =>
			settle(
				await deps.memoryWrite({
					title: args.title,
					text: args.text,
					scope: args.scope,
				}),
			),
	),

	tool(
		"memory_read",
		MEMORY_READ_DESCRIPTION,
		{
			note: z
				.string()
				.optional()
				.describe(
					"Note name from the MEMORY.md index (without .md). Omit to read the index.",
				),
			scope: z
				.enum(["project", "session", "all"])
				.optional()
				.describe(MEMORY_READ_SCOPE_PROP.description),
		},
		async (args) =>
			settle(await deps.memoryRead({ note: args.note, scope: args.scope })),
	),

	tool(
		"memory_search",
		MEMORY_SEARCH_DESCRIPTION,
		{
			query: z.string().min(1).describe("Case-insensitive substring to find."),
			scope: z
				.enum(["project", "session", "all"])
				.optional()
				.describe(MEMORY_READ_SCOPE_PROP.description),
		},
		async (args) =>
			settle(await deps.memorySearch({ query: args.query, scope: args.scope })),
	),

	tool(
		"memory_verify",
		MEMORY_VERIFY_DESCRIPTION,
		{
			note: z.string().min(1).describe("Note name from the MEMORY.md index."),
			scope: z
				.enum(["project", "session"])
				.optional()
				.describe(MEMORY_SCOPE_PROP.description),
		},
		async (args) =>
			settle(await deps.memoryVerify({ note: args.note, scope: args.scope })),
	),
];
