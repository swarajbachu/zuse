import type { Message } from "@zuse/contracts";

/** A persisted message and its assigned global event-log sequence. */
export interface PersistedMessage {
	readonly message: Message;
	readonly sequence: number;
}
