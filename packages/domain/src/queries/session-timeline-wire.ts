import { Message, type SessionTimelineFrame } from "@zuse/contracts";
import { fnv1a } from "@zuse/utils/fnv1a";
import { normalizeNativeToolName } from "@zuse/utils/native-tool-name";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

// These results are display-only. Plan, delegation, generated media, and
// structured application-tool results retain their semantic bodies.
const encoder = new TextEncoder();
const detailTools = new Set(["Bash", "Read", "Grep", "Glob"]);

/** Per-reader projection only: durable messages and provider context stay complete. */
export function makeDeferredToolDetailProjector() {
	const tools = new Map<string, string>();
	const rememberTool = (itemId: string, tool: string) => {
		tools.delete(itemId);
		tools.set(itemId, normalizeNativeToolName(tool));
		if (tools.size > 512) {
			const first = tools.keys().next().value;
			if (first !== undefined) tools.delete(first);
		}
	};
	const message = (value: Message): Message => {
		const content = value.content;
		if (content._tag === "tool_use") {
			rememberTool(content.itemId, content.tool);
			return value;
		}
		if (
			content._tag !== "tool_result" ||
			content.outputDeferred !== undefined ||
			typeof content.output !== "string" ||
			!detailTools.has(tools.get(content.itemId) ?? "")
		)
			return value;
		const serialized = JSON.stringify(content.output);
		if (
			serialized === undefined ||
			encoder.encode(serialized).byteLength <= 4096
		)
			return value;
		return Message.make({
			...value,
			content: {
				...content,
				output: content.output.slice(0, 256),
				outputDeferred: `${serialized.length}:${fnv1a(serialized)}`,
			},
		});
	};
	const messages = (values: readonly Message[]) => values.map(message);
	const frame = (value: SessionTimelineFrame): SessionTimelineFrame => {
		if (value.kind === "snapshot") {
			return {
				...value,
				projection: {
					...value.projection,
					messages: messages(value.projection.messages),
				},
			};
		}
		if (value.kind === "snapshot-chunk")
			return { ...value, messages: messages(value.messages) };
		if (value.kind === "event" && value.event._tag === "MessagePersisted")
			return {
				...value,
				event: { ...value.event, message: message(value.event.message) },
			};
		return value;
	};
	return { message, messages, frame, rememberTool };
}

/** Only tool identities cross this query; large stored inputs stay out of JS. */
export const loadDeferredToolDetailProjector = Effect.fn(
	"loadDeferredToolDetailProjector",
)(function* (
	sql: SqlClient.SqlClient,
	sessionId: string,
	beforeSequence = Number.MAX_SAFE_INTEGER,
) {
	const rows = yield* sql<{ itemId: string | null; tool: string | null }>`
		SELECT CASE WHEN json_valid(content_json) THEN json_extract(content_json,'$.itemId') END AS itemId,
			CASE WHEN json_valid(content_json) THEN json_extract(content_json,'$.tool') END AS tool
		FROM (SELECT content_json FROM messages WHERE session_id=${sessionId} AND kind='tool_use' AND sequence<${beforeSequence} ORDER BY sequence DESC LIMIT 512)
	`;
	const projector = makeDeferredToolDetailProjector();
	for (const row of [...rows].reverse())
		if (typeof row.itemId === "string" && typeof row.tool === "string")
			projector.rememberTool(row.itemId, row.tool);
	return projector;
});

/** Read once per detail download; the application bounds transport chunks. */
export const readSessionMessageContent = Effect.fn("readSessionMessageContent")(
	function* (sql: SqlClient.SqlClient, sessionId: string, messageId: string) {
		const rows = yield* sql<{
			id: string;
			role: string;
			created_at: string;
			content: Uint8Array;
		}>`
  SELECT id,role,created_at,CAST(content_json AS BLOB) AS content
  FROM messages WHERE session_id=${sessionId} AND id=${messageId} LIMIT 1
 `;
		return rows[0] ?? null;
	},
);
