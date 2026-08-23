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
			createWorktree: true,
			createSource: { _tag: "branch", branch: "feature", remote: "origin" },
		});
	});

	test("creates a fresh worktree from the default branch", () => {
		const payload = buildNewChatCreatePayload({
			connectionKey: "env-1",
			projectId: "project-1" as never,
			providerId: "codex",
			model: "gpt-5-codex",
			runtimeMode: "approval-required",
			permissionMode: "default",
			source: {
				kind: "worktree",
				label: "main",
				worktreeId: null,
			},
			text: "build it",
		});

		expect(payload).toMatchObject({
			worktreeId: null,
			createWorktree: true,
			createSource: null,
		});
	});

	test("sourceOptionsForKind builds per-kind source objects", () => {
		const branches = [
			{ kind: "local", name: "main", current: true, remote: null },
			{ kind: "local", name: "feature-b", current: false, remote: "origin" },
		] as never;
		const prs = [
			{ number: 7, title: "Fix bug", headRefName: "fix-bug" },
		] as never;

		expect(sourceOptionsForKind("main", branches, prs)).toEqual([
			{ key: "main", label: MAIN_SOURCE.label, source: MAIN_SOURCE },
		]);

		expect(sourceOptionsForKind("worktree", branches, prs)).toEqual([
			{
				key: "new-worktree:main",
				label: "main",
				source: { kind: "worktree", label: "main", worktreeId: null },
			},
		]);

		// Current branch is excluded.
		const branchOpts = sourceOptionsForKind("branch", branches, prs);
		expect(branchOpts).toHaveLength(1);
		expect(branchOpts[0]?.source).toMatchObject({
			kind: "branch",
			label: "feature-b",
			createSource: { _tag: "branch", branch: "feature-b", remote: "origin" },
		});

		const prOpts = sourceOptionsForKind("pr", branches, prs);
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
