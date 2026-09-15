import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emulator = vi.hoisted(() => ({
	create: vi.fn(),
}));

vi.mock("../../src/terminal/ghostty/emulator.ts", () => ({
	GhosttyEmulator: { create: emulator.create },
}));

vi.mock("../../src/lib/platform-capabilities.ts", () => ({
	copyText: vi.fn(async () => undefined),
}));

type FakeElement = HTMLElement & {
	isConnected: boolean;
	clientWidth: number;
	clientHeight: number;
	dispatch: (type: string, event?: Readonly<Record<string, unknown>>) => void;
};

const makeElement = (tag: string): FakeElement => {
	const listeners = new Map<string, Array<(event: unknown) => void>>();
	const capturedPointers = new Set<number>();
	const element = {
		tagName: tag.toUpperCase(),
		className: "",
		dataset: {},
		style: {},
		isConnected: false,
		clientWidth: tag === "div" ? 800 : 0,
		clientHeight: tag === "div" ? 320 : 0,
		width: 0,
		height: 0,
		value: "",
		append: (...children: FakeElement[]) => {
			for (const child of children) child.isConnected = element.isConnected;
		},
		appendChild: (child: FakeElement) => {
			child.isConnected = true;
			return child;
		},
		remove: () => {
			element.isConnected = false;
		},
		setAttribute: () => undefined,
		addEventListener: (type: string, listener: (event: unknown) => void) => {
			listeners.set(type, [...(listeners.get(type) ?? []), listener]);
		},
		dispatch: (type: string, event: Readonly<Record<string, unknown>> = {}) => {
			const value = {
				button: 0,
				pointerId: 1,
				clientX: 10,
				clientY: 10,
				timeStamp: 1,
				metaKey: false,
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
				isComposing: false,
				code: "",
				key: "",
				preventDefault: vi.fn(),
				...event,
			};
			for (const listener of listeners.get(type) ?? []) listener(value);
		},
		focus: () => {
			Object.assign(document, { activeElement: element });
			element.dispatch("focus");
		},
		getBoundingClientRect: () => ({
			left: 0,
			top: 0,
			width: element.clientWidth,
			height: element.clientHeight,
			right: element.clientWidth,
			bottom: element.clientHeight,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		}),
		setPointerCapture: (pointerId: number) => capturedPointers.add(pointerId),
		hasPointerCapture: (pointerId: number) => capturedPointers.has(pointerId),
		releasePointerCapture: (pointerId: number) =>
			capturedPointers.delete(pointerId),
		getContext: () => ({
			font: "",
			measureText: () => ({ width: 7 }),
			setTransform: () => undefined,
		}),
	} as unknown as FakeElement;
	return element;
};

describe("GhosttySurface initialization", () => {
	beforeEach(() => {
		emulator.create.mockReset();
		const windowListeners = new Map<string, Array<() => void>>();
		vi.stubGlobal("document", {
			createElement: (tag: string) => makeElement(tag),
			activeElement: null,
			hasFocus: () => true,
		});
		vi.stubGlobal("getComputedStyle", () => ({
			color: "rgb(230 230 230)",
			getPropertyValue: () => "",
		}));
		vi.stubGlobal("window", {
			devicePixelRatio: 1,
			addEventListener: (type: string, listener: () => void) => {
				windowListeners.set(type, [
					...(windowListeners.get(type) ?? []),
					listener,
				]);
			},
			removeEventListener: (type: string, listener: () => void) => {
				windowListeners.set(
					type,
					(windowListeners.get(type) ?? []).filter(
						(candidate) => candidate !== listener,
					),
				);
			},
			dispatch: (type: string) => {
				for (const listener of windowListeners.get(type) ?? []) listener();
			},
		});
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn(() => 1),
		);
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("exposes initialization failure without creating unhandled continuations", async () => {
		const failure = new Error("Ghostty WASM failed to initialize");
		emulator.create.mockRejectedValue(failure);
		const unhandled: unknown[] = [];
		const onUnhandled = (cause: unknown) => unhandled.push(cause);
		process.on("unhandledRejection", onUnhandled);
		try {
			const { GhosttySurface } = await import(
				"../../src/terminal/ghostty/surface.ts"
			);
			const surface = new GhosttySurface();
			const container = makeElement("div");
			surface.open(container);
			surface.refreshTheme();

			await expect(surface.ready()).rejects.toBe(failure);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandled).toEqual([]);
			surface.dispose();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("reports focus, selects all, and autoscrolls an edge drag", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const fakeEmulator = {
			dispose: vi.fn(),
			encodeFocus: vi.fn((focused: boolean) =>
				focused ? "\u001b[I" : "\u001b[O",
			),
			encodeKey: vi.fn(() => ""),
			mouseTracking: vi.fn(() => false),
			resize: vi.fn(),
			selectAll: vi.fn(() => true),
			selectionAutoscrollTick: vi.fn(() => true),
			selectionDrag: vi.fn(),
			selectionPress: vi.fn(),
			selectionRelease: vi.fn(),
			setPalette: vi.fn(),
		};
		emulator.create.mockResolvedValue(fakeEmulator);
		try {
			const { GhosttySurface } = await import(
				"../../src/terminal/ghostty/surface.ts"
			);
			const surface = new GhosttySurface();
			const output: string[] = [];
			surface.onData((data) => output.push(data));
			surface.open(makeElement("div"));
			await surface.ready();

			surface.focus();
			expect(output.at(-1)).toBe("\u001b[I");
			(window as unknown as { dispatch: (type: string) => void }).dispatch(
				"blur",
			);
			expect(output.at(-1)).toBe("\u001b[O");

			const input = (surface as unknown as { input: FakeElement }).input;
			const selectAllEvent = { key: "a", code: "KeyA", metaKey: true };
			input.dispatch("keydown", selectAllEvent);
			expect(fakeEmulator.selectAll).toHaveBeenCalledOnce();

			const host = surface.host as unknown as FakeElement;
			host.dispatch("pointerdown", { clientX: 10, clientY: 20 });
			host.dispatch("pointermove", { clientX: 10, clientY: -5 });
			vi.advanceTimersByTime(50);
			expect(fakeEmulator.selectionAutoscrollTick).toHaveBeenCalledOnce();
			host.dispatch("pointerup", { clientX: 10, clientY: 0 });
			vi.advanceTimersByTime(100);
			expect(fakeEmulator.selectionAutoscrollTick).toHaveBeenCalledOnce();
			surface.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});
