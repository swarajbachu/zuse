import { describe, expect, it } from "vitest";
import { createAtomStore } from "../../src/state/atom-store.ts";

describe("application atom stores", () => {
	it("retain state while no component is subscribed", async () => {
		const store = createAtomStore(() => ({ count: 0 }));
		store.setState({ count: 1 });

		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(store.getState().count).toBe(1);
	});

	it("notifies once with the previous state for one write", () => {
		const store = createAtomStore(() => ({ count: 0, label: "ready" }));
		const observed: Array<readonly [number, number]> = [];
		const unsubscribe = store.subscribe((state, previous) => {
			observed.push([previous.count, state.count]);
		});

		store.setState((state) => ({ count: state.count + 1 }));
		unsubscribe();

		expect(observed).toEqual([[0, 1]]);
		expect(store.getState()).toEqual({ count: 1, label: "ready" });
	});
});
