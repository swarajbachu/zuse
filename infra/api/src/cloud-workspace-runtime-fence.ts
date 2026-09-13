export interface CloudWorkspaceRuntimeFenceSource {
	readonly requestConfig: Readonly<Record<string, unknown>>;
}

/** Current runtime generation, including the pre-fence workspace default. */
export const cloudWorkspaceRuntimeGeneration = (
	workspace: CloudWorkspaceRuntimeFenceSource,
): number =>
	typeof workspace.requestConfig.runtimeGeneration === "number"
		? workspace.requestConfig.runtimeGeneration
		: 1;

/** Current gateway epoch; legacy rows used runtime generation as the epoch. */
export const cloudWorkspaceGatewayEpoch = (
	workspace: CloudWorkspaceRuntimeFenceSource,
): number =>
	typeof workspace.requestConfig.gatewayEpoch === "number"
		? workspace.requestConfig.gatewayEpoch
		: cloudWorkspaceRuntimeGeneration(workspace);

/**
 * Allocate the next independent runtime fences. Missing counters mean the
 * workspace has not yet allocated that counter, so its first value is one.
 */
export const nextCloudWorkspaceRuntimeFence = (
	workspace: CloudWorkspaceRuntimeFenceSource,
): { readonly runtimeGeneration: number; readonly gatewayEpoch: number } => ({
	runtimeGeneration:
		(typeof workspace.requestConfig.runtimeGeneration === "number"
			? workspace.requestConfig.runtimeGeneration
			: 0) + 1,
	gatewayEpoch:
		(typeof workspace.requestConfig.gatewayEpoch === "number"
			? workspace.requestConfig.gatewayEpoch
			: 0) + 1,
});
