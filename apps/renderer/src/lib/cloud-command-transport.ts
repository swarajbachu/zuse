import { makeCloudCommandTransport } from "@zuse/client-runtime/cloud-command-transport";
import { getControlPlaneRpcClient } from "./rpc-client.ts";

export const cloudCommandTransport = makeCloudCommandTransport(() =>
	getControlPlaneRpcClient(),
);
