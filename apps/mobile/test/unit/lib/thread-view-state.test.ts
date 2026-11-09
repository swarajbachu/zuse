import { describe, expect, it } from "vitest";

import {
	readThreadViewState,
	restoredThreadTurnIndex,
	writeThreadViewState,
} from "../../../src/lib/thread-view-state";

describe("thread view state", () => {
	it("retains independent reader positions per thread", () => {
		writeThreadViewState("planning", {
			mode: "detached",
			offsetY: 420,
			distanceFromBottom: 900,
		});
		writeThreadViewState("build", {
			mode: "following",
			offsetY: 100,
			distanceFromBottom: 0,
		});

		expect(readThreadViewState("planning")).toMatchObject({ offsetY: 420 });
		expect(readThreadViewState("build")).toMatchObject({
			mode: "following",
		});
	});
});

it("resolves saved turns after prepending history without loading every older page", () => {
	const saved = {
		mode: "detached" as const,
		offsetY: 900,
		distanceFromBottom: 100,
		anchorTurnId: "saved",
	};
	expect(restoredThreadTurnIndex(saved, [{ id: "recent" }])).toBe(-1);
	expect(
		restoredThreadTurnIndex(saved, [
			{ id: "older" },
			{ id: "saved" },
			{ id: "recent" },
		]),
	).toBe(1);
	writeThreadViewState("anchored", saved);
	expect(readThreadViewState("anchored")?.anchorTurnId).toBe("saved");
});
it("does not infer missing or following anchors from pixel offsets", () => {
	expect(
		restoredThreadTurnIndex(
			{ mode: "detached", offsetY: 900, distanceFromBottom: 100 },
			[{ id: "recent" }],
		),
	).toBe(-1);
	expect(
		restoredThreadTurnIndex(
			{
				mode: "following",
				offsetY: 900,
				distanceFromBottom: 100,
				anchorTurnId: "recent",
			},
			[{ id: "recent" }],
		),
	).toBe(-1);
});
