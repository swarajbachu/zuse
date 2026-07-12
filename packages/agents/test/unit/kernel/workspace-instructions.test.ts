import { zuseWorkspaceInstructions } from "@zuse/agents/kernel/workspace-instructions";
import { describe, expect, it } from "vitest";

describe("zuseWorkspaceInstructions", () => {
	it("renders Zuse-specific workspace context without naming other workspace apps", () => {
		const text = zuseWorkspaceInstructions({
			projectPath: "/repo",
			cwd: "/repo/worktrees/demo",
		});

		expect(text).toContain("You are running inside Zuse");
		expect(text).toContain("Project root: /repo");
		expect(text).toContain("Current working directory: /repo/worktrees/demo");
		expect(text).toContain("Target base ref: origin/main");
		expect(text).toContain("Zuse is not a remote execution service");
	});
});
