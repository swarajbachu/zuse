import type { CloudControlClient } from "@zuse/client-runtime/cloud-control-client";
import type { WorkspaceScope } from "@zuse/contracts";
import { isHostedProduct } from "./platform-capabilities.ts";
import {
	assertRendererAccountCurrent,
	rendererAccountSnapshot,
} from "./renderer-account.ts";
import { rendererWorkspaceSnapshot } from "./renderer-workspace.ts";
import { getControlPlaneRpcClient, type MemoizeClient } from "./rpc-client.ts";

/** Cloud ownership/control uses account HTTP on web, the existing desktop RPC otherwise. */
export const getCloudControlClient = async (
	scope: WorkspaceScope = rendererWorkspaceSnapshot().scope,
): Promise<
	CloudControlClient | Pick<MemoizeClient, keyof CloudControlClient>
> => {
	if (!isHostedProduct()) return getControlPlaneRpcClient(scope);
	const account = rendererAccountSnapshot();
	const [
		{ hostedAccountRequest },
		{ makeCloudControlClient },
		{ makeAccountControlRequest },
		{ cloudControlError },
	] = await Promise.all([
		import("./hosted-connect.ts"),
		import("@zuse/client-runtime/cloud-control-client"),
		import("@zuse/client-runtime/cloud-control-request"),
		import("@zuse/client-runtime/control-api-error"),
	]);
	assertRendererAccountCurrent(account);
	return makeCloudControlClient(
		makeAccountControlRequest({
			isCurrent: () => rendererAccountSnapshot() === account,
			toError: cloudControlError,
			send: (path, method, body, signal) =>
				hostedAccountRequest(path, body, { method, workspace: scope, signal }),
		}),
	);
};
