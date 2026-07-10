import { Schema } from "effect";

export const JsonRpcId = Schema.Union([Schema.String, Schema.Number]);
export type JsonRpcId = typeof JsonRpcId.Type;

export const JsonRpcRequest = Schema.Struct({
	jsonrpc: Schema.Literal("2.0"),
	id: JsonRpcId,
	method: Schema.String,
	params: Schema.optional(Schema.Unknown),
});
export type JsonRpcRequest = typeof JsonRpcRequest.Type;

export const JsonRpcNotification = Schema.Struct({
	jsonrpc: Schema.Literal("2.0"),
	method: Schema.String,
	params: Schema.optional(Schema.Unknown),
});
export type JsonRpcNotification = typeof JsonRpcNotification.Type;

export const JsonRpcSuccess = Schema.Struct({
	jsonrpc: Schema.Literal("2.0"),
	id: JsonRpcId,
	result: Schema.Unknown,
});

export const JsonRpcFailure = Schema.Struct({
	jsonrpc: Schema.Literal("2.0"),
	id: Schema.NullOr(JsonRpcId),
	error: Schema.Struct({
		code: Schema.Number,
		message: Schema.String,
		data: Schema.optional(Schema.Unknown),
	}),
});

export const JsonRpcMessage = Schema.Union([
	JsonRpcRequest,
	JsonRpcNotification,
	JsonRpcSuccess,
	JsonRpcFailure,
]);
export type JsonRpcMessage = typeof JsonRpcMessage.Type;
