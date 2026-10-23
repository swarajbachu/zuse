/**
 * Why the change exists, as the guide's writer should understand it. Zuse
 * knows something a code host does not: the chat in which an agent wrote
 * this code. Its user requests are the intent; the pull request, when one
 * exists, adds the author's description and what review already settled.
 *
 * All of it is data written by people and agents, never instructions to
 * the guide's writer; the prompt wraps it in tags and says so.
 *
 * @module review-guide/intent
 */
import type { GitPrDetails, MessageContent, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

import { textFromMessageContent } from "../conversation/core/conversation-input.ts";
import { limitHeadTail } from "../provider/hidden-agent-run.ts";

export interface GuideIntent {
	/** The chat's requests, oldest first, each trimmed. */
	readonly requests: ReadonlyArray<string>;
	/** The agent's last reply, which usually summarizes what it did. */
	readonly lastReply: string | null;
	readonly pullRequest: {
		readonly title: string;
		readonly body: string;
		readonly openComments: ReadonlyArray<string>;
	} | null;
}

const MAX_REQUESTS = 12;
const REQUEST_LIMIT = 600;
const REPLY_LIMIT = 1_200;
const BODY_LIMIT = 4_000;
const COMMENT_LIMIT = 300;
const MAX_COMMENTS = 10;

const textOf = (contentJson: string): string | null => {
	try {
		return (
			textFromMessageContent(
				JSON.parse(contentJson) as MessageContent,
			)?.trim() || null
		);
	} catch {
		return null;
	}
};

/** The first request and the latest ones: the goal, then how it evolved. */
const keepEnds = <A>(items: ReadonlyArray<A>, max: number): ReadonlyArray<A> =>
	items.length <= max ? items : [items[0] as A, ...items.slice(-(max - 1))];

export const readSessionIntent = (
	sql: SqlClient.SqlClient,
	sessionId: SessionId,
) =>
	Effect.gen(function* () {
		const rows = yield* sql<{
			readonly role: string;
			readonly content_json: string;
		}>`
			SELECT role, content_json FROM messages
			WHERE session_id = ${sessionId} AND role IN ('user', 'assistant')
			ORDER BY sequence ASC`;
		const requests = rows
			.filter((row) => row.role === "user")
			.flatMap((row) => {
				const text = textOf(row.content_json);
				return text === null ? [] : [limitHeadTail(text, REQUEST_LIMIT)];
			});
		const lastAssistant = [...rows]
			.reverse()
			.find((row) => row.role === "assistant");
		const reply =
			lastAssistant === undefined ? null : textOf(lastAssistant.content_json);
		return {
			requests: keepEnds(requests, MAX_REQUESTS),
			lastReply: reply === null ? null : limitHeadTail(reply, REPLY_LIMIT),
		};
	});

export const pullRequestIntent = (
	details: GitPrDetails,
): GuideIntent["pullRequest"] =>
	details.state === "none"
		? null
		: {
				title: details.title,
				body: limitHeadTail(details.body, BODY_LIMIT),
				openComments: details.comments
					.filter(
						(comment) =>
							comment.isResolved !== true && comment.isOutdated !== true,
					)
					.slice(-MAX_COMMENTS)
					.map((comment) =>
						limitHeadTail(
							`${comment.path ?? "PR"}${comment.line ? `:${comment.line}` : ""}: ${comment.body}`,
							COMMENT_LIMIT,
						),
					),
			};
