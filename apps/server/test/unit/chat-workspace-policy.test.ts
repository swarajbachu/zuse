import { WorktreeId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { resolveChatWorkspacePolicyRequest } from "../../src/conversation/core/chat-workspace-policy.ts";

describe("chat workspace request policy", () => {
	it.each([
		[true, false],
		[false, true],
	] as const)("resolves automatic to fresh for global=%s repository=%s", (defaultAutoCreateWorktree, repositoryAutoCreateWorktree) => {
		expect(
			resolveChatWorkspacePolicyRequest({
				request: { _tag: "automatic" },
				legacyWorktreeId: null,
				defaultAutoCreateWorktree,
				repositoryAutoCreateWorktree,
			}),
		).toEqual({ _tag: "fresh" });
	});

	it("resolves automatic to main when auto creation is disabled", () => {
		expect(
			resolveChatWorkspacePolicyRequest({
				request: { _tag: "automatic" },
				legacyWorktreeId: null,
				defaultAutoCreateWorktree: false,
				repositoryAutoCreateWorktree: false,
			}),
		).toEqual({ _tag: "main" });
	});

	it("preserves explicit and legacy workspace choices", () => {
		const worktreeId = WorktreeId.make("worktree-existing");
		for (const request of [
			{ _tag: "fresh" as const },
			{ _tag: "main" as const },
		]) {
			expect(
				resolveChatWorkspacePolicyRequest({
					request,
					legacyWorktreeId: null,
					defaultAutoCreateWorktree: true,
					repositoryAutoCreateWorktree: true,
				}),
			).toEqual(request);
		}
		expect(
			resolveChatWorkspacePolicyRequest({
				request: { _tag: "existing", worktreeId },
				legacyWorktreeId: null,
				defaultAutoCreateWorktree: true,
				repositoryAutoCreateWorktree: true,
			}),
		).toEqual({ _tag: "existing", worktreeId });
		expect(
			resolveChatWorkspacePolicyRequest({
				request: undefined,
				legacyWorktreeId: worktreeId,
				defaultAutoCreateWorktree: false,
				repositoryAutoCreateWorktree: false,
			}),
		).toEqual({ _tag: "existing", worktreeId });
	});
});
