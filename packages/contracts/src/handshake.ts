import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

export const WIRE_PROTOCOL_VERSION = 3 as const;

export class WireHello extends Schema.Class<WireHello>("WireHello")({
	protocolVersion: Schema.Number,
}) {}

export class WireWelcome extends Schema.Class<WireWelcome>("WireWelcome")({
	protocolVersion: Schema.Number,
}) {}

export class WireProtocolRejected extends Schema.TaggedErrorClass<WireProtocolRejected>()(
	"WireProtocolRejected",
	{
		expectedVersion: Schema.Number,
		receivedVersion: Schema.Number,
	},
) {}

export const ConnectHandshakeRpc = Rpc.make("connect.handshake", {
	payload: WireHello,
	success: WireWelcome,
	error: WireProtocolRejected,
});
