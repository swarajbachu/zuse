import { SESSION_MESSAGE_DETAIL_CHUNK_BYTES } from "@zuse/contracts";
import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { makeSessionMessageDetailReader } from "../../src/provider/session-message-details.ts";

test("reads a large body once and slices bounded chunks without repeating database scans", async () => {
	const content = new TextEncoder().encode("界".repeat(100_000));
	const read = vi.fn(() =>
		Effect.succeed({
			id: "message",
			role: "assistant",
			created_at: "2026-01-01",
			content,
		}),
	);
	const reader = makeSessionMessageDetailReader(read);
	const chunks: Uint8Array[] = [];
	let offset: number | null = 0;
	while (offset !== null) {
		const chunk: Effect.Success<ReturnType<typeof reader>> =
			await Effect.runPromise(reader("session", "message", offset));
		expect(chunk).not.toBeNull();
		if (!chunk) throw new Error("Missing chunk");
		expect(chunk.content.byteLength).toBeLessThanOrEqual(
			SESSION_MESSAGE_DETAIL_CHUNK_BYTES,
		);
		chunks.push(chunk.content);
		offset = chunk.nextOffset;
	}
	expect(read).toHaveBeenCalledTimes(1);
	expect(Buffer.concat(chunks)).toEqual(Buffer.from(content));
	expect(
		await Effect.runPromise(reader("another-session", "message", 10)),
	).toBeNull();
});

test("expires abandoned buffers and bounds retained downloads", async () => {
	let now = 0;
	const read = vi.fn((_sessionId: string, id: string) =>
		Effect.succeed({
			id,
			role: "assistant",
			created_at: "2026-01-01",
			content: new Uint8Array(SESSION_MESSAGE_DETAIL_CHUNK_BYTES + 1),
		}),
	);
	const reader = makeSessionMessageDetailReader(read, () => now);
	for (let index = 0; index < 33; index++)
		await Effect.runPromise(reader("session", String(index), 0));
	expect(await Effect.runPromise(reader("session", "0", 1))).toBeNull();
	now = 60_001;
	expect(await Effect.runPromise(reader("session", "32", 1))).toBeNull();
	expect(read).toHaveBeenCalledTimes(33);
});
