const toNiceToolLabel = (raw: string): string => {
	if (!raw) return "Tool";
	return raw
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(" ");
};

/** Map common provider-native tool identifiers to the shared UI contract. */
export const normalizeNativeToolName = (raw: string): string => {
	switch (raw.toLowerCase()) {
		case "read":
		case "read_file":
		case "readfile":
			return "Read";
		case "bash":
		case "execute":
		case "run_command":
		case "run_terminal_cmd":
		case "shell":
		case "shell_command":
		case "terminal":
			return "Bash";
		case "edit":
		case "edit_file":
		case "editfile":
		case "search_replace":
		case "searchreplace":
		case "str_replace":
		case "str_replace_editor":
			return "Edit";
		case "write":
		case "write_file":
		case "writefile":
			return "Write";
		case "grep":
		case "grep_search":
		case "grepsearch":
		case "search":
		case "search_files":
		case "searchfiles":
			return "Grep";
		case "glob":
		case "glob_files":
		case "globfiles":
			return "Glob";
		case "websearch":
		case "web_search":
			return "WebSearch";
		case "webfetch":
		case "web_fetch":
		case "fetch":
		case "fetch_url":
			return "WebFetch";
		case "list_dir":
		case "listdir":
		case "list_directory":
		case "directory":
			return "ListDir";
		case "multi_edit":
		case "multiedit":
			return "MultiEdit";
		case "todo_write":
		case "todowrite":
			return "TodoWrite";
		default:
			return toNiceToolLabel(raw);
	}
};
