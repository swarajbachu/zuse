import { Context } from "effect";
import type {
	ChatServiceShape,
	MessageServiceShape,
	QueueServiceShape,
	SessionServiceShape,
	TranscriptServiceShape,
} from "../services/conversation-services.ts";

/** Internal runtime shared by the five public conversation service layers. */
export interface ConversationRuntimeShape {
	readonly session: SessionServiceShape;
	readonly chat: ChatServiceShape;
	readonly transcript: TranscriptServiceShape;
	readonly message: MessageServiceShape;
	readonly queue: QueueServiceShape;
}

export class ConversationRuntime extends Context.Service<
	ConversationRuntime,
	ConversationRuntimeShape
>()("zuse/ConversationRuntime") {}
