import { Effect, Layer } from "effect";
import { ConversationRuntime } from "../services/conversation-runtime.ts";
import { MessageService } from "../services/conversation-services.ts";

export const MessageServiceLive = Layer.effect(
	MessageService,
	Effect.map(ConversationRuntime, (runtime) => runtime.message),
);
