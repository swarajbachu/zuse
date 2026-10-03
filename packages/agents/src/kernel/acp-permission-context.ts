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
	readonly executionEnvironment?: Readonly<Record<string, string>>;
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
		context: Required<Omit<AcpPermissionContext, "executionEnvironment">> &
			Pick<AcpPermissionContext, "executionEnvironment">,
	): (() => Required<Omit<AcpPermissionContext, "executionEnvironment">> &
		Pick<AcpPermissionContext, "executionEnvironment">) =>
	() =>
		context;
