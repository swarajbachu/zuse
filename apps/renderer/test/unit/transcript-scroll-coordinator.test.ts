import { describe, expect, it } from "vitest";

import {
	type TranscriptScrollAdapter,
	TranscriptScrollCoordinator,
} from "../../src/lib/transcript-scroll-coordinator.ts";

function makeFrameScheduler() {
	let nextId = 1;
	const callbacks = new Map<number, () => void>();
	return {
		schedule(callback: () => void) {
			const id = nextId++;
			callbacks.set(id, callback);
			return id;
		},
		cancel(id: number) {
			callbacks.delete(id);
		},
		flush() {
			const queued = [...callbacks.values()];
			callbacks.clear();
			for (const callback of queued) callback();
		},
	};
}

function makeAdapter(
	isAtLiveEdge: TranscriptScrollAdapter["isAtLiveEdge"] = () => true,
) {
	const commands: string[] = [];
	const adapter: TranscriptScrollAdapter = {
		getMeasurementState: () => ({
			data: [0, 1, 2],
			scroll: 300,
			scrollLength: 600,
			positionAtIndex: (index) => [0, 300, 560][index],
			sizeAtIndex: (index) => [240, 200, 600][index],
		}),
		isAtLiveEdge,
		scrollToEnd: ({ animated }) => {
			commands.push(`end:${animated}`);
		},
		scrollToIndex: ({ index, viewOffset, animated }) => {
			commands.push(`index:${index}:${viewOffset}:${animated}`);
		},
		scrollToOffset: ({ offset, animated }) => {
			commands.push(`offset:${offset}:${animated}`);
		},
	};
	return { adapter, commands };
}

describe("transcript scroll coordinator", () => {
	it("follows when the restored meaningful turn is also the live edge", () => {
		const coordinator = new TranscriptScrollCoordinator();
		coordinator.initialize({ atReadingPosition: true, isAtEnd: true });
		expect(coordinator.getSnapshot()).toEqual({
			mode: "following",
			isAtEnd: true,
		});
	});

	it("coalesces streaming growth to one follow write per frame", () => {
		const frames = makeFrameScheduler();
		const { adapter, commands } = makeAdapter();
		const coordinator = new TranscriptScrollCoordinator({
			scheduleFrame: frames.schedule,
			cancelFrame: frames.cancel,
		});
		coordinator.attach(adapter);
		coordinator.initialize({ atReadingPosition: false });

		for (let update = 0; update < 2_000; update += 1) {
			coordinator.contentChanged();
		}
		frames.flush();

		expect(commands).toEqual(["end:false"]);
	});

	it("lets reader intent cancel a pending follow before it moves", () => {
		const frames = makeFrameScheduler();
		const { adapter, commands } = makeAdapter();
		const coordinator = new TranscriptScrollCoordinator({
			scheduleFrame: frames.schedule,
			cancelFrame: frames.cancel,
		});
		coordinator.attach(adapter);
		coordinator.initialize({ atReadingPosition: false });
		coordinator.contentChanged();

		coordinator.readerTookControl();
		frames.flush();

		expect(coordinator.getSnapshot().mode).toBe("detached");
		expect(commands).toEqual([]);
	});

	it("anchors a new turn, then reveals only the newly overflowing tail", () => {
		const frames = makeFrameScheduler();
		const { adapter, commands } = makeAdapter();
		const coordinator = new TranscriptScrollCoordinator({
			scheduleFrame: frames.schedule,
			cancelFrame: frames.cancel,
		});
		coordinator.attach(adapter);

		coordinator.prepareNewTurn(1, 16);
		coordinator.positionAnchoredTurn({ animated: true });
		frames.flush();
		coordinator.contentChanged();
		frames.flush();

		expect(coordinator.getSnapshot().mode).toBe("anchoring-turn");
		expect(commands).toEqual([
			"index:1:16:true",
			// Last row ends at 1160; the 584px usable viewport needs offset 576.
			"offset:576:false",
		]);
	});

	it("keeps turn jumps detached and follows only after the latest jump settles", async () => {
		const frames = makeFrameScheduler();
		let atLiveEdge = false;
		const { adapter, commands } = makeAdapter(() => atLiveEdge);
		const coordinator = new TranscriptScrollCoordinator({
			scheduleFrame: frames.schedule,
			cancelFrame: frames.cancel,
		});
		coordinator.attach(adapter);

		coordinator.jumpToTurn(1, { viewportOffset: -80, animated: true });
		frames.flush();
		await Promise.resolve();
		expect(coordinator.getSnapshot().mode).toBe("detached");

		atLiveEdge = true;
		coordinator.jumpToLatest({ animated: true });
		frames.flush();
		expect(coordinator.getSnapshot().mode).toBe("navigating");
		await Promise.resolve();
		expect(coordinator.getSnapshot().mode).toBe("following");
		expect(commands).toEqual(["index:1:-80:true", "end:true"]);
	});

	it("restores a semantic turn without animation and stays detached", async () => {
		const frames = makeFrameScheduler();
		const { adapter, commands } = makeAdapter(() => false);
		const coordinator = new TranscriptScrollCoordinator({
			scheduleFrame: frames.schedule,
			cancelFrame: frames.cancel,
		});
		coordinator.attach(adapter);

		coordinator.jumpToTurn(1, { viewportOffset: -120, animated: false });
		frames.flush();
		await Promise.resolve();

		expect(coordinator.getSnapshot().mode).toBe("detached");
		expect(commands).toEqual(["index:1:-120:false"]);
	});

	it("retries a turn jump after transient measurement rejection", async () => {
		const frames = makeFrameScheduler();
		const harness = makeAdapter(() => false);
		const { commands } = harness;
		let attempts = 0;
		const adapter: TranscriptScrollAdapter = {
			...harness.adapter,
			scrollToIndex: ({ index, viewOffset, animated }) => {
				attempts += 1;
				commands.push(`index:${index}:${viewOffset}:${animated}`);
				return attempts < 3
					? Promise.reject(new Error("measurement changed"))
					: Promise.resolve();
			},
		};
		const coordinator = new TranscriptScrollCoordinator({
			scheduleFrame: frames.schedule,
			cancelFrame: frames.cancel,
		});
		coordinator.attach(adapter);

		coordinator.jumpToTurn(1, { viewportOffset: -80, animated: true });
		frames.flush();
		await Promise.resolve();
		await Promise.resolve();
		frames.flush();
		await Promise.resolve();
		await Promise.resolve();
		frames.flush();
		await Promise.resolve();

		expect(commands).toEqual([
			"index:1:-80:true",
			"index:1:-80:false",
			"index:1:-80:false",
		]);
		expect(coordinator.getSnapshot().mode).toBe("detached");
	});

	it("resumes following when reader navigation reaches the live edge", () => {
		const frames = makeFrameScheduler();
		const { adapter } = makeAdapter();
		const coordinator = new TranscriptScrollCoordinator({
			scheduleFrame: frames.schedule,
			cancelFrame: frames.cancel,
		});
		coordinator.attach(adapter);
		coordinator.jumpToTurn(1, { viewportOffset: 0, animated: false });
		frames.flush();

		coordinator.readerTookControl("scroll");
		coordinator.scrolled({ isAtEnd: true });

		expect(coordinator.getSnapshot()).toEqual({
			mode: "following",
			isAtEnd: true,
		});
	});

	it("does not resume from selection or focus intent at the live edge", () => {
		const frames = makeFrameScheduler();
		const { adapter } = makeAdapter();
		const coordinator = new TranscriptScrollCoordinator({
			scheduleFrame: frames.schedule,
			cancelFrame: frames.cancel,
		});
		coordinator.attach(adapter);
		coordinator.initialize({ atReadingPosition: false });

		coordinator.readerTookControl();
		coordinator.scrolled({ isAtEnd: true });

		expect(coordinator.getSnapshot().mode).toBe("detached");
	});

	it("rechecks the live edge after a latest jump when content grows mid-scroll", async () => {
		const frames = makeFrameScheduler();
		let checks = 0;
		const { adapter, commands } = makeAdapter(() => {
			checks += 1;
			return checks >= 2;
		});
		const coordinator = new TranscriptScrollCoordinator({
			scheduleFrame: frames.schedule,
			cancelFrame: frames.cancel,
		});
		coordinator.attach(adapter);
		coordinator.jumpToLatest({ animated: true });

		frames.flush();
		await Promise.resolve();
		expect(coordinator.getSnapshot().mode).toBe("navigating");
		frames.flush();
		await Promise.resolve();

		expect(commands).toEqual(["end:true", "end:false"]);
		expect(coordinator.getSnapshot().mode).toBe("following");
	});
});
