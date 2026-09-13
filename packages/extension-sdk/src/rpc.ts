import type { Schema } from "effect";
import type { ExtensionRpcContract } from "./contracts.ts";

const RPC_NAME = /^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)*$/;

export const defineRpc = <Input, Output>(input: {
	readonly name: string;
	readonly input: Schema.ConstraintDecoder<Input>;
	readonly output: Schema.ConstraintDecoder<Output>;
}): ExtensionRpcContract<Input, Output> => {
	if (!RPC_NAME.test(input.name)) {
		throw new Error(`Invalid extension RPC name: ${input.name}`);
	}
	return input;
};
