import type { AcpRpcId, AcpRpcMessage } from "@zuse/acp/rpc-client";

export const replyToAcpRequest = <Result>(
	send: (message: AcpRpcMessage) => void,
	id: AcpRpcId,
	result: Promise<Result>,
): void => {
	void result.then(
		(value) => send({ jsonrpc: "2.0", id, result: value }),
		(cause) =>
			send({
				jsonrpc: "2.0",
				id,
				error: {
					code: -32603,
					message: cause instanceof Error ? cause.message : String(cause),
				},
			}),
	);
};
