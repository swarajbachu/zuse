import {
	Chat,
	ChatId,
	CloudTranscriptCheckpointPayload,
	EnvironmentId,
	Folder,
	FolderId,
	QueueState,
	Session,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import {
	bytesToBase64Url,
	cloudTranscriptAdditionalData,
	encryptCloudTranscript,
	sha256Base64Url,
} from "@zuse/utils/cloud-transcript-crypto";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { openCloudTranscriptCheckpoint } from "../../src/cloud-transcript.ts";

const ref = {
	environmentId: EnvironmentId.make("workspace"),
	sessionId: SessionId.make("session"),
};
const folder = Folder.make({
	id: FolderId.make("remote-checkout"),
	path: "/workspace/repo",
	name: "repo",
	addedAt: new Date(0),
});
const chat = Chat.make({
	id: ChatId.make("chat"),
	projectId: folder.id,
	title: "Shared chat",
	worktreeId: null,
	activeSessionId: ref.sessionId,
	originSessionId: null,
	archivedAt: null,
	lastMessageAt: null,
	lastReadAt: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
});
const session = Session.make({
	id: ref.sessionId,
	projectId: folder.id,
	chatId: chat.id,
	title: "Session",
	providerId: "codex",
	model: "test",
	status: "idle",
	archivedAt: null,
	providerThread: null,
	runtimeMode: "approval-required",
	worktreeId: null,
	forkedFromSessionId: null,
	forkedFromMessageId: null,
	permissionMode: "default",
	toolSearch: false,
	createdAt: new Date(0),
	updatedAt: new Date(0),
});
const context = { session, chat, folder };

const checkpoint = async (
	value?: CloudTranscriptCheckpointPayload["context"],
	mutate?: (value: Record<string, unknown>) => void,
) => {
	const cursor = { epoch: "epoch", version: 4 };
	const transcriptKey = bytesToBase64Url(new Uint8Array(32).fill(7));
	const payload = CloudTranscriptCheckpointPayload.make({
		schemaVersion: 1,
		workspaceId: ref.environmentId,
		sessionId: ref.sessionId,
		cursor,
		context: value,
		projection: SessionTimelineProjection.make({
			messages: [],
			status: "idle",
			activeTurn: null,
			turnCount: 0,
			queue: QueueState.make({ items: [], paused: false }),
			permissionMode: "default",
			runtimeMode: "approval-required",
		}),
	});
	const encoded = Schema.encodeSync(CloudTranscriptCheckpointPayload)(payload);
	mutate?.(encoded);
	const plaintext = new TextEncoder().encode(JSON.stringify(encoded));
	const ciphertext = await encryptCloudTranscript({
		encodedKey: transcriptKey,
		additionalData: cloudTranscriptAdditionalData({
			workspaceId: ref.environmentId,
			sessionId: ref.sessionId,
			...cursor,
			schemaVersion: 1,
		}),
		plaintext,
	});
	return {
		transcriptKey,
		ciphertext,
		metadata: {
			workspaceId: ref.environmentId,
			sessionId: ref.sessionId,
			runtimeGeneration: 1,
			cursor,
			objectKey: "checkpoint",
			ciphertextSha256: await sha256Base64Url(ciphertext),
			ciphertextBytes: ciphertext.length,
			createdAt: 0,
		},
	};
};

it("opens existing checkpoints without context and preserves the original encryption binding", async () => {
	const payload = await openCloudTranscriptCheckpoint(ref, await checkpoint());
	expect(payload.context).toBeUndefined();
	expect(payload.cursor).toEqual({ epoch: "epoch", version: 4 });
});

it("recovers authenticated session and checkout identities without a runtime connection", async () => {
	const payload = await openCloudTranscriptCheckpoint(
		ref,
		await checkpoint(context),
	);
	expect(payload.context).toEqual(context);
});

it.each([
	{
		...context,
		session: Session.make({ ...session, id: SessionId.make("other") }),
	},
	{
		...context,
		session: Session.make({ ...session, chatId: ChatId.make("other") }),
	},
	{
		...context,
		session: Session.make({ ...session, projectId: FolderId.make("other") }),
	},
	{
		...context,
		chat: Chat.make({ ...chat, projectId: FolderId.make("other") }),
	},
])("rejects internally inconsistent encrypted context", async (value) => {
	await expect(
		openCloudTranscriptCheckpoint(ref, await checkpoint(value)),
	).rejects.toThrow("context mismatch");
});

const legacy = (value: Record<string, unknown>) => {
	const context = value.context as { session: Record<string, unknown> };
	const projection = value.projection as Record<string, unknown>;
	delete context.session.providerThread;
	context.session.cursor = "native-thread";
	context.session.resumeStrategy = "codex-thread-id";
	delete projection.activeTurn;
	delete projection.turnCount;
	projection.status = "running";
	projection.currentTurn = { turnId: "legacy-turn", phase: "running" };
};

it("reads legacy encrypted context without fabricating engine ownership", async () => {
	const payload = await openCloudTranscriptCheckpoint(
		ref,
		await checkpoint(context, legacy),
	);
	expect(payload.context?.session.providerThread).toBeNull();
	expect(payload.projection.activeTurn).toBeNull();
	expect(payload.projection.turnCount).toBe(0);
	expect(payload.projection.currentTurn?.turnId).toBe("legacy-turn");
	expect(payload.projection.status).toBe("running");
});

it("still rejects legacy encrypted context with inconsistent identity", async () => {
	await expect(
		openCloudTranscriptCheckpoint(
			ref,
			await checkpoint(context, (value) => {
				legacy(value);
				(value.context as { session: Record<string, unknown> }).session.id =
					"other";
			}),
		),
	).rejects.toThrow("context mismatch");
});

it("preserves current model handoffs and generated UI in encrypted history", async () => {
	const contents = [
		{
			_tag: "model_switch",
			fromProviderId: "codex",
			fromModel: "old",
			toProviderId: "claude",
			toModel: "new",
			context: "handoff",
		},
		{ _tag: "ui_spec", version: 1, spec: "root = Stack([])" },
	];
	const payload = await openCloudTranscriptCheckpoint(
		ref,
		await checkpoint(context, (value) => {
			(value.projection as Record<string, unknown>).messages = contents.map(
				(content, index) => ({
					id: `message-${index}`,
					sessionId: ref.sessionId,
					role: "system",
					content,
					createdAt: new Date(0).toISOString(),
				}),
			);
		}),
	);
	expect(payload.projection.messages.map((message) => message.content)).toEqual(
		contents,
	);
});

const archivedPage = async (
	head: Awaited<ReturnType<typeof checkpoint>>,
	messages: readonly import("@zuse/contracts").Message[],
) => {
	const { CloudTranscriptMessagePagePayload } = await import("@zuse/contracts");
	const payload = CloudTranscriptMessagePagePayload.make({
		schemaVersion: 1,
		workspaceId: ref.environmentId,
		sessionId: ref.sessionId,
		cursor: head.metadata.cursor,
		beforeSequence: 20,
		olderMessageSequence: null,
		messages,
	});
	const ciphertext = await encryptCloudTranscript({
		encodedKey: head.transcriptKey,
		additionalData: cloudTranscriptAdditionalData({
			workspaceId: ref.environmentId,
			sessionId: ref.sessionId,
			...head.metadata.cursor,
			schemaVersion: 1,
			pageBeforeSequence: 20,
		}),
		plaintext: new TextEncoder().encode(
			JSON.stringify(
				Schema.encodeSync(CloudTranscriptMessagePagePayload)(payload),
			),
		),
	});
	return {
		cursor: head.metadata.cursor,
		beforeSequence: 20,
		ciphertext,
		transcriptKey: head.transcriptKey,
		ciphertextSha256: await sha256Base64Url(ciphertext),
	};
};

it("loads deferred details from encrypted older pages without a runtime client", async () => {
	const { Message, MessageId } = await import("@zuse/contracts");
	const { Effect } = await import("effect");
	const { ArchivedTranscriptReads } = await import(
		"../../src/archived-transcript-reads.ts"
	);
	const { readArchivedSessionMessage } = await import(
		"../../src/session-message-detail.ts"
	);
	const head = await checkpoint(undefined, (value) => {
		(value.projection as Record<string, unknown>).olderMessageSequence = 20;
	});
	const full = Message.make({
		id: MessageId.make("archived-result"),
		sessionId: ref.sessionId,
		role: "assistant",
		createdAt: new Date(0),
		content: {
			_tag: "tool_result",
			itemId: "tool" as never,
			output: "complete archived output",
			isError: false,
		},
	});
	const page = await archivedPage(head, [
		full,
		Message.make({ ...full, id: MessageId.make("archived-second") }),
		Message.make({ ...full, id: MessageId.make("archived-third") }),
	]);
	let pages = 0;
	let heads = 0;
	const control = {
		"cloud.transcript.get": () => {
			heads++;
			return Effect.succeed({ checkpoint: head });
		},
		"cloud.transcript.messages.page": (input: { beforeSequence: number }) => {
			pages++;
			expect(input.beforeSequence).toBe(20);
			return Effect.succeed({ page });
		},
	};
	const uncachedIds = [
		full.id,
		MessageId.make("archived-second"),
		MessageId.make("archived-third"),
	];
	await Promise.all(
		uncachedIds.map((id) => readArchivedSessionMessage(control, ref, id)),
	);
	expect({ heads, pages }).toEqual({ heads: 3, pages: 3 });
	const beforeCalls = heads + pages;
	heads = 0;
	pages = 0;
	const reads = new ArchivedTranscriptReads(() => true);
	const ids = [
		full.id,
		MessageId.make("archived-second"),
		MessageId.make("archived-third"),
	];
	const results = await Promise.all(
		ids.map((id) =>
			readArchivedSessionMessage(control, ref, id, undefined, reads),
		),
	);
	expect(results.map((message) => message?.id)).toEqual(ids);
	expect(results[0]).toEqual(full);
	expect(heads).toBe(1);
	if (process.env.ZUSE_TRANSFER_REPORT === "1")
		console.log(
			JSON.stringify({
				archiveCallsBefore: beforeCalls,
				archiveCallsAfter: heads + pages,
				results: results.length,
			}),
		);
	expect(pages).toBe(1);
	// Evict decoded bodies while retaining the small authenticated page index.
	for (let index = 0; index < 3; index++)
		await reads.read(`pressure-${index}`, async () => ({
			cursor: head.metadata.cursor,
			beforeSequence: null,
			cacheBytes: 2 * 1024 * 1024,
			messages: [],
			olderMessageSequence: null,
		}));
	expect(
		await readArchivedSessionMessage(
			control,
			ref,
			MessageId.make("archived-second"),
			undefined,
			reads,
		),
	).toMatchObject({ id: "archived-second" });
	expect(heads).toBe(1);
	expect(pages).toBe(2);
	reads.clear();
});

it("sizes cached archive pages after decompression and indexes oversized bodies without retaining them", async () => {
	const { Message, MessageId } = await import("@zuse/contracts");
	const { Effect } = await import("effect");
	const { ArchivedTranscriptReads } = await import(
		"../../src/archived-transcript-reads.ts"
	);
	const { readArchivedSessionMessage } = await import(
		"../../src/session-message-detail.ts"
	);
	const head = await checkpoint(undefined, (value) => {
		(value.projection as Record<string, unknown>).olderMessageSequence = 20;
	});
	const full = Message.make({
		id: MessageId.make("large-archived-result"),
		sessionId: ref.sessionId,
		role: "assistant",
		createdAt: new Date(0),
		content: {
			_tag: "tool_result",
			itemId: "tool" as never,
			output: "x".repeat(3 * 1024 * 1024),
			isError: false,
		},
	});
	const page = await archivedPage(head, [full]);
	expect(page.ciphertext.length).toBeLessThan(50_000);
	let heads = 0;
	let pages = 0;
	const control = {
		"cloud.transcript.get": () => {
			heads++;
			return Effect.succeed({ checkpoint: head });
		},
		"cloud.transcript.messages.page": () => {
			pages++;
			return Effect.succeed({ page });
		},
	};
	const reads = new ArchivedTranscriptReads(() => true);
	expect(
		await readArchivedSessionMessage(control, ref, full.id, undefined, reads),
	).toEqual(full);
	expect(
		await readArchivedSessionMessage(control, ref, full.id, undefined, reads),
	).toEqual(full);
	expect({ heads, pages }).toEqual({ heads: 1, pages: 2 });
	reads.clear();
});
