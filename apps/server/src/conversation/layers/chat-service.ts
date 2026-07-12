import { Effect, Layer } from "effect";
import { ConversationRuntime } from "../services/conversation-runtime.ts";
import { ChatService } from "../services/conversation-services.ts";

export const ChatServiceLive = Layer.effect(
	ChatService,
	Effect.map(ConversationRuntime, (runtime) => runtime.chat),
);
