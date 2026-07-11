import { Effect, Layer } from "effect";
import { ConversationRuntime } from "../services/conversation-runtime.ts";
import { QueueService } from "../services/conversation-services.ts";

export const QueueServiceLive = Layer.effect(
	QueueService,
	Effect.map(ConversationRuntime, (runtime) => runtime.queue),
);
