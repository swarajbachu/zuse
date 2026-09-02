import type {
	ChatWorkspacePolicy,
	ChatWorkspaceRequestPolicy,
	WorktreeId,
} from "@zuse/contracts";

export const resolveChatWorkspacePolicyRequest = (input: {
	readonly request: ChatWorkspaceRequestPolicy | undefined;
	readonly legacyWorktreeId: WorktreeId | null | undefined;
	readonly defaultAutoCreateWorktree: boolean;
	readonly repositoryAutoCreateWorktree: boolean;
}): ChatWorkspacePolicy => {
	const request =
		input.request ??
		(input.legacyWorktreeId === null || input.legacyWorktreeId === undefined
			? { _tag: "main" as const }
			: {
					_tag: "existing" as const,
					worktreeId: input.legacyWorktreeId,
				});
	if (request._tag !== "automatic") return request;
	return input.defaultAutoCreateWorktree || input.repositoryAutoCreateWorktree
		? { _tag: "fresh" }
		: { _tag: "main" };
};
