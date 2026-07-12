import { Option, Schema } from "effect";

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

export const JsonRpcError = Schema.Struct({
	code: Schema.optional(Schema.Number),
	message: Schema.optional(Schema.String),
	data: Schema.optional(Schema.Unknown),
});
export type JsonRpcError = typeof JsonRpcError.Type;

export const JsonRpcFailure = Schema.Struct({
	jsonrpc: Schema.Literal("2.0"),
	id: Schema.NullOr(JsonRpcId),
	error: JsonRpcError,
});

export const JsonRpcMessage = Schema.Union([
	JsonRpcRequest,
	JsonRpcNotification,
	JsonRpcSuccess,
	JsonRpcFailure,
]);
export type JsonRpcMessage = typeof JsonRpcMessage.Type;

/**
 * Tolerant envelope used at provider boundaries. Some ACP implementations
 * omit `jsonrpc` or emit partial error objects, so compatibility is isolated
 * here while the strict protocol codecs above remain available to callers.
 */
export const CompatibleJsonRpcMessage = Schema.Struct({
	jsonrpc: Schema.optional(Schema.Literal("2.0")),
	id: Schema.optional(Schema.NullOr(JsonRpcId)),
	method: Schema.optional(Schema.String),
	params: Schema.optional(Schema.Unknown),
	result: Schema.optional(Schema.Unknown),
	error: Schema.optional(JsonRpcError),
});
export type CompatibleJsonRpcMessage = typeof CompatibleJsonRpcMessage.Type;

const decodeCompatibleJsonRpcLine = Schema.decodeUnknownOption(
	Schema.fromJsonString(CompatibleJsonRpcMessage),
);

export const decodeJsonRpcLine = (
	line: string,
): CompatibleJsonRpcMessage | null =>
	Option.getOrNull(decodeCompatibleJsonRpcLine(line));
