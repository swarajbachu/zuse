import type { MessageKey, MessageValues } from "@zuse/i18n";

type Translate = (key: MessageKey, values?: MessageValues) => string;

type ToolActivityKind =
	| "bash"
	| "command"
	| "read"
	| "search"
	| "list"
	| "edit"
	| "write"
	| "web_search"
	| "fetch"
	| "view"
	| "other";

/** Classification reads only the tool name, never inputs or results. */
function toolActivityKind(tool: string): ToolActivityKind {
	switch (tool) {
		case "Bash":
			return "bash";
		case "local_command_execute":
		case "Shell":
		case "shell":
		case "Execute":
		case "execute":
		case "Run":
		case "run":
		case "run_shell_command":
		case "run_terminal_cmd":
		case "run_terminal_command":
		case "Run Terminal Command":
			return "command";
		case "Read":
		case "ReadFile":
			return "read";
		case "Grep":
		case "Glob":
		case "Search":
			return "search";
		case "ListDir":
		case "ListDirectory":
			return "list";
		case "Edit":
		case "MultiEdit":
			return "edit";
		case "Write":
		case "WriteFile":
			return "write";
		case "WebSearch":
			return "web_search";
		case "WebFetch":
			return "fetch";
		case "ViewImage":
			return "view";
		default:
			return /(?:^|__)local_command_execute$/.test(tool) ? "command" : "other";
	}
}

const RUNNING_LABELS: Record<Exclude<ToolActivityKind, "other">, MessageKey> = {
	bash: "chat:tool_activity_running_bash",
	command: "chat:tool_activity_running_command",
	read: "chat:tool_activity_reading",
	search: "chat:tool_activity_searching_files",
	list: "chat:tool_activity_listing",
	edit: "chat:tool_activity_editing",
	write: "chat:tool_activity_writing",
	web_search: "chat:tool_activity_searching_web",
	fetch: "chat:tool_activity_fetching",
	view: "chat:tool_activity_viewing",
};

const SUMMARY_LABELS: Record<ToolActivityKind, MessageKey> = {
	bash: "chat:tool_activity_summary_commands",
	command: "chat:tool_activity_summary_commands",
	read: "chat:tool_activity_summary_reads",
	search: "chat:tool_activity_summary_searches",
	list: "chat:tool_activity_summary_lists",
	edit: "chat:tool_activity_summary_edits",
	write: "chat:tool_activity_summary_writes",
	web_search: "chat:tool_activity_summary_web_searches",
	fetch: "chat:tool_activity_summary_fetches",
	view: "chat:tool_activity_summary_images",
	other: "chat:tool_activity_summary_tools",
};

/** Label for a tool call that is still running. */
export function toolActivityLabel(tool: string, message: Translate): string {
	const kind = toolActivityKind(tool);
	return kind === "other"
		? message("chat:tool_activity_using", { tool })
		: message(RUNNING_LABELS[kind]);
}

/**
 * Settled summary such as "Ran 3 commands and read 2 files", grouped by
 * activity in order of first appearance.
 */
export function toolActivitySummary(
	tools: readonly string[],
	message: Translate,
	formatSentenceList: (items: readonly string[]) => string,
): string {
	const counts = new Map<MessageKey, number>();
	for (const tool of tools) {
		const key = SUMMARY_LABELS[toolActivityKind(tool)];
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	if (counts.size === 0) return message("chat:tool_activity_activity");
	return formatSentenceList(
		[...counts].map(([key, count]) => message(key, { count })),
	);
}
