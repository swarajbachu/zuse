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
}: {
	readonly projectPath: string;
	readonly cwd: string;
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
		'Use the "zuse" MCP server for app browser, image, and orchestration tools when relevant.',
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
