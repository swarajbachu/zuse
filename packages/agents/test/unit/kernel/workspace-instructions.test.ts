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
		expect(text).toContain("Zuse's system plugins by default");
		expect(text).toContain("plugins_search");
		expect(text).toContain("Settings → Integrations");
		expect(text).not.toContain("Target base ref");
		expect(text).not.toContain("scratch");
	});
	it("keeps plugin guidance for providers without browser tools", () => {
		expect(
			zuseWorkspaceInstructions({
				projectPath: "/repo",
				cwd: "/repo",
				includeAppTools: false,
			}),
		).toContain("plugins_search");
	});
});
