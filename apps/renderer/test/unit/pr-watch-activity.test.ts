import { expect, test } from "vitest";
import { createPrWatchActivity } from "../../src/lib/pr-watch-activity.ts";

test("a resumed generation can start before the previous repair finishes", () => {
	const running = createPrWatchActivity();
	const old = { id: "watch", generation: undefined };
	const next = { id: "watch", generation: "resumed" };
	const finishOld = running.begin(old);
	expect(running.has(old)).toBe(true);
	expect(running.has(next)).toBe(false);
	const finishNext = running.begin(next);
	finishOld();
	expect(running.has(next)).toBe(true);
	finishNext();
	expect(running.has(next)).toBe(false);
});
