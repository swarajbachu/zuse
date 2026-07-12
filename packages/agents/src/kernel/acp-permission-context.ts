import type {
	AgentSessionId,
	FolderId,
	PermissionDecision,
	PermissionKind,
	PermissionMode,
	RuntimeMode,
} from "@zuse/contracts";

export interface AcpPermissionContext {
	readonly cwd: string;
	readonly sessionId?: AgentSessionId;
	readonly projectId?: FolderId;
	readonly requestPermission?: (
		kind: PermissionKind,
		options: { readonly forcePrompt: boolean },
	) => Promise<PermissionDecision>;
	readonly getRuntimeMode?: () => RuntimeMode;
	readonly getPermissionMode?: () => PermissionMode;
}

export const makeAcpPermissionContext =
	(
		context: Required<AcpPermissionContext>,
	): (() => Required<AcpPermissionContext>) =>
	() =>
		context;
