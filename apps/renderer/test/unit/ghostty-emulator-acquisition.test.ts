import { describe, expect, it } from "vitest";

import {
	GhosttyEmulator,
	type TerminalPalette,
} from "../../src/terminal/ghostty/emulator.ts";

const palette: TerminalPalette = {
	background: { r: 1, g: 2, b: 3 },
	foreground: { r: 230, g: 231, b: 232 },
	cursor: { r: 250, g: 251, b: 252 },
	selection: "#334455",
	selectionForeground: { r: 255, g: 255, b: 255 },
};

type FailurePoint = "abi" | "callback" | "palette" | null;

class FakeGhosttyRuntime {
	readonly constructorFailure = new Error("constructor failure");
	readonly disposerFailure = new Error("disposer failure");
	readonly releaseOrder: string[] = [];
	readonly freeCalls: Array<
		Readonly<{ name: string; arguments: ReadonlyArray<number | bigint> }>
	> = [];
	readonly handleNames = new Map<number, string>();
	private readonly buffers = new Set<number>();
	private readonly handleSlots = new Set<number>();
	private readonly handles = new Set<number>();
	private readonly valuesBySlot = new Map<number, number>();
	private nextPointer = 8;
	private replyAttached = false;

	constructor(
		private readonly failurePoint: FailurePoint,
		private readonly throwingDisposer: string | null = null,
	) {}

	get activeResourceCount(): number {
		return (
			this.buffers.size +
			this.handleSlots.size +
			this.handles.size +
			(this.replyAttached ? 1 : 0)
		);
	}

	allocate(_size: number): number {
		const pointer = this.nextPointer;
		this.nextPointer += 8;
		this.buffers.add(pointer);
		return pointer;
	}

	release(pointer: number, _size: number): void {
		this.releaseOrder.push(`buffer:${pointer}`);
		this.buffers.delete(pointer);
		if (this.throwingDisposer === `buffer:${pointer}`) {
			throw this.disposerFailure;
		}
	}

	allocateHandleSlot(): number {
		const pointer = this.nextPointer;
		this.nextPointer += 8;
		this.handleSlots.add(pointer);
		return pointer;
	}

	releaseHandleSlot(pointer: number): void {
		this.releaseOrder.push(`slot:${pointer}`);
		this.handleSlots.delete(pointer);
		if (this.throwingDisposer === `slot:${pointer}`) {
			throw this.disposerFailure;
		}
	}

	readHandle(pointer: number): number {
		return this.valuesBySlot.get(pointer) ?? 0;
	}

	layout(name: string) {
		if (this.failurePoint === "abi" && name === "GhosttyStyle") {
			throw this.constructorFailure;
		}
		return { size: 16, align: 4, fields: {} };
	}

	bytes(_pointer: number, size: number): Uint8Array {
		return new Uint8Array(size);
	}

	view(_pointer: number, size = 8): DataView {
		return new DataView(new ArrayBuffer(size));
	}

	writeField(): void {}

	invoke(name: string, ...arguments_: Array<number | bigint>): number {
		if (name.endsWith("_new")) {
			const slot = Number(arguments_[1]);
			const value = this.nextPointer;
			this.nextPointer += 8;
			this.valuesBySlot.set(slot, value);
			this.handles.add(value);
			this.handleNames.set(value, name);
			return 0;
		}
		if (name.endsWith("_free")) {
			const value = Number(arguments_[0]);
			this.releaseOrder.push(name);
			this.freeCalls.push({ name, arguments: arguments_ });
			this.handles.delete(value);
			if (this.throwingDisposer === name) throw this.disposerFailure;
			return 0;
		}
		if (
			this.failurePoint === "palette" &&
			name === "ghostty_terminal_set" &&
			Number(arguments_[1]) === 11
		) {
			return 1;
		}
		return 0;
	}

	registerTerminalReplies(): () => void {
		if (this.failurePoint === "callback") throw this.constructorFailure;
		this.replyAttached = true;
		return () => {
			this.releaseOrder.push("detach-replies");
			this.replyAttached = false;
			if (this.throwingDisposer === "detach-replies") {
				throw this.disposerFailure;
			}
		};
	}
}

const construct = (runtime: FakeGhosttyRuntime): GhosttyEmulator =>
	Reflect.construct(GhosttyEmulator, [runtime, palette, () => undefined]);

describe("Ghostty emulator acquisition", () => {
	it.each([
		"abi",
		"callback",
		"palette",
	] as const)("releases every acquired resource after a %s constructor failure", (failurePoint) => {
		const runtime = new FakeGhosttyRuntime(failurePoint);

		expect(() => construct(runtime)).toThrow(
			failurePoint === "palette"
				? /ghostty_terminal_set\(color\) failed/
				: runtime.constructorFailure,
		);
		expect(runtime.activeResourceCount).toBe(0);
	});

	it("preserves the constructor failure while continuing past a throwing disposer", () => {
		const runtime = new FakeGhosttyRuntime("palette", "detach-replies");

		expect(() => construct(runtime)).toThrow(
			/ghostty_terminal_set\(color\) failed/,
		);
		expect(runtime.releaseOrder).toContain("detach-replies");
		expect(runtime.activeResourceCount).toBe(0);
	});

	it("uses the same idempotent LIFO authority for normal disposal", () => {
		const runtime = new FakeGhosttyRuntime(null, "ghostty_render_state_free");
		const emulator = construct(runtime);
		const terminal = [...runtime.handleNames].find(
			([, name]) => name === "ghostty_terminal_new",
		)?.[0];
		const selectionGesture = [...runtime.handleNames].find(
			([, name]) => name === "ghostty_selection_gesture_new",
		)?.[0];
		if (terminal === undefined || selectionGesture === undefined) {
			throw new Error("Expected terminal and selection gesture handles");
		}

		expect(() => emulator.dispose()).toThrow(runtime.disposerFailure);
		expect(runtime.activeResourceCount).toBe(0);
		const releaseCount = runtime.releaseOrder.length;
		expect(() => emulator.dispose()).not.toThrow();
		expect(runtime.releaseOrder).toHaveLength(releaseCount);
		expect(
			runtime.releaseOrder.indexOf("ghostty_selection_gesture_free"),
		).toBeLessThan(runtime.releaseOrder.indexOf("ghostty_terminal_free"));
		expect(
			runtime.freeCalls.find(
				(call) => call.name === "ghostty_selection_gesture_free",
			)?.arguments,
		).toEqual([selectionGesture, terminal]);
	});
});
