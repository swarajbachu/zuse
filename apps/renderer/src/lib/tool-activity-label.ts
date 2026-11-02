import type { MessageKey, MessageValues } from "@zuse/i18n";

type Translate = (key: MessageKey, values?: MessageValues) => string;

/** Label selection never reads tool inputs/results or builds detail panels. */
export function toolActivityLabel(
	tool: string,
	pending: boolean,
	message: Translate,
): string {
	if (!pending) return message("chat:tool_activity_last", { tool });
	switch (tool) {
		case "Bash":
			return message("chat:tool_activity_running_bash");
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
			return message("chat:tool_activity_running_command");
		case "Read":
		case "ReadFile":
			return message("chat:tool_activity_reading");
		case "Grep":
		case "Glob":
		case "Search":
			return message("chat:tool_activity_searching_files");
		case "ListDir":
		case "ListDirectory":
			return message("chat:tool_activity_listing");
		case "Edit":
		case "MultiEdit":
			return message("chat:tool_activity_editing");
		case "Write":
		case "WriteFile":
			return message("chat:tool_activity_writing");
		case "WebSearch":
			return message("chat:tool_activity_searching_web");
		case "WebFetch":
			return message("chat:tool_activity_fetching");
		case "ViewImage":
			return message("chat:tool_activity_viewing");
		default:
			if (/(?:^|__)local_command_execute$/.test(tool))
				return message("chat:tool_activity_running_command");
			return message("chat:tool_activity_using", { tool });
	}
}
