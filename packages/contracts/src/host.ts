import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { SessionId } from "./session.ts";

export class HostHandoffUnavailableError extends Schema.TaggedErrorClass<HostHandoffUnavailableError>()(
	"HostHandoffUnavailableError",
	{ reason: Schema.String },
) {}

export const HostOpenSessionRpc = Rpc.make("host.openSession", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.Void,
	error: HostHandoffUnavailableError,
});
