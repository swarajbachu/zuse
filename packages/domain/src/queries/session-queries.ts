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
	readonly afterSequence?: number | null;
	readonly limit: number;
};

export type MessagePage = {
	readonly items: readonly MessageReadRecord[];
	readonly nextSequence: number | null;
};

export type SessionTranscript = {
	readonly session: SessionReadRecord;
	readonly messages: readonly MessageReadRecord[];
};

export class SessionQueryNotFound extends Error {
	readonly _tag = "SessionQueryNotFound";
	constructor(readonly sessionId: string) {
		super(`session ${sessionId} was not found`);
	}
}

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
			return Promise.reject(new SessionQueryNotFound(sessionId));
		return Promise.resolve({
			session,
			messages: this.repository.messages(sessionId),
		});
	}

	messagePage(input: MessagePageInput): Promise<MessagePage> {
		const afterSequence = input.afterSequence ?? 0;
		const eligible = this.repository
			.messages(input.sessionId)
			.filter((message) => message.sequence > afterSequence);
		const items = eligible.slice(0, input.limit);
		const nextSequence =
			eligible.length > items.length && items.length > 0
				? (items.at(-1)?.sequence ?? null)
				: null;
		return Promise.resolve({ items, nextSequence });
	}
}
