import { expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
	effect: undefined as undefined | (() => (() => void) | undefined),
	canvas: undefined as unknown,
}));
vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useRef: () => ({ current: harness.canvas }),
	useEffect: (effect: () => (() => void) | undefined) => {
		harness.effect = effect;
	},
}));

import { DitherDotField } from "@repo/ui/dither";

it("stops and resumes the dot field when the motion preference changes", () => {
	let change = () => {};
	const preference = {
		matches: false,
		addEventListener: vi.fn((_event, listener) => {
			change = listener;
		}),
		removeEventListener: vi.fn(),
	};
	const request = vi.fn(() => 42);
	const cancel = vi.fn();
	const context = {
		clearRect: vi.fn(),
		setTransform: vi.fn(),
		beginPath: vi.fn(),
		arc: vi.fn(),
		fill: vi.fn(),
	};
	harness.canvas = {
		getContext: () => context,
		getBoundingClientRect: () => ({ width: 20, height: 20 }),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	};
	vi.stubGlobal("window", {
		matchMedia: () => preference,
		devicePixelRatio: 1,
		getComputedStyle: () => ({ color: "black" }),
		requestAnimationFrame: request,
		cancelAnimationFrame: cancel,
	});
	try {
		DitherDotField({ interactive: false });
		const cleanup = harness.effect?.();
		expect(request).toHaveBeenCalledTimes(1);
		preference.matches = true;
		change();
		expect(cancel).toHaveBeenCalledWith(42);
		expect(context.clearRect).toHaveBeenCalled();
		expect(request).toHaveBeenCalledTimes(1);
		preference.matches = false;
		change();
		expect(request).toHaveBeenCalledTimes(2);
		cleanup?.();
		expect(preference.removeEventListener).toHaveBeenCalledWith(
			"change",
			change,
		);
	} finally {
		vi.unstubAllGlobals();
	}
});
