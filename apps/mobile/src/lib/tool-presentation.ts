import {
	extractFileChanges,
	type FileChange,
} from "@zuse/client-runtime/timeline";
import type { MessageContent } from "@zuse/contracts";

import {
	extractEditSummaries,
	summarizeValue,
	type ToolResultRecord,
} from "./message-presentation";

export type MobileToolIcon =
	| "terminal"
	| "file"
	| "edit"
	| "search"
	| "folder"
	| "agent"
	| "web"
	| "camera"
	| "todo"
	| "wrench";

export type MobileToolKind =
	| "shell"
	| "read"
	| "edit"
	| "search"
	| "directory"
	| "agent"
	| "browser"
	| "task"
	| "plan"
	| "unknown";

export type MobileToolPresentation = {
	kind: MobileToolKind;
	icon: MobileToolIcon;
	label: string;
	/**
	 * Compact one-line label for the plain (boxless) tool row, e.g. "Ran bun
	 * test", "Edited app.ts", "Read app.ts". Falls back to {@link label} for
	 * tools without a natural verb phrase.
	 */
	inlineLabel: string;
	detail: string | null;
	body: string;
	resultBody: string | null;
	resultLabel: "Running" | "Result" | "Error";
	isError: boolean;
	editSummaries: ReturnType<typeof extractEditSummaries>;
	/**
	 * "N file(s) changed +A −B" header for the file-change container, or `null`
	 * when the tool produced no edit summaries.
	 */
	fileChangeSummary: string | null;
	fileChanges: readonly FileChange[];
};

type ToolUseContent = Extract<MessageContent, { _tag: "tool_use" }>;

export const buildToolPresentation = (
	content: ToolUseContent,
	result?: ToolResultRecord,
): MobileToolPresentation => {
	const normalizedTool = normalizeToolName(content.tool);
	const input = asRecord(content.input);
	const resultText =
		result === undefined ? null : toResultText(result.output) || "(no output)";
	const editSummaries = extractEditSummaries(content.tool, content.input);
	const fileChanges = extractFileChanges(content.tool, content.input);
	const base = buildBaseToolView(
		normalizedTool,
		input,
		content.input,
		resultText,
	);

	return {
		...base,
		inlineLabel: inlineLabelFor(
			normalizedTool,
			input,
			content.input,
			base.label,
		),
		resultBody: resultText,
		resultLabel:
			result === undefined ? "Running" : result.isError ? "Error" : "Result",
		isError: result?.isError === true,
		editSummaries,
		fileChangeSummary: fileChangeSummaryFor(editSummaries),
		fileChanges,
	};
};

const inlineLabelFor = (
	tool: string,
	input: Record<string, unknown>,
	_rawInput: unknown,
	fallbackLabel: string,
): string => {
	switch (tool) {
		case "Bash":
		case "Shell":
		case "Execute":
		case "Run":
		case "run_shell_command":
		case "run_terminal_cmd": {
			const command =
				stringValue(input.command) ??
				stringValue(input.cmd) ??
				stringValue(input.shell_command);
			return command === null ? fallbackLabel : `Ran ${firstLineOf(command)}`;
		}
		case "Write":
		case "WriteFile": {
			const path = stringValue(input.file_path) ?? stringValue(input.path);
			return path === null ? fallbackLabel : `Created ${basename(path)}`;
		}
		case "Edit":
		case "MultiEdit": {
			const path = stringValue(input.file_path) ?? stringValue(input.path);
			return path === null ? fallbackLabel : `Edited ${basename(path)}`;
		}
		case "Read":
		case "ReadFile": {
			const path = stringValue(input.file_path) ?? stringValue(input.path);
			return path === null ? fallbackLabel : `Read ${basename(path)}`;
		}
		default:
			return fallbackLabel;
	}
};

const fileChangeSummaryFor = (
	summaries: readonly { added: number; removed: number }[],
): string | null => {
	if (summaries.length === 0) return null;
	const added = summaries.reduce((sum, item) => sum + item.added, 0);
	const removed = summaries.reduce((sum, item) => sum + item.removed, 0);
	const files = `${summaries.length} file${summaries.length === 1 ? "" : "s"} changed`;
	return `${files} +${added} −${removed}`;
};

const firstLineOf = (value: string): string => {
	const line = value.trim().split(/\r\n|\r|\n/)[0] ?? "";
	return line.length > 0 ? line : value.trim();
};

const basename = (path: string): string => {
	const parts = path.split("/").filter((part) => part.length > 0);
	return parts.at(-1) ?? path;
};

export const toResultText = (output: unknown): string => {
	if (typeof output === "string") return output;
	if (output === null || output === undefined) return "";
	if (Array.isArray(output)) {
		const parts: string[] = [];
		for (const block of output) {
			if (!isRecord(block)) continue;
			if (typeof block.text === "string") {
				parts.push(block.text);
				continue;
			}
			if (isRecord(block.content) && typeof block.content.text === "string") {
				parts.push(block.content.text);
			}
		}
		if (parts.length > 0) return parts.join("");
	}
	if (isRecord(output)) {
		if (typeof output.text === "string") return output.text;
		if (typeof output.content === "string") return output.content;
		if (Array.isArray(output.content)) return toResultText(output.content);
	}
	return summarizeValue(output);
};

export const lineCountOf = (output: unknown): number => {
	const text = toResultText(output);
	return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
};

const buildBaseToolView = (
	tool: string,
	input: Record<string, unknown>,
	rawInput: unknown,
	resultText: string | null,
): Omit<
	MobileToolPresentation,
	| "resultBody"
	| "resultLabel"
	| "isError"
	| "editSummaries"
	| "inlineLabel"
	| "fileChangeSummary"
	| "fileChanges"
> => {
	switch (tool) {
		case "Bash":
		case "Shell":
		case "Execute":
		case "Run":
		case "run_shell_command":
		case "run_terminal_cmd": {
			const command =
				stringValue(input.command) ??
				stringValue(input.cmd) ??
				stringValue(input.shell_command) ??
				stringValue(rawInput);
			const description = stringValue(input.description);
			return {
				kind: "shell",
				icon: "terminal",
				label: description ?? (tool === "Bash" ? "Bash" : "Execute"),
				detail: command === null ? null : command,
				body: command === null ? summarizeValue(rawInput) : `$ ${command}`,
			};
		}
		case "Read":
		case "ReadFile": {
			const path = stringValue(input.file_path) ?? stringValue(input.path);
			const lines =
				resultText === null
					? "..."
					: resultText.length === 0
						? "(empty)"
						: `${resultText.split(/\r\n|\r|\n/).length} lines`;
			return {
				kind: "read",
				icon: "file",
				label: tool === "ReadFile" ? "Read file" : "Read",
				detail: path === null ? lines : `${lines} - ${path}`,
				body: path ?? summarizeValue(rawInput),
			};
		}
		case "Edit":
		case "Write":
		case "WriteFile":
		case "MultiEdit": {
			const path = stringValue(input.file_path) ?? stringValue(input.path);
			return {
				kind: "edit",
				icon: "edit",
				label:
					tool === "Write" || tool === "WriteFile"
						? "Write"
						: tool === "MultiEdit"
							? "MultiEdit"
							: "Edit",
				detail: path,
				body: summarizeValue(rawInput),
			};
		}
		case "Grep":
		case "Glob":
		case "Search": {
			const pattern = stringValue(input.pattern) ?? stringValue(input.query);
			const scope =
				stringValue(input.path) ??
				stringValue(input.glob) ??
				stringValue(input.type);
			const detail =
				pattern === null
					? scope
					: scope === null
						? pattern
						: `${pattern} in ${scope}`;
			return {
				kind: "search",
				icon: "search",
				label: tool,
				detail,
				body: summarizeValue(rawInput),
			};
		}
		case "ListDir":
		case "ListDirectory": {
			const path = stringValue(input.path) ?? stringValue(input.directory);
			return {
				kind: "directory",
				icon: "folder",
				label: "List directory",
				detail: path,
				body: summarizeValue(rawInput),
			};
		}
		case "TodoWrite":
		case "TaskUpdate":
			return {
				kind: "task",
				icon: "todo",
				label: "Update tasks",
				detail: "Project plan",
				body: summarizeValue(rawInput),
			};
		case "Task":
		case "Agent":
		case "SpawnAgent":
		case "CollabSpawnAgent":
		case "CollabSendInput":
		case "CollabResumeAgent":
		case "CollabCloseAgent":
		case "CollabWait":
			return {
				kind: "agent",
				icon: "agent",
				label: tool === "Task" ? "Task" : "Agent",
				detail: stringValue(input.description) ?? stringValue(input.prompt),
				body: summarizeValue(rawInput),
			};
		case "WebFetch":
		case "WebSearch":
			return {
				kind: "browser",
				icon: "web",
				label: tool === "WebFetch" ? "Fetch page" : "Search web",
				detail: stringValue(input.url) ?? stringValue(input.query),
				body: summarizeValue(rawInput),
			};
		default: {
			const lower = tool.toLowerCase();
			if (lower.endsWith("__browser_screenshot")) {
				return {
					kind: "browser",
					icon: "camera",
					label: "Screenshot",
					detail: null,
					body: summarizeValue(rawInput),
				};
			}
			if (lower.includes("__browser_")) {
				return {
					kind: "browser",
					icon: "web",
					label: "Browser",
					detail: stringValue(input.url),
					body: summarizeValue(rawInput),
				};
			}
			if (lower.includes("read") || lower.includes("file")) {
				return {
					kind: "read",
					icon: "file",
					label: tool,
					detail: null,
					body: summarizeValue(rawInput),
				};
			}
			if (
				lower.includes("search") ||
				lower.includes("grep") ||
				lower.includes("glob")
			) {
				return {
					kind: "search",
					icon: "search",
					label: tool,
					detail: null,
					body: summarizeValue(rawInput),
				};
			}
			return {
				kind: tool === "ExitPlanMode" ? "plan" : "unknown",
				icon: "wrench",
				label: tool,
				detail: summarizeValue(rawInput, 96),
				body: summarizeValue(rawInput),
			};
		}
	}
};

const normalizeToolName = (tool: string): string =>
	tool.replace(/^mcp__memoize__/, "mcp__zuse__");

const asRecord = (value: unknown): Record<string, unknown> =>
	isRecord(value) ? value : {};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object";

const stringValue = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;
