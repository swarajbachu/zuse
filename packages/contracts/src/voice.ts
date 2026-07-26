import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

export const VoiceFallbackReason = Schema.Literals([
	"unsupported",
	"blocked",
	"authentication-rejected",
]);
export type VoiceFallbackReason = typeof VoiceFallbackReason.Type;

export class VoiceValidationError extends Schema.TaggedErrorClass<VoiceValidationError>()(
	"VoiceValidationError",
	{ reason: Schema.String },
) {}

export class VoiceUnavailableError extends Schema.TaggedErrorClass<VoiceUnavailableError>()(
	"VoiceUnavailableError",
	{ reason: Schema.String },
) {}

export class VoiceFallbackTicketError extends Schema.TaggedErrorClass<VoiceFallbackTicketError>()(
	"VoiceFallbackTicketError",
	{ reason: Schema.String },
) {}

export const VoiceCapabilitiesRpc = Rpc.make("voice.capabilities", {
	payload: Schema.Struct({}),
	success: Schema.Struct({
		available: Schema.Boolean,
		accountKind: Schema.NullOr(Schema.Literal("chatgpt")),
		maxDurationSeconds: Schema.Number,
		maxBytes: Schema.Number,
	}),
});

export const VoicePrewarmRpc = Rpc.make("voice.prewarm", {
	payload: Schema.Struct({}),
	success: Schema.Struct({ ready: Schema.Boolean }),
	error: VoiceUnavailableError,
});

export const VoiceTranscriptionResult = Schema.Union([
	Schema.TaggedStruct("transcribed", { text: Schema.String }),
	Schema.TaggedStruct("phoneFallbackRequired", {
		reason: VoiceFallbackReason,
		ticket: Schema.String,
	}),
]);
export type VoiceTranscriptionResult = typeof VoiceTranscriptionResult.Type;

export const VoiceTranscribeRpc = Rpc.make("voice.transcribe", {
	payload: Schema.Struct({
		bytes: Schema.Uint8ArrayFromBase64,
		mimeType: Schema.String,
		durationMs: Schema.Number,
	}),
	success: VoiceTranscriptionResult,
	error: Schema.Union([VoiceValidationError, VoiceUnavailableError]),
});

/**
 * Isolated so callers can keep the result in a single-use in-memory scope.
 * Never pass this result to diagnostics, crash reporting, analytics,
 * persistence, or generic error formatting.
 */
export const VoiceResolveAuthRpc = Rpc.make("voice.resolveAuth", {
	payload: Schema.Struct({ ticket: Schema.String }),
	success: Schema.Struct({
		token: Schema.String,
		accountId: Schema.NullOr(Schema.String),
		endpoint: Schema.String,
	}),
	error: Schema.Union([VoiceFallbackTicketError, VoiceUnavailableError]),
});
