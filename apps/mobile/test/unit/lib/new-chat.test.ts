import { describe, expect, test } from "vitest";

import {
	buildNewChatCreatePayload,
	MAIN_SOURCE,
	sourceOptionsForKind,
} from "../../../src/lib/new-chat";

describe("new chat helper", () => {
	test("does not create without prompt or project", () => {
		const base = {
			connectionKey: "env-1",
			projectId: "project-1" as never,
			providerId: "codex" as const,
			model: "gpt-5-codex",
			runtimeMode: "approval-required" as const,
			permissionMode: "default" as const,
			source: MAIN_SOURCE,
		};

		expect(buildNewChatCreatePayload({ ...base, text: "   " })).toBeNull();
		expect(
			buildNewChatCreatePayload({ ...base, projectId: null, text: "hello" }),
		).toBeNull();
	});

	test("builds payload from selected options", () => {
		const payload = buildNewChatCreatePayload({
			connectionKey: "env-1",
			projectId: "project-1" as never,
			providerId: "claude",
			model: "claude-sonnet-5",
			runtimeMode: "full-access",
			permissionMode: "plan",
			modelOptions: { effort: "high" },
			source: {
				kind: "branch",
				label: "feature",
				worktreeId: null,
				createSource: { _tag: "branch", branch: "feature", remote: "origin" },
			},
			text: "  build it  ",
		});

		expect(payload).toMatchObject({
			projectId: "project-1",
			providerId: "claude",
			model: "claude-sonnet-5",
			runtimeMode: "full-access",
			permissionMode: "plan",
			modelOptions: { effort: "high" },
			initialPrompt: "build it",
			createSource: { _tag: "branch", branch: "feature", remote: "origin" },
		});
	});

	test("sourceOptionsForKind builds per-kind source objects", () => {
		const worktrees = [{ id: "wt-1", branch: "feature-a" }] as never;
		const branches = [
			{ kind: "local", name: "main", current: true, remote: null },
			{ kind: "local", name: "feature-b", current: false, remote: "origin" },
		] as never;
		const prs = [
			{ number: 7, title: "Fix bug", headRefName: "fix-bug" },
		] as never;

		expect(sourceOptionsForKind("main", worktrees, branches, prs)).toEqual([
			{ key: "main", label: MAIN_SOURCE.label, source: MAIN_SOURCE },
		]);

		expect(sourceOptionsForKind("worktree", worktrees, branches, prs)).toEqual([
			{
				key: "wt-1",
				label: "feature-a",
				source: { kind: "worktree", label: "feature-a", worktreeId: "wt-1" },
			},
		]);

		// Current branch is excluded.
		const branchOpts = sourceOptionsForKind("branch", worktrees, branches, prs);
		expect(branchOpts).toHaveLength(1);
		expect(branchOpts[0]?.source).toMatchObject({
			kind: "branch",
			label: "feature-b",
			createSource: { _tag: "branch", branch: "feature-b", remote: "origin" },
		});

		const prOpts = sourceOptionsForKind("pr", worktrees, branches, prs);
		expect(prOpts[0]).toMatchObject({
			key: "pr:7",
			label: "#7 Fix bug",
			source: {
				kind: "pr",
				label: "#7",
				createSource: { _tag: "pr", number: 7, headRefName: "fix-bug" },
			},
		});
	});
});
