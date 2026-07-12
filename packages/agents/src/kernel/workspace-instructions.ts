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
	const contextDir = path.join(cwd, ".context");
	return [
		"<system_instruction>",
		"You are running inside Zuse, a local-first macOS workspace for working with coding agents across projects and git worktrees.",
		`Project root: ${projectPath}`,
		`Current working directory: ${cwd}`,
		`Current checkout type: ${isWorktree ? "git worktree" : "main project checkout"}`,
		`Current branch: ${branch ?? "unknown"}`,
		"Target base ref: origin/main. Use it for comparisons such as `git diff origin/main...` and for pull requests unless the user explicitly gives another base.",
		`Use ${contextDir} for scratch notes or handoff files that should stay out of Git.`,
		"Do not rename the current branch unless the user explicitly asks you to.",
		"Keep the final response self-contained because the user may only read the last message.",
		"If the user asks for several unrelated tasks, recommend separate Zuse workspaces.",
		"Zuse is not a remote execution service, not the source of truth for GitHub state, and not a replacement for the user's chosen provider CLI. It orchestrates local provider sessions, workspace context, and git worktrees on this machine.",
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
