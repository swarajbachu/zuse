import { describe, expect, test } from "vitest";

import {
	basename,
	dirname,
	workspaceDisplayPath,
} from "../../../src/lib/workspace-path";

describe("workspaceDisplayPath", () => {
	test("removes a known workspace root", () => {
		expect(
			workspaceDisplayPath("/projects/app/src/index.ts", "/projects/app"),
		).toBe("src/index.ts");
	});

	test("removes managed worktree storage prefixes", () => {
		expect(
			workspaceDisplayPath("/Users/dev/.zuse/project-123/feature/src/index.ts"),
		).toBe("src/index.ts");
		expect(
			workspaceDisplayPath(
				"/Users/dev/.codex/worktrees/086f/repo/apps/mobile/app.tsx",
			),
		).toBe("apps/mobile/app.tsx");
	});

	test("preserves already-relative paths", () => {
		expect(workspaceDisplayPath("./src/index.ts")).toBe("src/index.ts");
	});

	test("splits normalized file references", () => {
		expect(basename("src\\features\\index.ts")).toBe("index.ts");
		expect(dirname("src\\features\\index.ts")).toBe("src/features");
	});
});
