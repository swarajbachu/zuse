import { afterEach, expect, it, vi } from "vitest";
import { subscribeOnAnimationFrame } from "../../src/frame-subscription";

afterEach(() => vi.unstubAllGlobals());
it("coalesces visual events and cancels a queued notification on disposal", () => {
	let frame = () => {};
	let emit = () => {};
	const schedule = vi.fn((callback: () => void) => {
		frame = callback;
		return 1;
	});
	const cancel = vi.fn();
	vi.stubGlobal("requestAnimationFrame", schedule);
	vi.stubGlobal("cancelAnimationFrame", cancel);
	const unsubscribe = vi.fn();
	const listener = vi.fn();
	const release = subscribeOnAnimationFrame((cb) => {
		emit = cb;
		return unsubscribe;
	}, listener);
	emit();
	emit();
	emit();
	expect(schedule).toHaveBeenCalledTimes(1);
	expect(listener).not.toHaveBeenCalled();
	frame();
	expect(listener).toHaveBeenCalledTimes(1);
	emit();
	release();
	expect(cancel).toHaveBeenCalledWith(1);
	expect(unsubscribe).toHaveBeenCalledOnce();
});
