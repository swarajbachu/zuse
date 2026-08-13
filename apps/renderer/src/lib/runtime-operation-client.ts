import { Effect } from "effect";

import { getRpcClient, type MemoizeClient } from "./rpc-client.ts";

/**
 * Scoped escape hatch for interactive runtime operations that are not durable
 * resources (OAuth/login flows and environment resolver handshakes).
 */
export const runtimeOperationClient = (
	environmentId: string,
): Promise<MemoizeClient> => getRpcClient(environmentId);

export const runRuntimeOperation = async <Result>(
	environmentId: string,
	effect: (client: MemoizeClient) => Effect.Effect<Result, unknown>,
): Promise<Result> => {
	const client = await runtimeOperationClient(environmentId);
	return Effect.runPromise(effect(client));
};
