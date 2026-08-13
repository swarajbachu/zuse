import { Effect } from "effect";

import { getControlPlaneRpcClient, type MemoizeClient } from "./rpc-client.ts";

/** Single renderer boundary for Relay account and workspace lifecycle RPCs. */
export const runControlPlane = async <Result>(
	effect: (client: MemoizeClient) => Effect.Effect<Result, unknown>,
): Promise<Result> => {
	const client = await getControlPlaneRpcClient();
	return Effect.runPromise(effect(client));
};

export const controlPlaneClient = (): Promise<MemoizeClient> =>
	getControlPlaneRpcClient();
