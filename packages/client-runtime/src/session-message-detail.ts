import {
	Message,
	MessageContent,
	type MessageId,
	SESSION_MESSAGE_DETAIL_CHUNK_BYTES,
	SESSION_MESSAGE_DETAIL_MAX_BYTES,
	type SessionMessageDetailChunk,
	type SessionTimelineProjection,
} from "@zuse/contracts";
import { Effect, Schema } from "effect";
import type { ClientBus } from "./client-bus.ts";
import type { CloudControlClient } from "./cloud-control-client.ts";
import {
	openCloudTranscriptCheckpoint,
	openCloudTranscriptPage,
} from "./cloud-transcript.ts";
import { fnv1a } from "./fnv1a.ts";
import { makeResourceKey, type SessionRef } from "./resource-ref.ts";

/** Paused workspaces read encrypted storage; expanding a result never wakes compute. */
export async function readArchivedSessionMessage(
	control: {
		[K in "cloud.transcript.get" | "cloud.transcript.messages.page"]: (
			...args: Parameters<CloudControlClient[K]>
		) => Effect.Effect<
			Effect.Success<ReturnType<CloudControlClient[K]>>,
			unknown
		>;
	},
	ref: SessionRef,
	messageId: MessageId,
	signal?: AbortSignal,
): Promise<Message | null> {
	const result = await Effect.runPromise(
		control["cloud.transcript.get"]({
			workspaceId: ref.environmentId,
			sessionId: ref.sessionId,
		}),
		{ signal },
	);
	if (result.checkpoint === null) return null;
	const head = await openCloudTranscriptCheckpoint(ref, result.checkpoint);
	let messages = head.projection.messages;
	let before = head.projection.olderMessageSequence ?? null;
	while (true) {
		signal?.throwIfAborted();
		const found = messages.find((message) => message.id === messageId);
		if (found) return found;
		if (before === null) return null;
		const next = await Effect.runPromise(
			control["cloud.transcript.messages.page"]({
				workspaceId: ref.environmentId,
				sessionId: ref.sessionId,
				cursor: head.cursor,
				beforeSequence: before,
			}),
			{ signal },
		);
		if (next.page === null) return null;
		const page = await openCloudTranscriptPage(
			ref,
			head.cursor,
			before,
			next.page,
		);
		if (
			page.olderMessageSequence !== null &&
			page.olderMessageSequence >= before
		)
			throw new Error("History page did not advance");
		messages = page.messages;
		before = page.olderMessageSequence;
	}
}

const detailRevision = (message: Message | undefined) =>
	message?.content._tag === "tool_result"
		? message.content.outputDeferred
		: undefined;

type DetailClient = {
	"session.messages.page": (input: {
		sessionId: SessionRef["sessionId"];
		messageId?: MessageId;
		detailOffset?: number;
	}) => Effect.Effect<
		{
			messages: readonly Message[];
			detailChunk?: SessionMessageDetailChunk | null;
		},
		unknown
	>;
};

/** Detail stays in the expanded view, separate from canonical cursors and caches. */
export const makeSessionMessageDetailLoader =
	<Client extends DetailClient>(options: {
		getBus: () => ClientBus<Client>;
		namespace: (ref: SessionRef) => unknown;
		readArchived: (
			ref: SessionRef,
			id: MessageId,
			signal?: AbortSignal,
		) => Promise<Message | null>;
	}) =>
	async (
		ref: SessionRef,
		id: MessageId,
		signal?: AbortSignal,
	): Promise<Message> => {
		const bus = options.getBus();
		const key = makeResourceKey<SessionTimelineProjection>(
			"session-timeline",
			ref,
		);
		signal?.throwIfAborted();
		const before = bus.snapshot(key);
		const generation = before.generation;
		const epoch = before.cursor?.epoch;
		const namespace = options.namespace(ref);
		const revision = detailRevision(
			before.data?.messages.find((message) => message.id === id),
		);
		const current = () =>
			options.getBus() === bus &&
			options.namespace(ref) === namespace &&
			bus.snapshot(key).generation === generation &&
			bus.snapshot(key).cursor?.epoch === epoch &&
			bus
				.snapshot(key)
				.data?.messages.some(
					(message) =>
						message.id === id && detailRevision(message) === revision,
				) === true;
		const client = bus.client(ref.environmentId);
		let message: Message | null;
		if (client === null) message = await options.readArchived(ref, id, signal);
		else {
			let offset = 0;
			let restarts = 0;
			let buffer: Uint8Array | null = null;
			let metadata: SessionMessageDetailChunk | null = null;
			message = null;
			while (true) {
				signal?.throwIfAborted();
				if (!current())
					throw new Error("The conversation changed while loading details");
				const page = await Effect.runPromise(
					client["session.messages.page"]({
						sessionId: ref.sessionId,
						messageId: id,
						detailOffset: offset,
					}),
					{ signal },
				);
				if (page.detailChunk === undefined) {
					message = page.messages.find((value) => value.id === id) ?? null;
					break;
				}
				const chunk = page.detailChunk;
				if (chunk === null) {
					if (offset > 0 && restarts++ === 0) {
						offset = 0;
						buffer = null;
						metadata = null;
						continue;
					}
					break;
				}
				if (
					chunk.messageId !== id ||
					chunk.sessionId !== ref.sessionId ||
					chunk.offset !== offset ||
					!Number.isSafeInteger(chunk.totalBytes) ||
					chunk.totalBytes <= 0 ||
					chunk.totalBytes > SESSION_MESSAGE_DETAIL_MAX_BYTES ||
					(metadata !== null &&
						(chunk.totalBytes !== metadata.totalBytes ||
							chunk.role !== metadata.role ||
							chunk.createdAt !== metadata.createdAt))
				)
					throw new Error("Invalid tool detail chunk");
				metadata ??= chunk;
				buffer ??= new Uint8Array(chunk.totalBytes);
				const bytes = Uint8Array.from(atob(chunk.contentBase64), (value) =>
					value.charCodeAt(0),
				);
				const next = offset + bytes.byteLength;
				if (
					bytes.byteLength === 0 ||
					bytes.byteLength > SESSION_MESSAGE_DETAIL_CHUNK_BYTES ||
					next > buffer.byteLength ||
					(chunk.nextOffset === null
						? next !== buffer.byteLength
						: chunk.nextOffset !== next)
				)
					throw new Error("Invalid tool detail chunk");
				buffer.set(bytes, offset);
				if (chunk.nextOffset === null) {
					message = Message.make({
						id,
						sessionId: ref.sessionId,
						role: chunk.role,
						createdAt: new Date(chunk.createdAt),
						content: Schema.decodeUnknownSync(MessageContent)(
							JSON.parse(
								new TextDecoder("utf-8", { fatal: true }).decode(buffer),
							),
						),
					});
					break;
				}
				offset = chunk.nextOffset;
			}
		}
		signal?.throwIfAborted();
		if (!current())
			throw new Error("The conversation changed while loading details");
		if (
			message === null ||
			message.id !== id ||
			message.sessionId !== ref.sessionId ||
			(message.content._tag === "tool_result" &&
				message.content.outputDeferred !== undefined)
		)
			throw new Error("Tool details are unavailable");
		if (revision !== undefined) {
			const content = message.content;
			const value =
				content._tag === "tool_result"
					? content.output
					: content._tag === "tool_use"
						? content.input
						: undefined;
			const serialized = JSON.stringify(value);
			if (
				serialized === undefined ||
				`${serialized.length}:${fnv1a(serialized)}` !== revision
			)
				throw new Error("Tool details changed while loading; retry");
		}
		return message;
	};

/** Resolve only omitted fields; both surfaces share cancellation and validation. */
export async function loadDeferredSessionToolDetails(
	load: (
		ref: SessionRef,
		id: MessageId,
		signal?: AbortSignal,
	) => Promise<Message>,
	ref: SessionRef,
	tool: Pick<Message, "id" | "content">,
	result: Pick<Message, "id" | "content"> | undefined,
	signal?: AbortSignal,
) {
	const [fullTool, fullResult] = await Promise.all([
		tool,
		result?.content._tag === "tool_result" &&
		result.content.outputDeferred !== undefined
			? load(ref, result.id, signal)
			: result,
	]);
	signal?.throwIfAborted();
	const toolContent = fullTool.content;
	const resultContent = fullResult?.content;
	if (
		toolContent._tag !== "tool_use" ||
		(resultContent !== undefined && resultContent._tag !== "tool_result")
	)
		throw new Error("Tool details are unavailable");
	return { tool: toolContent, result: resultContent };
}
