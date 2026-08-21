import type {
	ChatId,
	EnvironmentId,
	FolderId,
	PtyId,
	SessionId,
	WorktreeId,
} from "@zuse/contracts";

export type EnvironmentRef = Readonly<{
	environmentId: EnvironmentId;
}>;

export type ProjectRef = Readonly<{
	environmentId: EnvironmentId;
	projectId: FolderId;
}>;

export type ChatRef = Readonly<{
	environmentId: EnvironmentId;
	chatId: ChatId;
}>;

export type SessionRef = Readonly<{
	environmentId: EnvironmentId;
	sessionId: SessionId;
}>;

export type ExecutionRef = Readonly<{
	environmentId: EnvironmentId;
	folderId: FolderId;
	worktreeId: WorktreeId | null;
	rootPath: string;
}>;

export type TerminalRef = Readonly<{
	environmentId: EnvironmentId;
	terminalId: PtyId;
}>;

export type WorktreeRef = Readonly<{
	environmentId: EnvironmentId;
	projectId: FolderId;
	worktreeId: WorktreeId;
}>;

export type ResourceRef =
	| EnvironmentRef
	| ProjectRef
	| ChatRef
	| SessionRef
	| ExecutionRef
	| TerminalRef
	| WorktreeRef;

const part = (value: string): string => encodeURIComponent(value);

/** A stable, collision-safe key for an environment-qualified reference. */
export const resourceRefKey = (ref: ResourceRef): string => {
	const environment = part(ref.environmentId);
	if ("sessionId" in ref) {
		return `session:${environment}:${part(ref.sessionId)}`;
	}
	if ("chatId" in ref) {
		return `chat:${environment}:${part(ref.chatId)}`;
	}
	if ("worktreeId" in ref && "projectId" in ref) {
		return `worktree:${environment}:${part(ref.projectId)}:${part(ref.worktreeId)}`;
	}
	if ("projectId" in ref) {
		return `project:${environment}:${part(ref.projectId)}`;
	}
	if ("terminalId" in ref) {
		return `terminal:${environment}:${part(ref.terminalId)}`;
	}
	if ("folderId" in ref) {
		return [
			"execution",
			environment,
			part(ref.folderId),
			ref.worktreeId === null ? "none" : `some-${part(ref.worktreeId)}`,
			part(ref.rootPath),
		].join(":");
	}
	return `environment:${environment}`;
};

export type ResourceKind =
	| "environment-shell"
	| "environment-permissions"
	| "environment-browser-commands"
	| "environment-auth"
	| "environment-keybindings"
	| "environment-settings"
	| "worktree-setup"
	| "session-timeline"
	| "session-goal"
	| "session-skills"
	| "file-tree"
	| "git-workspace"
	| "git-changes"
	| "git-review"
	| "git-pr-details"
	| "machine-resources"
	| "terminal";

/**
 * Data is a phantom parameter so a resource key carries its snapshot type
 * through ClientBus without storing constructors or schemas at runtime.
 */
export type ResourceKey<Data = unknown> = Readonly<{
	kind: ResourceKind;
	ref: ResourceRef;
	readonly __data?: Data;
}>;

export type ResourceData<Key> =
	Key extends ResourceKey<infer Data> ? Data : never;

export const makeResourceKey = <Data>(
	kind: ResourceKind,
	ref: ResourceRef,
): ResourceKey<Data> => ({ kind, ref });

export const resourceKeyId = (key: ResourceKey<unknown>): string => {
	if (
		(key.kind === "git-workspace" ||
			key.kind === "git-changes" ||
			key.kind === "git-review" ||
			key.kind === "git-pr-details") &&
		"folderId" in key.ref
	) {
		const worktree =
			key.ref.worktreeId === null ? "none" : `some-${part(key.ref.worktreeId)}`;
		return `${key.kind}:execution:${part(key.ref.environmentId)}:${part(key.ref.folderId)}:${worktree}`;
	}
	return `${key.kind}:${resourceRefKey(key.ref)}`;
};
