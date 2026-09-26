import { Chat, Folder, Session } from "@zuse/contracts";
import { Schema } from "effect";

/** JSON dates must be decoded before cached entities enter the application store. */
export const SessionsSnapshot = Schema.Struct({
	projects: Schema.Array(Folder),
	chats: Schema.Array(Chat),
	sessions: Schema.Array(Session),
	savedAt: Schema.Number,
});
export type SessionsSnapshot = typeof SessionsSnapshot.Type;
