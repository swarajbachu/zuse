import type { SqlClient } from "effect/unstable/sql";

export type ChatLastMessageTarget =
	| { readonly _tag: "Chat"; readonly chatId: string }
	| { readonly _tag: "Session"; readonly sessionId: string };

/**
 * Single write owner for the denormalized chat message timestamp.
 *
 * Normal message projection targets a session; lifecycle import reconciliation
 * targets the chat snapshot directly. Keeping both routes here prevents the two
 * projectors from growing independent timestamp/write semantics.
 */
export const updateChatLastMessage = (
	sql: SqlClient.SqlClient,
	target: ChatLastMessageTarget,
	messageAt: number | null,
) => {
	const value = messageAt === null ? null : new Date(messageAt).toISOString();
	return target._tag === "Chat"
		? sql`
				UPDATE chats SET last_message_at = ${value}
				WHERE id = ${target.chatId}
			`
		: sql`
				UPDATE chats SET last_message_at = ${value}
				WHERE id = (
					SELECT chat_id FROM sessions WHERE id = ${target.sessionId}
				)
			`;
};
