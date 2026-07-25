import { applyClaudeWorktreeEnv } from "@zuse/agents/drivers/claude-worktree-prompt";
import { zuseWorkspaceInstructions } from "@zuse/agents/kernel/workspace-instructions";
import { describe, expect, it } from "vitest";

describe("workspace instructions", () => {
	it("provides only the minimal shared app context", () => {
		const cwd = "/Users/whizzy/.zuse/monkit-ea6cdfdd/cherubi";
		const prompt = zuseWorkspaceInstructions({
			projectPath: "/Users/whizzy/Developer/startups/monkit",
			cwd,
		});

		expect(prompt).toContain(cwd);
		expect(prompt).toContain("Treat the working directory as authoritative");
		expect(prompt).toContain('Use the "zuse" MCP server');
		expect(prompt).not.toContain("Target base ref");
		expect(prompt).not.toContain("scratch notes");
		expect(prompt).not.toContain("final response");
		expect(prompt).not.toContain("unrelated tasks");
		expect(prompt.split("\n")).toHaveLength(8);
	});

	it("pins Claude's launch environment to the effective session cwd", () => {
		const cwd = "/Users/whizzy/.zuse/monkit-ea6cdfdd/cherubi";
		const env = applyClaudeWorktreeEnv(
			{
				PWD: "/Users/whizzy/Developer/startups/monkit",
				OLDPWD: "/Users/whizzy/Developer/startups",
				INIT_CWD: "/Users/whizzy/Developer/startups/monkit",
				PATH: "/usr/bin",
			},
			cwd,
		);

		expect(env.PWD).toBe(cwd);
		expect(env.ZUSE_WORKTREE_CWD).toBe(cwd);
		expect(env.MEMOIZE_WORKTREE_CWD).toBe(cwd);
		expect(env[["CON", "DUCTOR_WORKSPACE_CWD"].join("")]).toBeUndefined();
		expect(env.OLDPWD).toBeUndefined();
		expect(env.INIT_CWD).toBeUndefined();
		expect(env.PATH).toBe("/usr/bin");
	});
});
