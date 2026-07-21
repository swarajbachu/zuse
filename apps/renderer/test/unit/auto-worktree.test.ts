import type { FolderId } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAutoWorktreeId } from "../../src/lib/auto-worktree.ts";
import { useRepositorySettingsStore } from "../../src/store/repository-settings.ts";
import { useSettingsStore } from "../../src/store/settings.ts";
import { useWorktreesStore } from "../../src/store/worktrees.ts";

const projectId = "project-auto-worktree" as FolderId;

describe("resolveAutoWorktreeId", () => {
	beforeEach(() => {
		useSettingsStore.setState({ defaultAutoCreateWorktree: true });
		useRepositorySettingsStore.setState({
			refresh: vi.fn(async () => null),
		});
	});

	it("does not silently start in the main checkout when worktree creation fails", async () => {
		useWorktreesStore.setState({
			create: vi.fn(async () => null),
			error: "remote fetch failed",
		});

		await expect(resolveAutoWorktreeId(projectId)).rejects.toThrow(
			"remote fetch failed",
		);
	});
});
