import { Effect, Layer } from "effect";
import { ConversationRuntime } from "../services/conversation-runtime.ts";
import { SessionService } from "../services/conversation-services.ts";

export const SessionServiceLive = Layer.effect(
	SessionService,
	Effect.map(ConversationRuntime, (runtime) => runtime.session),
);
