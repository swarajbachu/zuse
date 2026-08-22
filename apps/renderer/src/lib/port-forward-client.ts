import { getTunnelsBridge } from "./bridge.ts";
import { prepareCloudWorkspaceSsh } from "./cloud-ssh-client-bus.ts";
import {
	getLocalEnvironmentId,
	isCloudWorkspaceEnvironment,
} from "./rpc-client.ts";

export const cloudAccessForwardFailure = (cause: unknown): boolean => {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return /(?:zuse ssh bridge:|permission denied|connection (?:unexpectedly )?(?:closed|reset|timed out)|kex_exchange_identification|no route to host|could not resolve hostname|tunnel timed out before it became ready)/iu.test(
		detail,
	);
};

/**
 * Ensure a dev server port on the given environment is reachable locally and
 * return the local port to open. Local environments need no forward; cloud
 * and SSH environments get an idempotent tunnel from the desktop main
 * process. Cloud forwards refresh the workspace SSH ticket first, so an
 * expired ticket never surfaces as a dead tunnel.
 */
export const ensurePortForward = async (
	environmentId: string,
	remotePort: number,
): Promise<number> => {
	if (environmentId === getLocalEnvironmentId()) return remotePort;
	const tunnels = getTunnelsBridge();
	if (tunnels === undefined) {
		throw new Error("Previewing remote servers requires the Zuse desktop app.");
	}
	const live = (await tunnels.list(environmentId)).find(
		(forward) => forward.remotePort === remotePort,
	);
	if (live !== undefined) return live.localPort;
	if (isCloudWorkspaceEnvironment(environmentId)) {
		await prepareCloudWorkspaceSsh(environmentId);
		try {
			const forward = await tunnels.open({
				environmentId,
				remotePort,
				cloudWorkspaceId: environmentId,
			});
			return forward.localPort;
		} catch (cause) {
			if (!cloudAccessForwardFailure(cause)) throw cause;
			// A bridge can fail after its ticket was prepared (for example when the
			// workspace paused between those operations). Refresh credentials once.
			await prepareCloudWorkspaceSsh(environmentId);
			const forward = await tunnels.open({
				environmentId,
				remotePort,
				cloudWorkspaceId: environmentId,
			});
			return forward.localPort;
		}
	}
	const forward = await tunnels.open({ environmentId, remotePort });
	return forward.localPort;
};
