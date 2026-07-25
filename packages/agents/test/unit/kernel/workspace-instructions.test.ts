import { zuseWorkspaceInstructions } from "@zuse/agents/kernel/workspace-instructions";
import { describe, expect, it } from "vitest";

describe("zuseWorkspaceInstructions", () => {
	it("renders only the execution boundary and app MCP hint", () => {
		const text = zuseWorkspaceInstructions({
			projectPath: "/repo",
			cwd: "/repo/worktrees/demo",
		});

		expect(text).toContain("Project root: /repo");
		expect(text).toContain("Working directory: /repo/worktrees/demo");
		expect(text).toContain('Use the "zuse" MCP server');
		expect(text).not.toContain("Target base ref");
		expect(text).not.toContain("scratch");
	});
});
