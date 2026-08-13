import { Effect, Layer } from "effect";
import { ConversationRuntime } from "../services/conversation-runtime.ts";
import {
	QueueService,
	QueueTransactionService,
} from "../services/conversation-services.ts";

export const QueueServiceLive = Layer.effect(
	QueueService,
	Effect.map(ConversationRuntime, (runtime) => runtime.queue),
);

export const QueueTransactionServiceLive = Layer.effect(
	QueueTransactionService,
	Effect.map(ConversationRuntime, (runtime) => runtime.queueTransaction),
);
