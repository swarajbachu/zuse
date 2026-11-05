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
import {
	ArchivedTranscriptReads,
	type ArchivedTranscriptWindow,
} from "./archived-transcript-reads.ts";
import type { ClientBus } from "./client-bus.ts";
import type { CloudControlClient } from "./cloud-control-client.ts";
import {
	openCloudTranscriptCheckpointWithSize,
	openCloudTranscriptPageWithSize,
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
	reads?: ArchivedTranscriptReads,
): Promise<Message | null> {
	const read = (
		key: string,
		load: (signal?: AbortSignal) => Promise<ArchivedTranscriptWindow | null>,
	) => (reads ? reads.read(key, load, signal) : load(signal));
	const readHead = () =>
		read("head", async (signal) => {
			const result = await Effect.runPromise(
				control["cloud.transcript.get"]({
					workspaceId: ref.environmentId,
					sessionId: ref.sessionId,
				}),
				{ signal },
			);
			if (result.checkpoint === null) return null;
			const { payload: opened, decodedBytes } =
				await openCloudTranscriptCheckpointWithSize(ref, result.checkpoint);
			return {
				cursor: opened.cursor,
				beforeSequence: null,
				cacheBytes: decodedBytes * 2,
				messages: opened.projection.messages,
				olderMessageSequence: opened.projection.olderMessageSequence ?? null,
			};
		});
	const readPage = (
		cursor: ArchivedTranscriptWindow["cursor"],
		pageBefore: number,
	) =>
		read(
			JSON.stringify([cursor.epoch, cursor.version, pageBefore]),
			async (signal) => {
				const next = await Effect.runPromise(
					control["cloud.transcript.messages.page"]({
						workspaceId: ref.environmentId,
						sessionId: ref.sessionId,
						cursor: cursor,
						beforeSequence: pageBefore,
					}),
					{ signal },
				);
				if (next.page === null) return null;
				const { page: opened, decodedBytes } =
					await openCloudTranscriptPageWithSize(
						ref,
						cursor,
						pageBefore,
						next.page,
					);
				if (
					opened.olderMessageSequence !== null &&
					opened.olderMessageSequence >= pageBefore
				)
					throw new Error("History page did not advance");
				return {
					...opened,
					cursor,
					beforeSequence: pageBefore,
					cacheBytes: decodedBytes * 2,
				};
			},
		);
	const known = reads?.locate(messageId);
	if (known) {
		const page = await (known.beforeSequence === null
			? readHead()
			: readPage(known.cursor, known.beforeSequence));
		return page?.messages.find((message) => message.id === messageId) ?? null;
	}
	const head = await readHead();
	if (head === null) return null;
	let messages = head.messages;
	let before = head.olderMessageSequence;

	while (true) {
		signal?.throwIfAborted();
		const found = messages.find((message) => message.id === messageId);
		if (found) return found;
		if (before === null) return null;
		const page = await readPage(head.cursor, before);
		if (page === null) return null;
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
export const makeSessionMessageDetailLoader = <
	Client extends DetailClient,
>(options: {
	getBus: () => ClientBus<Client>;
	namespace: (ref: SessionRef) => unknown;
	readArchived: (
		ref: SessionRef,
		id: MessageId,
		signal?: AbortSignal,
		reads?: ArchivedTranscriptReads,
	) => Promise<Message | null>;
}) => {
	const archives = new Map<string, ArchivedTranscriptReads>();
	return async (
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
			bus.snapshot(key).connection !== "revoked" &&
			bus.snapshot(key).connection !== "blocked-auth" &&
			bus.snapshot(key).generation === generation &&
			bus.snapshot(key).cursor?.epoch === epoch &&
			bus
				.snapshot(key)
				.data?.messages.some(
					(message) =>
						message.id === id && detailRevision(message) === revision,
				) === true;
		if (!current())
			throw new Error("The conversation changed while loading details");
		const client = bus.client(ref.environmentId);
		let message: Message | null;
		if (client === null) {
			for (const [key, reader] of archives)
				if (!reader.current()) {
					reader.clear();
					archives.delete(key);
				}
			const archiveKey = JSON.stringify([ref.environmentId, ref.sessionId]);
			let reader = archives.get(archiveKey);
			if (!reader && archives.size >= 4) {
				const idle = [...archives].find(([, reader]) => !reader.busy);
				if (idle) {
					idle[1].clear();
					archives.delete(idle[0]);
				}
			}
			if (!reader && archives.size < 4) {
				const version = before.cursor?.version;
				reader = new ArchivedTranscriptReads(
					() =>
						options.getBus() === bus &&
						options.namespace(ref) === namespace &&
						bus.snapshot(key).data !== null &&
						bus.snapshot(key).connection !== "revoked" &&
						bus.snapshot(key).connection !== "blocked-auth" &&
						bus.snapshot(key).generation === generation &&
						bus.snapshot(key).cursor?.epoch === epoch &&
						bus.snapshot(key).cursor?.version === version,
					() => {
						if (archives.get(archiveKey) === reader)
							archives.delete(archiveKey);
					},
				);
				archives.set(archiveKey, reader);
			}

			const release = reader?.retain();
			try {
				message = await options.readArchived(ref, id, signal, reader);
			} finally {
				release?.();
			}
		} else {
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
