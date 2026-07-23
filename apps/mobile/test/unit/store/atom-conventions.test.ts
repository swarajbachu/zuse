import { Atom } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vitest";

import {
	appAtomRegistry,
	batchAtomUpdates,
} from "../../../src/store/registry";

describe("atom store conventions", () => {
	it("keepAlive state survives unsubscribing the last watcher", () => {
		const atom = Atom.make({ value: 0 }).pipe(Atom.keepAlive);
		appAtomRegistry.set(atom, { value: 42 });
		const unsubscribe = appAtomRegistry.subscribe(atom, () => {}, {
			immediate: true,
		});
		unsubscribe();
		expect(appAtomRegistry.get(atom)).toEqual({ value: 42 });
	});

	it("per-key family atoms are isolated from writes to other keys", () => {
		const base = Atom.make<Record<string, number>>({}).pipe(Atom.keepAlive);
		const perKey = Atom.family((key: string) =>
			Atom.make((get) => get(base)[key] ?? 0),
		);
		const onA = vi.fn();
		const unsubscribe = appAtomRegistry.subscribe(perKey("a"), onA, {
			immediate: true,
		});
		expect(onA).toHaveBeenCalledTimes(1);

		appAtomRegistry.update(base, (state) => ({ ...state, b: 1 }));
		expect(onA).toHaveBeenCalledTimes(1);

		appAtomRegistry.update(base, (state) => ({ ...state, a: 7 }));
		expect(onA).toHaveBeenCalledTimes(2);
		expect(appAtomRegistry.get(perKey("a"))).toBe(7);
		unsubscribe();
	});

	it("batchAtomUpdates coalesces multi-atom writes into one notification", () => {
		const first = Atom.make(0).pipe(Atom.keepAlive);
		const second = Atom.make(0).pipe(Atom.keepAlive);
		const both = Atom.make((get) => get(first) + get(second));
		const listener = vi.fn();
		const unsubscribe = appAtomRegistry.subscribe(both, listener, {
			immediate: true,
		});
		listener.mockClear();

		batchAtomUpdates(() => {
			appAtomRegistry.set(first, 1);
			appAtomRegistry.set(second, 2);
		});

		expect(appAtomRegistry.get(both)).toBe(3);
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe();
	});
});
