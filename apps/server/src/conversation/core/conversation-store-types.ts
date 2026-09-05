import type { AgentTurnId, Message } from "@zuse/contracts";

/** A persisted message and its assigned global event-log sequence. */
export interface PersistedMessage {
	readonly message: Message;
	readonly sequence: number;
	/** Durable causal turn identity when the persisted row belongs to a turn. */
	readonly turnId?: AgentTurnId;
	/** False when an idempotency or checkpoint fence retained an existing row. */
	readonly changed?: boolean;
}
