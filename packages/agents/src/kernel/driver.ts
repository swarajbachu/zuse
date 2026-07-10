import type { Effect, Scope, Stream } from "effect";

import type { AgentEvent, ProviderId } from "./agent-event.js";

export type DriverFailureKind =
	| "not-installed"
	| "not-authenticated"
	| "protocol"
	| "process"
	| "network";

export class DriverError extends Error {
	readonly _tag = "DriverError";
	constructor(
		readonly providerId: ProviderId,
		readonly kind: DriverFailureKind,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

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
