import { type AgentEvent, ProviderId } from "@zuse/contracts";
import { type Effect, Schema, type Scope, type Stream } from "effect";

export const DriverFailureKind = Schema.Literals([
	"not-installed",
	"not-authenticated",
	"protocol",
	"process",
	"network",
]);
export type DriverFailureKind = typeof DriverFailureKind.Type;

export class DriverError extends Schema.TaggedErrorClass<DriverError>()(
	"DriverError",
	{
		providerId: ProviderId,
		kind: DriverFailureKind,
		message: Schema.String,
	},
) {}

export type DriverCapabilities = {
	readonly interactivePermissions: boolean;
	readonly resume: boolean;
	readonly interrupt: boolean;
	readonly reasoning: boolean;
};

export type AgentStartInput = {
	readonly sessionId: string;
	readonly cwd: string;
	readonly model: string;
	readonly cursor?: string;
};

export type AgentSendInput = {
	readonly text: string;
	readonly attachments?: readonly {
		readonly path: string;
		readonly mediaType: string;
	}[];
};

export type AgentHandle = {
	readonly events: Stream.Stream<AgentEvent, DriverError>;
	readonly send: (input: AgentSendInput) => Effect.Effect<void, DriverError>;
	readonly interrupt: Effect.Effect<void, DriverError>;
	readonly close: Effect.Effect<void>;
};

export type AgentDriver = {
	readonly providerId: ProviderId;
	readonly capabilities: DriverCapabilities;
	readonly start: (
		input: AgentStartInput,
	) => Effect.Effect<AgentHandle, DriverError, Scope.Scope>;
};
