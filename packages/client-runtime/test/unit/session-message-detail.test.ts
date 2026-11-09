import {
	Message,
	MessageId,
	SESSION_MESSAGE_DETAIL_CHUNK_BYTES,
	SessionId,
	type SessionMessageDetailChunk,
} from "@zuse/contracts";
import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import type { ClientBus } from "../../src/client-bus.ts";
import { makeSessionMessageDetailLoader } from "../../src/session-message-detail.ts";

const id = MessageId.make("result");
const sessionId = SessionId.make("session");
const ref = { environmentId: "environment" as never, sessionId };
const message = Message.make({
	id,
	sessionId,
	role: "assistant",
	createdAt: new Date(0),
	content: {
		_tag: "tool_result",
		itemId: "tool" as never,
		isError: false,
		output: "complete output",
	},
});
const setup = () => {
	let namespace = "account-a";
	const view = {
		generation: 1,
		connection: "dormant",
		cursor: { epoch: "epoch", version: 1 },
		data: { messages: [message] },
	};
	const read = vi.fn<
		(input: {
			sessionId: typeof sessionId;
			messageId?: typeof id;
			detailOffset?: number;
		}) => Effect.Effect<
			{
				messages: readonly Message[];
				detailChunk?: SessionMessageDetailChunk | null;
			},
			unknown
		>
	>(() => Effect.succeed({ messages: [message] }));
	const client = { "session.messages.page": read };
	let connected = true;
	const bus = {
		snapshot: () => view,
		client: () => (connected ? client : null),
	} as unknown as ClientBus<typeof client>;
	const archived = vi.fn().mockResolvedValue(message);
	return {
		view,
		read,
		archived,
		disconnect: () => {
			connected = false;
		},
		changeAccount: () => {
			namespace = "account-b";
		},
		load: makeSessionMessageDetailLoader({
			getBus: () => bus,
			namespace: () => namespace,
			readArchived: archived,
		}),
	};
};

test("requests one qualified message without fetching a full transcript", async () => {
	const h = setup();
	expect(await h.load(ref, id)).toEqual(message);
	expect(h.read).toHaveBeenCalledWith({
		sessionId,
		messageId: id,
		detailOffset: 0,
	});
	expect(h.archived).not.toHaveBeenCalled();
});

test.each([
	"account",
	"generation",
	"epoch",
])("rejects details after a %s change during a download", async (change) => {
	const h = setup();
	let finish!: (value: { messages: Message[] }) => void;
	h.read.mockReturnValue(
		Effect.promise(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		),
	);
	const pending = h.load(ref, id);
	if (change === "account") h.changeAccount();
	if (change === "generation") h.view.generation++;
	if (change === "epoch") h.view.cursor.epoch = "restored";
	finish({ messages: [message] });
	await expect(pending).rejects.toThrow("conversation changed");
});

test("uses archived encrypted reads without acquiring or waking an offline runtime", async () => {
	const h = setup();
	h.disconnect();
	expect(await h.load(ref, id)).toEqual(message);
	expect(h.read).not.toHaveBeenCalled();
	expect(h.archived).toHaveBeenCalledWith(
		ref,
		id,
		undefined,
		expect.anything(),
	);
});

test("rejects an incorrectly scoped detail response", async () => {
	const h = setup();
	h.read.mockReturnValue(
		Effect.succeed({
			messages: [
				Message.make({
					...message,
					sessionId: SessionId.make("another-session"),
				}),
			],
		}),
	);
	await expect(h.load(ref, id)).rejects.toThrow("unavailable");
});

const chunkResponse = (full: Message, offset: number) => {
	const bytes = new TextEncoder().encode(JSON.stringify(full.content));
	const end = Math.min(
		offset + SESSION_MESSAGE_DETAIL_CHUNK_BYTES,
		bytes.length,
	);
	return {
		messages: [],
		detailChunk: {
			messageId: full.id,
			sessionId: full.sessionId,
			role: full.role,
			createdAt: full.createdAt.toISOString(),
			offset,
			nextOffset: end === bytes.length ? null : end,
			totalBytes: bytes.length,
			contentBase64: Buffer.from(bytes.subarray(offset, end)).toString(
				"base64",
			),
		},
	};
};
test("reassembles bounded chunks across UTF-8 character boundaries without publishing details", async () => {
	const h = setup();
	const full = Message.make({
		...message,
		content: {
			...message.content,
			output: "界🌏".repeat(90000),
		} as Message["content"],
	});
	h.read.mockImplementation(({ detailOffset = 0 }) =>
		Effect.succeed(chunkResponse(full, detailOffset)),
	);
	expect(await h.load(ref, id)).toEqual(full);
	expect(h.read.mock.calls.length).toBeGreaterThan(3);
	expect(h.view.data.messages).toEqual([message]);
});
test.each([
	"scope",
	"offset",
	"total",
	"progress",
])("rejects malformed detail chunks: %s", async (failure) => {
	const h = setup();
	const response = chunkResponse(message, 0);
	if (failure === "scope")
		response.detailChunk.sessionId = SessionId.make("another");
	if (failure === "offset") response.detailChunk.offset = 1;
	if (failure === "total") response.detailChunk.totalBytes = 65 * 1024 * 1024;
	if (failure === "progress") response.detailChunk.nextOffset = 0;
	h.read.mockReturnValue(Effect.succeed(response));
	await expect(h.load(ref, id)).rejects.toThrow("Invalid tool detail chunk");
	expect(h.read).toHaveBeenCalledTimes(1);
});
test("aborts between detail chunks without requesting the remainder", async () => {
	const h = setup();
	const controller = new AbortController();
	h.read.mockImplementation(() => {
		controller.abort();
		return Effect.succeed(chunkResponse(message, 0));
	});
	await expect(h.load(ref, id, controller.signal)).rejects.toThrow();
	expect(h.read).toHaveBeenCalledTimes(1);
});

test("restarts once when a server download buffer was evicted mid-transfer", async () => {
	const h = setup();
	const full = Message.make({
		...message,
		content: {
			...message.content,
			output: "界".repeat(100_000),
		} as Message["content"],
	});
	let evicted = false;
	h.read.mockImplementation(({ detailOffset = 0 }) => {
		if (detailOffset > 0 && !evicted) {
			evicted = true;
			return Effect.succeed({ messages: [], detailChunk: null });
		}
		return Effect.succeed(chunkResponse(full, detailOffset));
	});
	expect(await h.load(ref, id)).toEqual(full);
	expect(
		h.read.mock.calls.filter(([input]) => input.detailOffset === 0),
	).toHaveLength(2);
});

test.each([
	"account",
	"generation",
	"epoch",
	"version",
])("never reuses archived pages after a %s change", async (change) => {
	const h = setup();
	h.disconnect();
	await h.load(ref, id);
	const previous = h.archived.mock.calls[0]?.[3];
	if (change === "account") h.changeAccount();
	if (change === "generation") h.view.generation++;
	if (change === "epoch") h.view.cursor.epoch = "new";
	if (change === "version") h.view.cursor.version++;
	await h.load(ref, id);
	expect(h.archived.mock.calls[1]?.[3]).not.toBe(previous);
	expect(previous.current()).toBe(false);
});
test.each([
	"revoked",
	"blocked-auth",
])("rejects cached archived details when access becomes %s", async (connection) => {
	const h = setup();
	h.disconnect();
	await h.load(ref, id);
	h.view.connection = connection;
	await expect(h.load(ref, id)).rejects.toThrow("conversation changed");
	expect(h.archived).toHaveBeenCalledOnce();
});
test("does not abort active archive walks when a fifth conversation opens", async () => {
	const h = setup();
	h.disconnect();
	const finish: Array<() => void> = [];
	const readers: Array<unknown> = [];
	h.archived.mockImplementation((_ref, _id, _signal, reads) => {
		readers.push(reads);
		return new Promise((resolve) => finish.push(() => resolve(message)));
	});
	const pending = Array.from({ length: 5 }, (_, index) =>
		h.load({ ...ref, environmentId: `environment-${index}` as never }, id),
	);
	expect(readers.slice(0, 4).every((reader) => reader !== undefined)).toBe(
		true,
	);
	expect(readers[4]).toBeUndefined();
	for (const complete of finish) complete();
	await expect(Promise.all(pending)).resolves.toHaveLength(5);
});
