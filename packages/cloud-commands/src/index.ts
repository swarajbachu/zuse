import {
	CommandId,
	ComposerInput,
	MessageId,
	SessionId,
} from "@zuse/contracts";
import { Schema } from "effect";

export type CloudCommandCrashRecovery =
	| "transactional-receipt"
	| "durable-workflow"
	| "generation-fenced";

export const CloudMessageSendPayload = Schema.Struct({
	commandId: CommandId,
	sessionId: SessionId,
	text: Schema.optional(Schema.String),
	input: Schema.optional(ComposerInput),
	asGoal: Schema.optional(Schema.Boolean),
	clientMessageId: MessageId,
	modelOptions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type CloudMessageSendPayload = typeof CloudMessageSendPayload.Type;

export const CloudMessageSendResult = Schema.Struct({
	commandId: CommandId,
	result: Schema.Null,
});
export type CloudMessageSendResult = typeof CloudMessageSendResult.Type;

export type CloudCommandResult = Readonly<{
	commandId: typeof CommandId.Type;
	result: unknown;
}>;

export type CloudCommandEligibility = Readonly<{
	kind: string;
	schemaVersion: 1;
	maxPlaintextBytes: number;
	lane: "session";
	dependencies: "none" | "encrypted-attachments";
	destructionFence: true;
	recovery: CloudCommandCrashRecovery;
	payloadCodec: Schema.ConstraintDecoder<unknown>;
	resultCodec: Schema.ConstraintDecoder<CloudCommandResult>;
}>;

/**
 * The executable mailbox registry. A kind is added only in the same change as
 * its client encoder, runtime apply/receipt path, and crash-recovery tests.
 */
export const CLOUD_COMMAND_ELIGIBILITY = [
	{
		kind: "messages.send",
		schemaVersion: 1,
		maxPlaintextBytes: 128 * 1024,
		lane: "session",
		dependencies: "none",
		destructionFence: true,
		recovery: "durable-workflow",
		payloadCodec: CloudMessageSendPayload,
		resultCodec: CloudMessageSendResult,
	},
] as const satisfies ReadonlyArray<CloudCommandEligibility>;

export type CloudMailboxEligibleKind =
	(typeof CLOUD_COMMAND_ELIGIBILITY)[number]["kind"];

export const cloudCommandEligibility = (kind: string) =>
	CLOUD_COMMAND_ELIGIBILITY.find((entry) => entry.kind === kind);

export const cloudCommandEnvelopeEligibility = (input: {
	readonly kind: string;
	readonly schemaVersion: number;
	readonly dependencies: ReadonlyArray<unknown>;
}): CloudCommandEligibility | undefined => {
	const eligibility = cloudCommandEligibility(input.kind);
	if (
		eligibility === undefined ||
		input.schemaVersion !== eligibility.schemaVersion ||
		(eligibility.dependencies === "none" && input.dependencies.length !== 0)
	)
		return undefined;
	return eligibility;
};

/** Lanes are derived from authenticated envelope metadata, never payload. */
export const cloudCommandLane = (input: {
	readonly kind: string;
	readonly schemaVersion: number;
	readonly dependencies: ReadonlyArray<unknown>;
	readonly sessionId: string;
}): string | undefined =>
	cloudCommandEnvelopeEligibility(input)?.lane === "session"
		? `session:${input.sessionId}`
		: undefined;

export type CloudMessageSendPayloadLimitation =
	| "attachments-not-supported"
	| "goal-mode-not-supported";

/** Returns the first v3-slice limitation shared by client and runtime. */
export const cloudMessageSendPayloadLimitation = (
	payload: CloudMessageSendPayload,
): CloudMessageSendPayloadLimitation | null => {
	if ((payload.input?.attachments.length ?? 0) > 0)
		return "attachments-not-supported";
	if ((payload.input?.asGoal ?? payload.asGoal) === true)
		return "goal-mode-not-supported";
	return null;
};

export const decodeCloudMessageSendPayload = (
	value: unknown,
): CloudMessageSendPayload | null => {
	try {
		const payload = Schema.decodeUnknownSync(
			CLOUD_COMMAND_ELIGIBILITY[0].payloadCodec,
			{
				onExcessProperty: "error",
			},
		)(value);
		return payload.text === undefined && payload.input === undefined
			? null
			: payload;
	} catch {
		return null;
	}
};

/** Decode a terminal result with the codec selected by authenticated metadata. */
export const decodeCloudCommandResult = (
	eligibility: CloudCommandEligibility,
	value: unknown,
): CloudCommandResult | null => {
	try {
		return Schema.decodeUnknownSync(eligibility.resultCodec, {
			onExcessProperty: "error",
		})(value);
	} catch {
		return null;
	}
};
