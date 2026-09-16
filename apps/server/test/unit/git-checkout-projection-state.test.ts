import { describe, expect, it } from "vitest";

import {
	GitCheckoutProjectionState,
	gitCheckoutIdentity,
} from "../../src/git/checkout-projection-state.ts";

describe("Git checkout projection state", () => {
	it("keeps arbitrary folder and worktree ids structurally distinct", () => {
		expect(gitCheckoutIdentity("folder:branch", null)).not.toBe(
			gitCheckoutIdentity("folder", "branch:main"),
		);
		expect(gitCheckoutIdentity("folder", null)).not.toBe(
			gitCheckoutIdentity("folder", "main"),
		);
	});

	it("expires idle projection versions and pull-request snapshots together", () => {
		let now = 1_000;
		const state = new GitCheckoutProjectionState<string>({
			idleTtlMs: 100,
			maxEntries: 8,
			now: () => now,
		});
		const checkout = gitCheckoutIdentity("folder", null);

		expect(state.nextProjectionVersion(checkout)).toBe(1);
		state.setPrSnapshot(checkout, { value: "open", nextPollAt: 2_000 });
		expect(state.getPrSnapshot(checkout)?.value).toBe("open");
		expect(state.entryCount).toBe(1);

		now += 101;
		expect(state.entryCount).toBe(0);
		expect(state.getPrSnapshot(checkout)).toBeUndefined();
		expect(state.nextProjectionVersion(checkout)).toBe(1);
	});

	it("evicts the least-recently-used checkout at the hard bound", () => {
		let now = 10;
		const state = new GitCheckoutProjectionState<string>({
			idleTtlMs: 10_000,
			maxEntries: 2,
			now: () => now,
		});
		const first = gitCheckoutIdentity("first", null);
		const second = gitCheckoutIdentity("second", null);
		const third = gitCheckoutIdentity("third", null);

		state.setPrSnapshot(first, { value: "first", nextPollAt: 100 });
		now += 1;
		state.setPrSnapshot(second, { value: "second", nextPollAt: 100 });
		now += 1;
		expect(state.getPrSnapshot(first)?.value).toBe("first");
		now += 1;
		state.setPrSnapshot(third, { value: "third", nextPollAt: 100 });

		expect(state.entryCount).toBe(2);
		expect(state.getPrSnapshot(first)?.value).toBe("first");
		expect(state.getPrSnapshot(second)).toBeUndefined();
		expect(state.getPrSnapshot(third)?.value).toBe("third");
	});

	it("rejects a delayed old PR refresh after a newer refresh commits", async () => {
		const state = new GitCheckoutProjectionState<string>();
		const checkout = gitCheckoutIdentity("folder", null);
		const oldRefresh = state.beginPrRefresh(checkout);
		let finishOld!: () => void;
		const oldDelay = new Promise<void>((resolve) => {
			finishOld = resolve;
		});
		const oldCommit = oldDelay.then(() =>
			state.commitPrRefresh(oldRefresh, {
				value: "stale-before-push",
				nextPollAt: 100,
			}),
		);

		const newRefresh = state.beginPrRefresh(checkout);
		expect(
			state.commitPrRefresh(newRefresh, {
				value: "fresh-after-push",
				nextPollAt: 200,
			}),
		).toBe(true);
		finishOld();

		await expect(oldCommit).resolves.toBe(false);
		expect(state.getPrSnapshot(checkout)?.value).toBe("fresh-after-push");
	});

	it("keeps an older refresh fenced when the newest refresh fails", () => {
		const state = new GitCheckoutProjectionState<string>();
		const checkout = gitCheckoutIdentity("folder", null);
		state.setPrSnapshot(checkout, { value: "baseline", nextPollAt: 100 });
		const oldRefresh = state.beginPrRefresh(checkout);

		// Starting the mutation refresh revokes old commit authority. A failure
		// intentionally leaves that authority claimed until a future retry.
		state.beginPrRefresh(checkout);
		expect(
			state.commitPrRefresh(oldRefresh, {
				value: "late-old-result",
				nextPollAt: 200,
			}),
		).toBe(false);
		expect(state.getPrSnapshot(checkout)?.value).toBe("baseline");
	});
});
