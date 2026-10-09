import { execFileSync } from "node:child_process";
import * as path from "node:path";

const currentBranch = (cwd: string): string | null => {
	try {
		const out = execFileSync("git", ["branch", "--show-current"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		}).trim();
		return out.length > 0 ? out : null;
	} catch {
		return null;
	}
};

export const zuseWorkspaceInstructions = ({
	projectPath,
	cwd,
	includeAppTools = true,
}: {
	readonly projectPath: string;
	readonly cwd: string;
	readonly includeAppTools?: boolean;
}): string => {
	const branch = currentBranch(cwd);
	const isWorktree = path.resolve(cwd) !== path.resolve(projectPath);
	return [
		"<system_instruction>",
		`Project root: ${projectPath}`,
		`Working directory: ${cwd}`,
		`Checkout: ${isWorktree ? "git worktree" : "main project checkout"}`,
		`Current branch: ${branch ?? "unknown"}`,
		"Treat the working directory as authoritative and keep repository work inside it.",
		...(includeAppTools
			? [
					'Use the "zuse" MCP server for app browser, image, and orchestration tools when relevant.',
					"When a chart, dashboard, diagram, or interactive explainer communicates better than prose, create responsive HTML, inspect it with html_preview, then publish it inline with html_render before your final reply. Use the Zuse CSS theme variables documented by the tools. Public remote assets are supported. The user sees the visual in chat; add only what it does not say.",
				]
			: []),
		"For connected services such as Linear, use Zuse's system plugins by default. Search directly with plugins_search (for example query: 'linear issue'), then use plugins_schema and plugins_call with the returned address. plugins_list is optional for browsing connected accounts. If a connection is missing, direct the user to Zuse Settings → Integrations. Use a provider-specific integration only when the user explicitly requests it.",
		"</system_instruction>",
	].join("\n");
};

export const prefixFirstPromptWithWorkspaceInstructions = (
	instructions: string | undefined,
	text: string,
): string => {
	if (instructions === undefined || instructions.trim().length === 0) {
		return text;
	}
	return `${instructions}\n\n${text}`;
};
