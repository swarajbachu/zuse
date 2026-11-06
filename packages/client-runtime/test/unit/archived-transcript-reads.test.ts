import { Message, MessageId, SessionId } from "@zuse/contracts";
import { afterEach, expect, test, vi } from "vitest";
import {
	ArchivedTranscriptReads,
	type ArchivedTranscriptWindow,
} from "../../src/archived-transcript-reads.ts";

const value = (text = "output"): ArchivedTranscriptWindow => ({
	cursor: { epoch: "epoch", version: 1 },
	beforeSequence: null,
	cacheBytes: text.length * 2 + 1024,
	messages: [
		Message.make({
			id: MessageId.make("result"),
			sessionId: SessionId.make("session"),
			role: "assistant",
			createdAt: new Date(0),
			content: { _tag: "assistant", text },
		}),
	],
	olderMessageSequence: null,
});
afterEach(() => vi.useRealTimers());

test("shares a download and lets the remaining view finish when one view closes", async () => {
	const reads = new ArchivedTranscriptReads(() => true);
	let finish!: (value: ArchivedTranscriptWindow) => void;
	let sharedSignal!: AbortSignal;
	const load = vi.fn((signal: AbortSignal) => {
		sharedSignal = signal;
		return new Promise<ArchivedTranscriptWindow>((resolve) => {
			finish = resolve;
		});
	});
	const first = new AbortController();
	const second = new AbortController();
	const a = reads.read("head", load, first.signal);
	const b = reads.read("head", load, second.signal);
	await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
	first.abort();
	await expect(a).rejects.toThrow();
	expect(sharedSignal.aborted).toBe(false);
	finish(value());
	await expect(b).resolves.toEqual(value());
	expect(await reads.read("head", load)).toEqual(value());
	expect(load).toHaveBeenCalledOnce();
	reads.clear();
});

test("serializes distinct page downloads and cancels queued reads without starting them", async () => {
	const reads = new ArchivedTranscriptReads(() => true);
	let finish!: (value: ArchivedTranscriptWindow) => void;
	const first = reads.read(
		"head",
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const cancelled = new AbortController();
	const load = vi.fn().mockResolvedValue(value());
	const queued = reads.read("page-1", load, cancelled.signal);
	const next = reads.read("page-2", load);
	await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
	expect(load).not.toHaveBeenCalled();
	cancelled.abort();
	await expect(queued).rejects.toThrow();
	finish(value());
	await first;
	await next;
	expect(load).toHaveBeenCalledOnce();
	reads.clear();
});

test("cancels a stalled body when the last view closes and permits retry", async () => {
	const reads = new ArchivedTranscriptReads(() => true);
	const controller = new AbortController();
	let underlying!: AbortSignal;
	const stalled = reads.read(
		"head",
		(signal) =>
			new Promise((_resolve, reject) => {
				underlying = signal;
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			}),
		controller.signal,
	);
	await vi.waitFor(() => expect(underlying).toBeDefined());
	controller.abort();
	await expect(stalled).rejects.toThrow();
	expect(underlying.aborted).toBe(true);
	expect(await reads.read("head", async () => value())).toEqual(value());
	reads.clear();
});

test("expires cached windows and never retains failed downloads", async () => {
	vi.useFakeTimers();
	const reads = new ArchivedTranscriptReads(() => true);
	const load = vi
		.fn()
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue(value());
	await expect(reads.read("head", load)).rejects.toThrow("offline");
	await reads.read("head", load);
	await reads.read("head", load);
	expect(load).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(30_000);
	await reads.read("head", load);
	expect(load).toHaveBeenCalledTimes(3);
	reads.clear();
	expect(vi.getTimerCount()).toBe(0);
});

test("rejects late data after the scope changes and disposes evicted readers permanently", async () => {
	let current = true;
	const reads = new ArchivedTranscriptReads(() => current);
	let finish!: (value: ArchivedTranscriptWindow) => void;
	const pending = reads.read(
		"head",
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
	current = false;
	finish(value());
	await expect(pending).rejects.toThrow("conversation changed");
	reads.clear();
	current = true;
	await expect(reads.read("head", async () => value())).rejects.toThrow(
		"conversation changed",
	);
});

test("bounds cached entries and refuses windows larger than the cache budget", async () => {
	const reads = new ArchivedTranscriptReads(() => true);
	const load = vi.fn().mockResolvedValue(value());
	for (let index = 0; index < 17; index++)
		await reads.read(String(index), load);
	await reads.read("0", load);
	expect(load).toHaveBeenCalledTimes(18);
	const large = vi.fn().mockResolvedValue(value("x".repeat(3 * 1024 * 1024)));
	await reads.read("large", large);
	await reads.read("large", large);
	expect(large).toHaveBeenCalledTimes(2);
	expect(reads.locate(MessageId.make("result"))).toMatchObject({
		beforeSequence: null,
	});
	reads.clear();
});

test("refreshes body recency without extending authorization-cache expiry", async () => {
	vi.useFakeTimers();
	const reads = new ArchivedTranscriptReads(() => true);
	const load = vi.fn().mockResolvedValue(value());
	for (let index = 0; index < 16; index++)
		await reads.read(String(index), load);
	await reads.read("0", load);
	await reads.read("new", load);
	await reads.read("0", load);
	expect(load).toHaveBeenCalledTimes(17);
	await vi.advanceTimersByTimeAsync(30_000);
	expect(reads.locate(MessageId.make("result"))).toBeUndefined();
	await reads.read("0", load);
	expect(load).toHaveBeenCalledTimes(18);
	reads.clear();
});

test("releases an inactive scope after the last cached location expires", async () => {
	vi.useFakeTimers();
	const inactive = vi.fn();
	const reads = new ArchivedTranscriptReads(() => true, inactive);
	const release = reads.retain();
	await reads.read("head", async () => value());
	release();
	expect(inactive).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(30_000);
	expect(inactive).toHaveBeenCalledOnce();
	expect(reads.current()).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
});
