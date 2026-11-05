import { Schema } from "effect";

import type {
	MessageReadRecord,
	SessionReadRecord,
} from "../projectors/read-model.js";

export type SessionListInput = {
	readonly projectId: string;
	readonly includeArchived?: boolean;
};

export type MessagePageInput = {
	readonly sessionId: string;
	readonly beforeSequence?: number | null;
	readonly messageId?: string;
	readonly maxBytes?: number;
	readonly limit: number;
};

export type MessagePage = {
	readonly items: readonly MessageReadRecord[];
	readonly olderSequence: number | null;
};

export type SessionTranscript = {
	readonly session: SessionReadRecord;
	readonly messages: readonly MessageReadRecord[];
};

export class SessionQueryNotFound extends Schema.TaggedErrorClass<SessionQueryNotFound>()(
	"SessionQueryNotFound",
	{ sessionId: Schema.String },
) {}
