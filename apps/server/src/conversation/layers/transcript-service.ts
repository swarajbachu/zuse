import { Effect, Layer } from "effect";
import { ConversationRuntime } from "../services/conversation-runtime.ts";
import { TranscriptService } from "../services/conversation-services.ts";

export const TranscriptServiceLive = Layer.effect(
	TranscriptService,
	Effect.map(ConversationRuntime, (runtime) => runtime.transcript),
);
