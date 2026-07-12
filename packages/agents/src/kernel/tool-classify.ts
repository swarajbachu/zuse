import type { ToolCategory } from "./permission-policy.js";

const normalized = (tool: string): string =>
	tool
		.split(/[./:]/)
		.at(-1)
		?.replaceAll(/[^a-zA-Z0-9]/g, "")
		.toLowerCase() ?? "";

const CATEGORIES: Readonly<
	Record<Exclude<ToolCategory, "other">, ReadonlySet<string>>
> = {
	read: new Set(["read", "readfile", "grep", "glob", "ls", "search"]),
	edit: new Set(["edit", "multiedit", "write", "writefile", "notebookedit"]),
	execute: new Set([
		"bash",
		"shell",
		"terminal",
		"exec",
		"execcommand",
		"command",
	]),
	network: new Set(["websearch", "webfetch", "fetch", "http"]),
	delegate: new Set(["agent", "task", "delegate", "subagent"]),
	"exit-plan": new Set(["exitplanmode", "exitplan"]),
};

export const classifyTool = (
	tool: string,
	overrides: Readonly<Record<string, ToolCategory>> = {},
): ToolCategory => {
	const override = overrides[tool];
	if (override !== undefined) return override;
	const name = normalized(tool);
	for (const [category, names] of Object.entries(CATEGORIES) as Array<
		[Exclude<ToolCategory, "other">, ReadonlySet<string>]
	>) {
		if (names.has(name)) return category;
	}
	return "other";
};
