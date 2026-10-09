import { readHtmlRenderResult } from "@zuse/client-runtime/html-render";
import type { MessageContent, MessageId, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

export const pinHtmlRenderAttachment = (
	sql: SqlClient.SqlClient,
	sessionId: SessionId,
	messageId: MessageId,
	content: MessageContent,
) =>
	Effect.gen(function* () {
		if (content._tag !== "tool_result" || content.isError) return;
		const visual = readHtmlRenderResult(content.output);
		if (!visual) return;
		// Results never grant access to another session's blobs. The normal
		// message_attachments cascade owns deletion and GC retention.
		yield* sql`INSERT OR IGNORE INTO message_attachments (message_id, attachment_id)
		SELECT ${messageId}, id FROM attachments WHERE id = ${visual.attachmentId}
		AND session_id = ${sessionId} AND mime_type = 'text/html'`.pipe(
			Effect.orDie,
		);
	});
