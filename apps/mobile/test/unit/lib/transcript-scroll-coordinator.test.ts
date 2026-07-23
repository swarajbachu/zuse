import { describe, expect, test, vi } from "vitest";

import { TranscriptScrollCoordinator } from "../../../src/lib/transcript-scroll-coordinator";

function createHarness() {
	const scrollAnchoredMessageToEnd = vi.fn<() => Promise<void>>(
		async () => undefined,
	);
	const scrollToLatest = vi.fn<() => Promise<void>>(async () => undefined);
	const releaseFreeze = vi.fn();
	const onScrollFailed = vi.fn();
	const coordinator = new TranscriptScrollCoordinator({
		onScrollFailed,
		releaseFreeze,
		scrollAnchoredMessageToEnd,
		scrollToLatest,
	});

	return {
		coordinator,
		onScrollFailed,
		releaseFreeze,
		scrollAnchoredMessageToEnd,
		scrollToLatest,
	};
}

describe("transcript scroll coordinator", () => {
	test("captures the pre-append index and waits for matching anchor readiness", async () => {
		const { coordinator, scrollAnchoredMessageToEnd } = createHarness();

		coordinator.onMessageWillAppend(4);
		expect(coordinator.getSnapshot().anchorIndex).toBe(4);
		expect(scrollAnchoredMessageToEnd).not.toHaveBeenCalled();

		await coordinator.onAnchorReady({ anchorIndex: 3 });
		expect(scrollAnchoredMessageToEnd).not.toHaveBeenCalled();

		await coordinator.onAnchorReady({ anchorIndex: 4 });
		expect(scrollAnchoredMessageToEnd).toHaveBeenCalledOnce();
	});

	test("ignores duplicate readiness events for the same append", async () => {
		const { coordinator, scrollAnchoredMessageToEnd } = createHarness();

		coordinator.onMessageWillAppend(2);
		await Promise.all([
			coordinator.onAnchorReady({ anchorIndex: 2 }),
			coordinator.onAnchorReady({ anchorIndex: 2 }),
		]);

		expect(scrollAnchoredMessageToEnd).toHaveBeenCalledOnce();
	});

	test("failed append clears the anchor and releases a frozen scroll", () => {
		const { coordinator, releaseFreeze } = createHarness();

		coordinator.onMessageWillAppend(6);
		coordinator.onMessageAppendFailed();

		expect(coordinator.getSnapshot().anchorIndex).toBeNull();
		expect(releaseFreeze).toHaveBeenCalledOnce();
	});

	test("failed append restores the reader ownership from before append", () => {
		const { coordinator } = createHarness();
		coordinator.onReaderDetached();
		coordinator.onMessageWillAppend(6);

		coordinator.onMessageAppendFailed();

		expect(coordinator.getSnapshot().readerDetached).toBe(true);
	});

	test("settled turn releases the sent-message runway without detaching", () => {
		const { coordinator, releaseFreeze } = createHarness();
		coordinator.onMessageWillAppend(6);

		coordinator.onTurnSettled();

		expect(coordinator.getSnapshot().anchorIndex).toBeNull();
		expect(coordinator.getSnapshot().readerDetached).toBe(false);
		expect(releaseFreeze).toHaveBeenCalledOnce();
	});

	test("reader interaction clears the anchor and prevents late readiness", async () => {
		const { coordinator, scrollAnchoredMessageToEnd } = createHarness();

		coordinator.onMessageWillAppend(5);
		coordinator.onReaderDetached();
		await coordinator.onAnchorReady({ anchorIndex: 5 });

		expect(coordinator.getSnapshot().anchorIndex).toBeNull();
		expect(coordinator.getSnapshot().readerDetached).toBe(true);
		expect(scrollAnchoredMessageToEnd).not.toHaveBeenCalled();
	});

	test("serializes replacement anchors and releases freeze after a stale failure", async () => {
		let rejectFirst: ((cause: Error) => void) | undefined;
		const firstScroll = new Promise<void>((_resolve, reject) => {
			rejectFirst = reject;
		});
		const { coordinator, releaseFreeze, scrollAnchoredMessageToEnd } =
			createHarness();
		scrollAnchoredMessageToEnd
			.mockImplementationOnce(() => firstScroll)
			.mockResolvedValueOnce(undefined);

		coordinator.onMessageWillAppend(1);
		const firstReady = coordinator.onAnchorReady({ anchorIndex: 1 });
		await Promise.resolve();
		coordinator.onMessageWillAppend(2);
		const secondReady = coordinator.onAnchorReady({ anchorIndex: 2 });

		expect(scrollAnchoredMessageToEnd).toHaveBeenCalledOnce();
		rejectFirst?.(new Error("stale native scroll failed"));
		await firstReady;
		await secondReady;

		expect(scrollAnchoredMessageToEnd).toHaveBeenCalledTimes(2);
		expect(releaseFreeze).toHaveBeenCalledTimes(2);
	});

	test("new submission and explicit jump resume live following", () => {
		const { coordinator } = createHarness();
		coordinator.onReaderDetached();

		coordinator.onFollowingRequested();
		expect(coordinator.getSnapshot().readerDetached).toBe(false);

		coordinator.onReaderDetached();
		coordinator.requestJump();
		expect(coordinator.getSnapshot().readerDetached).toBe(false);
	});

	test("jump clears the anchor and scrolls once only after the render commits", async () => {
		const { coordinator, scrollToLatest } = createHarness();

		coordinator.onMessageWillAppend(7);
		coordinator.requestJump();
		const requestId = coordinator.getSnapshot().pendingJumpRequestId;

		expect(coordinator.getSnapshot().anchorIndex).toBeNull();
		expect(requestId).not.toBeNull();
		expect(scrollToLatest).not.toHaveBeenCalled();

		await coordinator.commitPendingJump(requestId);
		await coordinator.commitPendingJump(requestId);

		expect(scrollToLatest).toHaveBeenCalledOnce();
		expect(coordinator.getSnapshot().pendingJumpRequestId).toBeNull();
	});

	test("failed jump returns ownership to the detached reader state", async () => {
		const { coordinator, onScrollFailed } = createHarness();
		coordinator.updateActions({
			scrollToLatest: vi.fn(async () => {
				throw new Error("native scroll failed");
			}),
		});

		coordinator.requestJump();
		await coordinator.commitPendingJump(
			coordinator.getSnapshot().pendingJumpRequestId,
		);

		expect(onScrollFailed).toHaveBeenCalledOnce();
		expect(coordinator.getSnapshot().readerDetached).toBe(true);
	});

	test("retries one failed anchor scroll before exposing recovery", async () => {
		const { coordinator, onScrollFailed, scrollAnchoredMessageToEnd } =
			createHarness();
		scrollAnchoredMessageToEnd.mockRejectedValue(
			new Error("native scroll failed"),
		);
		coordinator.onMessageWillAppend(3);

		await coordinator.onAnchorReady({ anchorIndex: 3 });

		expect(scrollAnchoredMessageToEnd).toHaveBeenCalledTimes(2);
		expect(coordinator.getSnapshot().anchorIndex).toBeNull();
		expect(coordinator.getSnapshot().readerDetached).toBe(true);
		expect(onScrollFailed).toHaveBeenCalledOnce();
	});
});
