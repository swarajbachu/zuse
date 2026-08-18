import { CommandId } from "@zuse/contracts";

/**
 * A chat creation operation is durable across retries, but each explicit
 * dispatch is a distinct immutable client command. Transport retries keep the
 * returned id with their persisted command; a user or recovery retry calls
 * this again and receives a fresh id for the same operation.
 */
export const nextChatCreateCommandId = (operationId: string): CommandId =>
	CommandId.make(`chat-create:${operationId}:${crypto.randomUUID()}`);
