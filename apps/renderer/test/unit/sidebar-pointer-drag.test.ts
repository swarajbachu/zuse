import { afterEach, describe, expect, it, vi } from "vitest";
import { startSidebarPointerDrag } from "../../src/lib/sidebar-pointer-drag.ts";

const pointer = (type: string, x = 10, overrides = {}) =>
	Object.assign(new Event(type, { cancelable: true }), {
		pointerId: 1,
		buttons: 1,
		clientX: x,
		clientY: 10,
		...overrides,
	}) as PointerEvent;

const fixture = () => {
	vi.useFakeTimers();
	const attributes = new Map<string, string>();
	const view = Object.assign(new EventTarget(), {
		setTimeout,
		clearTimeout,
		requestAnimationFrame: vi.fn(() => 1),
		cancelAnimationFrame: vi.fn(),
	});
	const preview = {
		style: {},
		removeAttribute: vi.fn(),
		setAttribute: vi.fn(),
		remove: vi.fn(),
	};
	const doc = Object.assign(new EventTarget(), {
		defaultView: view,
		documentElement: {
			setAttribute: (name: string, value: string) =>
				attributes.set(name, value),
			removeAttribute: (name: string) => attributes.delete(name),
		},
		body: { append: vi.fn() },
	});
	let captured = false;
	const element = Object.assign(new EventTarget(), {
		ownerDocument: doc,
		closest: () => null,
		setPointerCapture: () => {
			captured = true;
		},
		hasPointerCapture: () => captured,
		releasePointerCapture: () => {
			captured = false;
		},
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 30 }),
		cloneNode: () => preview,
	});
	const callbacks = { onMove: vi.fn(), onDrop: vi.fn(), onEnd: vi.fn() };
	const cleanup = startSidebarPointerDrag(
		element as unknown as HTMLElement,
		pointer("pointerdown"),
		callbacks,
	);
	return { view, doc, preview, attributes, callbacks, cleanup };
};

afterEach(() => {
	vi.useRealTimers();
});

describe("sidebar pointer drag", () => {
	it("keeps a normal accordion click below the drag threshold", () => {
		const f = fixture();
		f.view.dispatchEvent(pointer("pointermove", 12));
		f.view.dispatchEvent(pointer("pointerup", 12, { buttons: 0 }));
		expect(f.attributes.has("data-sidebar-dragging")).toBe(false);
		expect(f.callbacks.onMove).not.toHaveBeenCalled();
		expect(f.callbacks.onDrop).not.toHaveBeenCalled();
		expect(f.doc.dispatchEvent(new Event("click", { cancelable: true }))).toBe(
			true,
		);
		f.cleanup();
	});

	it("holds the drag cursor across moves and clears it on drop without toggling a header", () => {
		const f = fixture();
		f.view.dispatchEvent(pointer("pointermove", 30));
		f.view.dispatchEvent(pointer("pointermove", 200));
		expect(f.attributes.has("data-sidebar-dragging")).toBe(true);
		expect(f.callbacks.onMove).toHaveBeenCalledTimes(2);
		f.view.dispatchEvent(pointer("pointerup", 200, { buttons: 0 }));
		expect(f.callbacks.onDrop).toHaveBeenCalledOnce();
		expect(f.attributes.has("data-sidebar-dragging")).toBe(false);
		expect(f.preview.remove).toHaveBeenCalledOnce();
		expect(f.doc.dispatchEvent(new Event("click", { cancelable: true }))).toBe(
			false,
		);
		vi.runAllTimers();
		expect(f.doc.dispatchEvent(new Event("click", { cancelable: true }))).toBe(
			true,
		);
		f.cleanup();
	});

	it.each([
		"escape",
		"blur",
		"pointercancel",
		"unmount",
	])("cleans up %s without committing a move", (reason) => {
		const f = fixture();
		f.view.dispatchEvent(pointer("pointermove", 30));
		if (reason === "unmount") f.cleanup();
		else if (reason === "escape")
			f.view.dispatchEvent(
				Object.assign(new Event("keydown"), { key: "Escape" }),
			);
		else f.view.dispatchEvent(pointer(reason));
		expect(f.attributes.has("data-sidebar-dragging")).toBe(false);
		expect(f.preview.remove).toHaveBeenCalledOnce();
		f.view.dispatchEvent(pointer("pointerup", 30, { buttons: 0 }));
		expect(f.callbacks.onDrop).not.toHaveBeenCalled();
		expect(f.callbacks.onEnd).toHaveBeenCalledOnce();
		f.cleanup();
	});

	it("ignores unrelated pointers and removes listeners after cleanup", () => {
		const f = fixture();
		f.view.dispatchEvent(pointer("pointermove", 30, { pointerId: 2 }));
		expect(f.attributes.has("data-sidebar-dragging")).toBe(false);
		f.cleanup();
		f.view.dispatchEvent(pointer("pointermove", 30));
		expect(f.callbacks.onMove).not.toHaveBeenCalled();
	});
});
