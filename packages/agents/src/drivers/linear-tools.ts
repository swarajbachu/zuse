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
	type JsonSchemaObject,
	numberProp,
	objectSchema,
	stringProp,
} from "./mcp-tool-schema.ts";

export const LINEAR_MCP_SERVER_NAME = "zuse-connectors";

type ToolResult =
	| { readonly ok: true; readonly data: unknown }
	| { readonly ok: false; readonly error: string };

export interface LinearToolDeps {
	readonly searchIssues: (input: {
		readonly query?: string;
		readonly workspaceId?: string;
	}) => Promise<ToolResult>;
	readonly getIssue: (input: {
		readonly issue: string;
		readonly workspaceId?: string;
	}) => Promise<ToolResult>;
	readonly addComment: (input: {
		readonly issue: string;
		readonly body: string;
		readonly workspaceId?: string;
	}) => Promise<ToolResult>;
	readonly updateIssue: (input: {
		readonly issue: string;
		readonly workspaceId?: string;
		readonly title?: string;
		readonly description?: string;
		readonly status?: string;
		readonly priority?: number;
		readonly assignee?: string | null;
		readonly labels?: ReadonlyArray<string>;
		readonly project?: string | null;
	}) => Promise<ToolResult>;
}

export interface LinearPermissionOptions {
	readonly requestPermission: (
		kind: PermissionKind,
		options: { readonly forcePrompt: boolean },
	) => Promise<PermissionDecision>;
	readonly getRuntimeMode: () => RuntimeMode;
	readonly getPermissionMode: () => PermissionMode;
}

export interface LinearSessionTools {
	readonly deps: LinearToolDeps;
	readonly claudeTools: ReturnType<typeof buildLinearTools>;
}

const toolDefs = [
	{
		name: "linear_search_issues",
		description: "Search issues in the user's connected Linear workspaces.",
		inputSchema: objectSchema({
			query: stringProp("Ticker or title text. Omit for assigned open issues."),
			workspaceId: stringProp("Optional connected workspace id."),
		}),
	},
	{
		name: "linear_get_issue",
		description: "Read the current fields and discussion for a Linear issue.",
		inputSchema: objectSchema(
			{
				issue: stringProp("Issue identifier such as ENG-123 or its UUID."),
				workspaceId: stringProp(
					"Required only when the identifier is ambiguous.",
				),
			},
			["issue"],
		),
	},
	{
		name: "linear_add_comment",
		description: "Post a comment to a Linear issue.",
		inputSchema: objectSchema(
			{
				issue: stringProp("Issue identifier or UUID."),
				body: stringProp("Markdown comment body."),
				workspaceId: stringProp(
					"Required only when the identifier is ambiguous.",
				),
			},
			["issue", "body"],
		),
	},
	{
		name: "linear_update_issue",
		description:
			"Update a Linear issue's title, description, status, priority, assignee, labels, or project. Names must resolve unambiguously.",
		inputSchema: objectSchema(
			{
				issue: stringProp("Issue identifier or UUID."),
				workspaceId: stringProp(
					"Required only when the identifier is ambiguous.",
				),
				title: stringProp("Replacement title."),
				description: stringProp("Replacement Markdown description."),
				status: stringProp("Workflow status name."),
				priority: numberProp("Linear priority number from 0 through 4.", 4),
				assignee: {
					type: ["string", "null"],
					description: "Assignee name/email, or null to clear.",
				},
				labels: {
					type: "array",
					items: { type: "string" },
					description: "Complete replacement label-name list.",
				},
				project: {
					type: ["string", "null"],
					description: "Project name, or null to clear.",
				},
			},
			["issue"],
		),
	},
] as const satisfies ReadonlyArray<{
	readonly name: string;
	readonly description: string;
	readonly inputSchema: JsonSchemaObject;
}>;

export const LINEAR_MCP_TOOLS = toolDefs;
export type LinearToolName = (typeof toolDefs)[number]["name"];

export const isLinearToolName = (name: string): name is LinearToolName =>
	LINEAR_MCP_TOOLS.some((definition) => definition.name === name);

const mutating = new Set<LinearToolName>([
	"linear_add_comment",
	"linear_update_issue",
]);

export const ensureLinearToolPermission = async (
	name: LinearToolName,
	args: Readonly<Record<string, unknown>>,
	options: LinearPermissionOptions,
): Promise<void> => {
	if (!mutating.has(name)) return;
	const policy = getToolPolicy(
		"other",
		options.getRuntimeMode(),
		options.getPermissionMode(),
	);
	if (policy.kind === "auto-deny") {
		throw new Error(`Linear action blocked in plan mode: ${name}.`);
	}
	if (policy.kind === "auto-allow") return;
	const issue = typeof args.issue === "string" ? args.issue : "issue";
	const decision = await options.requestPermission(
		{
			_tag: "Other",
			tool: name,
			summary:
				name === "linear_add_comment"
					? `Comment on Linear issue ${issue}`
					: `Update Linear issue ${issue}`,
		},
		{ forcePrompt: false },
	);
	if (decision._tag === "Deny")
		throw new Error(`Permission denied for ${name}.`);
};

const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const text = (
	args: Record<string, unknown>,
	key: string,
): string | undefined =>
	typeof args[key] === "string" && args[key].length > 0
		? (args[key] as string)
		: undefined;

const result = (value: ToolResult) =>
	value.ok
		? {
				content: [
					{ type: "text" as const, text: JSON.stringify(value.data, null, 2) },
				],
			}
		: {
				content: [{ type: "text" as const, text: value.error }],
				isError: true as const,
			};

export const callLinearTool = async (
	deps: LinearToolDeps,
	name: LinearToolName,
	rawArgs: unknown,
) => {
	const args = record(rawArgs);
	const workspaceId = text(args, "workspaceId");
	const issue = text(args, "issue");
	if (name === "linear_search_issues") {
		return result(
			await deps.searchIssues({ query: text(args, "query"), workspaceId }),
		);
	}
	if (issue === undefined) {
		return {
			content: [{ type: "text" as const, text: `${name} requires issue.` }],
			isError: true as const,
		};
	}
	if (name === "linear_get_issue")
		return result(await deps.getIssue({ issue, workspaceId }));
	if (name === "linear_add_comment") {
		const body = text(args, "body");
		if (body === undefined)
			return {
				content: [
					{ type: "text" as const, text: "linear_add_comment requires body." },
				],
				isError: true as const,
			};
		return result(await deps.addComment({ issue, body, workspaceId }));
	}
	const update: Parameters<LinearToolDeps["updateIssue"]>[0] = {
		issue,
		...(workspaceId === undefined ? {} : { workspaceId }),
		...(text(args, "title") === undefined
			? {}
			: { title: text(args, "title") }),
		...(text(args, "description") === undefined
			? {}
			: { description: text(args, "description") }),
		...(text(args, "status") === undefined
			? {}
			: { status: text(args, "status") }),
		...(typeof args.priority === "number" ? { priority: args.priority } : {}),
		...(args.assignee === null || typeof args.assignee === "string"
			? { assignee: args.assignee }
			: {}),
		...(Array.isArray(args.labels) &&
		args.labels.every((label) => typeof label === "string")
			? { labels: args.labels as string[] }
			: {}),
		...(args.project === null || typeof args.project === "string"
			? { project: args.project }
			: {}),
	};
	return result(await deps.updateIssue(update));
};

export const buildLinearTools = (deps: LinearToolDeps) => [
	tool(
		"linear_search_issues",
		LINEAR_MCP_TOOLS[0].description,
		{ query: z.string().optional(), workspaceId: z.string().optional() },
		async (args) => result(await deps.searchIssues(args)),
	),
	tool(
		"linear_get_issue",
		LINEAR_MCP_TOOLS[1].description,
		{ issue: z.string().min(1), workspaceId: z.string().optional() },
		async (args) => result(await deps.getIssue(args)),
	),
	tool(
		"linear_add_comment",
		LINEAR_MCP_TOOLS[2].description,
		{
			issue: z.string().min(1),
			body: z.string().min(1),
			workspaceId: z.string().optional(),
		},
		async (args) => result(await deps.addComment(args)),
	),
	tool(
		"linear_update_issue",
		LINEAR_MCP_TOOLS[3].description,
		{
			issue: z.string().min(1),
			workspaceId: z.string().optional(),
			title: z.string().optional(),
			description: z.string().optional(),
			status: z.string().optional(),
			priority: z.number().int().min(0).max(4).optional(),
			assignee: z.string().nullable().optional(),
			labels: z.array(z.string()).optional(),
			project: z.string().nullable().optional(),
		},
		async (args) => result(await deps.updateIssue(args)),
	),
];
