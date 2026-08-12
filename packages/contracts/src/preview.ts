import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

/** A loopback HTTP server detected on the environment that owns the project. */
export class PreviewServer extends Schema.Class<PreviewServer>("PreviewServer")(
	{
		name: Schema.String,
		port: Schema.Number,
	},
) {}

export class PreviewServerList extends Schema.Class<PreviewServerList>(
	"PreviewServerList",
)({
	servers: Schema.Array(PreviewServer),
}) {}

export const PreviewErrorCode = Schema.Literals([
	"invalid-port",
	"server-not-found",
	"server-not-http",
	"private-network-required",
	"private-network-permission-required",
	"private-preview-approval-required",
	"preview-unavailable",
]);
export type PreviewErrorCode = typeof PreviewErrorCode.Type;

export class PreviewOpError extends Schema.TaggedErrorClass<PreviewOpError>()(
	"PreviewOpError",
	{
		code: PreviewErrorCode,
		approvalUrl: Schema.optional(Schema.String),
	},
) {}

export class PreviewForwardRequest extends Schema.Class<PreviewForwardRequest>(
	"PreviewForwardRequest",
)({
	port: Schema.Number,
}) {}

export class PreviewForwardResult extends Schema.Class<PreviewForwardResult>(
	"PreviewForwardResult",
)({
	port: Schema.Number,
	url: Schema.String,
	transport: Schema.Literal("private-network"),
}) {}

export const PreviewServersListRpc = Rpc.make("preview.servers.list", {
	payload: Schema.Void,
	success: PreviewServerList,
	error: PreviewOpError,
});

export const PreviewForwardRpc = Rpc.make("preview.forward", {
	payload: PreviewForwardRequest,
	success: PreviewForwardResult,
	error: PreviewOpError,
});
