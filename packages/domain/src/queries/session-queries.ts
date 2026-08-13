import { Schema } from "effect";

import type {
	MessageReadRecord,
	SessionReadRecord,
	SessionReadRepository,
} from "../projectors/read-model.js";

export type SessionListInput = {
	readonly projectId: string;
	readonly includeArchived?: boolean;
	readonly includeDeleted?: boolean;
};

export type MessagePageInput = {
	readonly sessionId: string;
	readonly beforeSequence?: number | null;
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

export class SessionQueries {
	constructor(private readonly repository: SessionReadRepository) {}

	list(input: SessionListInput): Promise<readonly SessionReadRecord[]> {
		const sessions = this.repository
			.sessions()
			.filter((session) => session.projectId === input.projectId)
			.filter((session) => input.includeArchived || session.archivedAt === null)
			.filter((session) => input.includeDeleted || session.deletedAt === null)
			.sort(
				(left, right) =>
					right.updatedAt - left.updatedAt ||
					left.sessionId.localeCompare(right.sessionId),
			);
		return Promise.resolve(sessions);
	}

	transcript(sessionId: string): Promise<SessionTranscript> {
		const session = this.repository.session(sessionId);
		if (session === null)
			return Promise.reject(new SessionQueryNotFound({ sessionId }));
		return Promise.resolve({
			session,
			messages: this.repository.messages(sessionId),
		});
	}

	messagePage(input: MessagePageInput): Promise<MessagePage> {
		const beforeSequence = input.beforeSequence ?? Number.POSITIVE_INFINITY;
		const eligible = this.repository
			.messages(input.sessionId)
			.filter((message) => message.sequence < beforeSequence);
		const start = Math.max(0, eligible.length - input.limit);
		const items = eligible.slice(start);
		const olderSequence = start > 0 ? (items[0]?.sequence ?? null) : null;
		return Promise.resolve({ items, olderSequence });
	}
}
