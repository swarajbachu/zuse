import type {
	ResourceDriverContext,
	ResourceDriverUpdate,
} from "@zuse/client-runtime/client-bus";
import {
	initialTerminalResourceState,
	type TerminalResourceState,
} from "@zuse/client-runtime/terminal-resource";
import {
	makeTerminalResourceDriver,
	terminalResourceKey,
} from "@zuse/client-runtime/terminal-resource-driver";
import { EnvironmentId, type PtyEvent, PtyId } from "@zuse/contracts";
import { Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
	makeTerminalFeedChannel,
	makeTerminalFeedLeaseCleanup,
	TerminalFeedRevokedError,
	terminalFeedValue,
} from "~/lib/terminal-feed-channel";

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not reached");
};

describe("mobile terminal feed channel", () => {
	it("isolates output when the selected terminal changes", async () => {
		const channel = makeTerminalFeedChannel();
		channel.commitSelection("terminal-a");
		const feedA = channel.append("terminal-a", "output from A");

		expect(terminalFeedValue(feedA.feed, "terminal-a")).toBe(
			"1\u0000output from A",
		);

		const revoked = expect(feedA.committed).rejects.toBeInstanceOf(
			TerminalFeedRevokedError,
		);
		channel.commitSelection("terminal-b");
		await revoked;
		expect(terminalFeedValue(feedA.feed, "terminal-b")).toBeUndefined();
		expect(() => channel.append("terminal-a", "late output from A")).toThrow(
			TerminalFeedRevokedError,
		);

		const feedB = channel.append("terminal-b", "first output from B");
		expect(terminalFeedValue(feedB.feed, "terminal-b")).toBe(
			"1\u0000first output from B",
		);
	});

	it("coalesces every write published before a native prop commit", async () => {
		const channel = makeTerminalFeedChannel();
		channel.commitSelection("terminal-a");
		let firstCommitted = false;
		const first = channel.append("terminal-a", "first");
		first.committed.then(() => {
			firstCommitted = true;
		});
		const second = channel.append("terminal-a", " second");

		expect(terminalFeedValue(second.feed, "terminal-a")).toBe(
			"2\u0000first second",
		);
		await Promise.resolve();
		expect(firstCommitted).toBe(false);

		expect(channel.acknowledge(second.feed)).toBeNull();
		await expect(first.committed).resolves.toBeUndefined();
		await expect(second.committed).resolves.toBeUndefined();

		const third = channel.append("terminal-a", " third");
		expect(terminalFeedValue(third.feed, "terminal-a")).toBe("3\u0000 third");
	});

	it("retains reset and replay bytes in order until the committed feed is acknowledged", async () => {
		const channel = makeTerminalFeedChannel();
		channel.commitSelection("terminal-a");
		const reset = channel.append("terminal-a", "\u001bc");
		const replay = channel.append("terminal-a", "restored output");

		expect(terminalFeedValue(replay.feed, "terminal-a")).toBe(
			"2\u0000\u001bcrestored output",
		);
		const remaining = channel.acknowledge(reset.feed);
		expect(terminalFeedValue(remaining, "terminal-a")).toBe(
			"2\u0000restored output",
		);
		await expect(reset.committed).resolves.toBeUndefined();
		let replayCommitted = false;
		replay.committed.then(() => {
			replayCommitted = true;
		});
		await Promise.resolve();
		expect(replayCommitted).toBe(false);

		channel.acknowledge(remaining);
		await expect(replay.committed).resolves.toBeUndefined();
	});

	it("fails instead of silently dropping output beyond the retained bound", () => {
		const channel = makeTerminalFeedChannel({ maxQueuedCharacters: 5 });
		channel.commitSelection("terminal-a");
		channel.append("terminal-a", "12345");

		expect(() => channel.append("terminal-a", "6")).toThrow(
			/queue capacity exceeded/,
		);
	});

	it("rejects native commit acknowledgement when the selected surface unmounts", async () => {
		const channel = makeTerminalFeedChannel();
		channel.commitSelection("terminal-a");
		const publication = channel.append("terminal-a", "in flight");

		const revoked = expect(publication.committed).rejects.toBeInstanceOf(
			TerminalFeedRevokedError,
		);
		channel.commitSelection(null);

		await revoked;
		expect(channel.acknowledge(publication.feed)).toBeNull();
	});

	it("revokes a pending feed when its resource lease changes without changing selection", async () => {
		const channel = makeTerminalFeedChannel();
		channel.commitSelection("terminal-a");
		const publication = channel.append("terminal-a", "old lease");
		const revoked = expect(publication.committed).rejects.toBeInstanceOf(
			TerminalFeedRevokedError,
		);

		channel.revoke("terminal-a");
		await revoked;
		const replacement = channel.append("terminal-a", "replacement lease");
		expect(terminalFeedValue(replacement.feed, "terminal-a")).toBe(
			"2\u0000replacement lease",
		);
		channel.acknowledge(replacement.feed);
		await expect(replacement.committed).resolves.toBeUndefined();
	});

	it("does not commit a queued stale feed after the same terminal gets a replacement lease", async () => {
		const channel = makeTerminalFeedChannel();
		channel.commitSelection("terminal-a");
		const stale = channel.append("terminal-a", "replayed bytes");
		const revoked = expect(stale.committed).rejects.toBeInstanceOf(
			TerminalFeedRevokedError,
		);
		const cleanupOrder: string[] = [];
		const oldResourceCleanup = makeTerminalFeedLeaseCleanup({
			channel,
			terminalId: "terminal-a",
			stopResource: () => cleanupOrder.push("resource-stopped"),
			clearFeed: () => cleanupOrder.push("feed-cleared"),
		});

		// React runs the previous passive-effect cleanup before new setup.
		oldResourceCleanup();
		oldResourceCleanup();
		await revoked;
		expect(cleanupOrder).toEqual(["resource-stopped", "feed-cleared"]);
		const replacement = channel.append("terminal-a", "replayed bytes");
		const nativeWrites: string[] = [];
		const commitToNative = (feed: typeof stale.feed) => {
			const value = terminalFeedValue(feed, "terminal-a");
			if (value === undefined) return;
			nativeWrites.push(value.slice(value.indexOf("\u0000") + 1));
			channel.acknowledge(feed);
		};

		// Simulate an old setState publication reaching a later React commit.
		commitToNative(stale.feed);
		let replacementCommitted = false;
		replacement.committed.then(() => {
			replacementCommitted = true;
		});
		await Promise.resolve();
		expect(replacementCommitted).toBe(false);

		commitToNative(replacement.feed);
		await expect(replacement.committed).resolves.toBeUndefined();
		expect(nativeWrites).toEqual(["replayed bytes"]);
		expect(replacement.feed.sequence).toBeGreaterThan(stale.feed.sequence);
	});

	it("does not advance the resource cursor until matching native commit and replays after reselect", async () => {
		const terminalId = PtyId.make("terminal-a");
		const key = terminalResourceKey({
			environmentId: EnvironmentId.make("environment-a"),
			terminalId,
		});
		const initial = initialTerminalResourceState(terminalId, "epoch-a");
		const event: typeof PtyEvent.Type = {
			_tag: "data",
			processEpoch: "epoch-a",
			sequence: 1,
			bytes: "must replay",
		};
		const channel = makeTerminalFeedChannel();
		channel.commitSelection(terminalId);
		type Publication = ReturnType<typeof channel.append>;
		let publication: Publication | null = null;
		const requirePublication = (): Publication => {
			const current: Publication | null = publication;
			if (current === null) throw new Error("Expected pending feed");
			return current;
		};
		const starts: number[] = [];
		const makeDriver = () =>
			makeTerminalResourceDriver({
				sinkFor: () => ({
					reset: async () => undefined,
					write: async (bytes) => {
						publication = channel.append(terminalId, bytes);
						await publication.committed;
					},
					exited: async () => undefined,
				}),
				streamOutput: (_client, _ref, afterSequence) => {
					starts.push(afterSequence);
					return Stream.concat(Stream.succeed(event), Stream.never);
				},
				reportConnectionFailure: () => undefined,
			});
		const updates: ResourceDriverUpdate<TerminalResourceState>[] = [];
		const context = (): ResourceDriverContext<
			unknown,
			TerminalResourceState
		> => ({
			key,
			client: {},
			generation: 1,
			data: initial,
			cursor: { epoch: "epoch-a", version: 0 },
			snapshot: () => null,
			emit: (update) => {
				updates.push(update);
				return true;
			},
			isCurrent: () => true,
		});

		const firstDriver = makeDriver();
		firstDriver.start(context());
		await waitUntil(() => publication !== null);
		expect(updates.some((update) => update.cursor?.version === 1)).toBe(false);

		firstDriver.stop();
		const firstPublication = requirePublication();
		const revoked = expect(firstPublication.committed).rejects.toBeInstanceOf(
			TerminalFeedRevokedError,
		);
		channel.commitSelection("terminal-b");
		await revoked;
		expect(updates.some((update) => update.cursor?.version === 1)).toBe(false);

		publication = null;
		channel.commitSelection(terminalId);
		const secondDriver = makeDriver();
		secondDriver.start(context());
		await waitUntil(() => publication !== null);
		const replayedPublication = requirePublication();
		channel.acknowledge(replayedPublication.feed);
		await replayedPublication.committed;
		await waitUntil(() =>
			updates.some((update) => update.cursor?.version === 1),
		);

		expect(starts).toEqual([0, 0]);
		secondDriver.stop();
	});
});
