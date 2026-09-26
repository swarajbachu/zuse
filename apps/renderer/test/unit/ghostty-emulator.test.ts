/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const originalFetch = globalThis.fetch;

beforeAll(() => {
	globalThis.fetch = (async (input: string | URL | Request) => {
		const value = String(input);
		const filename = value.includes("pty-callback")
			? "pty-callback.wasm"
			: "ghostty-vt.wasm";
		const bytes = await readFile(
			new URL(`../../src/terminal/ghostty/vendor/${filename}`, import.meta.url),
		);
		return new Response(bytes, { status: 200 });
	}) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

describe("Ghostty terminal emulator", () => {
	it("parses styled UTF-8 output and survives repeated lifecycle operations", async () => {
		const { GhosttyEmulator } = await import(
			"../../src/terminal/ghostty/emulator.ts"
		);
		const palette = {
			background: { r: 1, g: 2, b: 3 },
			foreground: { r: 230, g: 231, b: 232 },
			cursor: { r: 250, g: 251, b: 252 },
			selection: "#334455",
			selectionForeground: { r: 255, g: 255, b: 255 },
		} as const;
		for (let iteration = 0; iteration < 10; iteration += 1) {
			const replies: string[] = [];
			const emulator = await GhosttyEmulator.create(palette, (data) => {
				replies.push(data);
			});
			emulator.resize(40, 6, 7, 15);
			emulator.write(
				"hello 👩🏽‍💻\r\n\u001b[38;2;255;64;32mred\u001b[0m\r\n\u001b[2;5;4:3;58;2;1;2;3mstyled\u001b[0m",
			);
			const frame = emulator.capture();
			expect(frame.cols).toBe(40);
			expect(frame.rows).toBe(6);
			expect(frame.lines[0]?.map((cell) => cell.text).join("")).toContain(
				"hello 👩🏽‍💻",
			);
			const red = frame.lines[1]?.find((cell) => cell.text === "r");
			expect(red?.foreground).toEqual({ r: 255, g: 64, b: 32 });
			const styled = frame.lines[2]?.find((cell) => cell.text === "s");
			expect(styled).toMatchObject({
				faint: true,
				blink: true,
				underlineStyle: 3,
				underlineColor: { r: 1, g: 2, b: 3 },
			});
			emulator.write("\u001b[5n");
			expect(replies.join("")).toContain("\u001b[0n");
			emulator.reset();
			expect(
				emulator
					.capture()
					.lines.flatMap((line) => line.map((cell) => cell.text)),
			).not.toContain("h");
			emulator.dispose();
		}
	});

	it("encodes application mouse input only while terminal tracking is active", async () => {
		const { GhosttyEmulator } = await import(
			"../../src/terminal/ghostty/emulator.ts"
		);
		const emulator = await GhosttyEmulator.create(
			{
				background: { r: 1, g: 2, b: 3 },
				foreground: { r: 230, g: 231, b: 232 },
				cursor: { r: 250, g: 251, b: 252 },
				selection: "#334455",
				selectionForeground: { r: 255, g: 255, b: 255 },
			},
			() => {},
		);
		try {
			emulator.resize(80, 30, 10, 20, 800, 600);
			expect(emulator.mouseTracking()).toBe(false);
			expect(
				emulator.encodeMouse({
					action: "press",
					button: 1,
					modifiers: 0,
					x: 50,
					y: 40,
					anyButtonPressed: true,
				}),
			).toBe("");

			emulator.write("\u001b[?1000h\u001b[?1006h");
			expect(emulator.mouseTracking()).toBe(true);
			expect(
				emulator.encodeMouse({
					action: "press",
					button: 1,
					modifiers: 0,
					x: 50,
					y: 40,
					anyButtonPressed: true,
				}),
			).toBe("\u001b[<0;6;3M");
			expect(
				emulator.encodeMouse({
					action: "release",
					button: 1,
					modifiers: 0,
					x: 50,
					y: 40,
					anyButtonPressed: false,
				}),
			).toBe("\u001b[<0;6;3m");

			emulator.write("\u001b[?1000l");
			expect(emulator.mouseTracking()).toBe(false);
		} finally {
			emulator.dispose();
		}
	});

	it("encodes deduplicated focus transitions only while mode 1004 is active", async () => {
		const { GhosttyEmulator } = await import(
			"../../src/terminal/ghostty/emulator.ts"
		);
		const emulator = await GhosttyEmulator.create(
			{
				background: { r: 1, g: 2, b: 3 },
				foreground: { r: 230, g: 231, b: 232 },
				cursor: { r: 250, g: 251, b: 252 },
				selection: "#334455",
				selectionForeground: { r: 255, g: 255, b: 255 },
			},
			() => {},
		);
		try {
			expect(emulator.encodeFocus(true)).toBe("");
			emulator.write("\u001b[?1004h");
			expect(emulator.encodeFocus(true)).toBe("\u001b[I");
			expect(emulator.encodeFocus(true)).toBe("");
			expect(emulator.encodeFocus(false)).toBe("\u001b[O");
			expect(emulator.encodeFocus(false)).toBe("");
			emulator.write("\u001b[?1004l");
			expect(emulator.encodeFocus(true)).toBe("");
			emulator.write("\u001b[?1004h");
			expect(emulator.encodeFocus(true)).toBe("\u001b[I");
		} finally {
			emulator.dispose();
		}
	});

	it("reuses clean render state and unchanged rows between frames", async () => {
		const { GhosttyEmulator } = await import(
			"../../src/terminal/ghostty/emulator.ts"
		);
		const emulator = await GhosttyEmulator.create(
			{
				background: { r: 1, g: 2, b: 3 },
				foreground: { r: 230, g: 231, b: 232 },
				cursor: { r: 250, g: 251, b: 252 },
				selection: "#334455",
				selectionForeground: { r: 255, g: 255, b: 255 },
			},
			() => {},
		);
		try {
			emulator.resize(80, 24, 8, 16);
			emulator.write("first\r\nsecond");
			const initial = emulator.capture();
			expect(emulator.capture()).toBe(initial);

			emulator.write("!");
			const changed = emulator.capture();
			expect(changed).not.toBe(initial);
			expect(changed.lines[0]).toBe(initial.lines[0]);
			expect(changed.lines[1]).not.toBe(initial.lines[1]);
		} finally {
			emulator.dispose();
		}
	});

	it("uses Ghostty's click and drag selection semantics", async () => {
		const { GhosttyEmulator } = await import(
			"../../src/terminal/ghostty/emulator.ts"
		);
		const emulator = await GhosttyEmulator.create(
			{
				background: { r: 1, g: 2, b: 3 },
				foreground: { r: 230, g: 231, b: 232 },
				cursor: { r: 250, g: 251, b: 252 },
				selection: "#334455",
				selectionForeground: { r: 255, g: 255, b: 255 },
			},
			() => {},
		);
		try {
			emulator.resize(20, 4, 10, 20, 200, 80);
			emulator.write("hello world");
			emulator.selectionPress({
				x: 6,
				y: 0,
				surfaceX: 65,
				surfaceY: 10,
				timeMs: 100,
				rectangle: false,
			});
			emulator.selectionRelease({ x: 6, y: 0 });
			emulator.selectionPress({
				x: 6,
				y: 0,
				surfaceX: 65,
				surfaceY: 10,
				timeMs: 200,
				rectangle: false,
			});
			expect(emulator.selectionText()).toBe("world");
			emulator.selectionRelease({ x: 6, y: 0 });

			emulator.selectionPress({
				x: 0,
				y: 0,
				surfaceX: 5,
				surfaceY: 10,
				timeMs: 1_000,
				rectangle: false,
			});
			emulator.selectionDrag({
				x: 4,
				y: 0,
				surfaceX: 49,
				surfaceY: 10,
				timeMs: 1_050,
				rectangle: false,
			});
			expect(emulator.selectionText()).toBe("hello");
			emulator.selectionRelease({ x: 4, y: 0 });
		} finally {
			emulator.dispose();
		}
	});

	it("selects all scrollback through Ghostty's terminal selection", async () => {
		const { GhosttyEmulator } = await import(
			"../../src/terminal/ghostty/emulator.ts"
		);
		const emulator = await GhosttyEmulator.create(
			{
				background: { r: 1, g: 2, b: 3 },
				foreground: { r: 230, g: 231, b: 232 },
				cursor: { r: 250, g: 251, b: 252 },
				selection: "#334455",
				selectionForeground: { r: 255, g: 255, b: 255 },
			},
			() => {},
		);
		try {
			emulator.resize(20, 3, 10, 20, 200, 60);
			emulator.write("first\r\nsecond\r\nthird\r\nfourth");

			expect(emulator.selectAll()).toBe(true);
			expect(emulator.selectionText()).toBe("first\nsecond\nthird\nfourth");
		} finally {
			emulator.dispose();
		}
	});

	it("extends a drag selection through scrollback on edge ticks", async () => {
		const { GhosttyEmulator } = await import(
			"../../src/terminal/ghostty/emulator.ts"
		);
		const emulator = await GhosttyEmulator.create(
			{
				background: { r: 1, g: 2, b: 3 },
				foreground: { r: 230, g: 231, b: 232 },
				cursor: { r: 250, g: 251, b: 252 },
				selection: "#334455",
				selectionForeground: { r: 255, g: 255, b: 255 },
			},
			() => {},
		);
		try {
			emulator.resize(20, 3, 10, 20, 200, 60);
			emulator.write(
				"line-1\r\nline-2\r\nline-3\r\nline-4\r\nline-5\r\nline-6",
			);
			emulator.selectionPress({
				x: 5,
				y: 2,
				surfaceX: 55,
				surfaceY: 50,
				timeMs: 100,
				rectangle: false,
			});
			emulator.selectionDrag({
				x: 0,
				y: 0,
				surfaceX: 5,
				surfaceY: -5,
				timeMs: 150,
				rectangle: false,
			});
			const before = emulator.selectionText();
			for (let index = 0; index < 3; index += 1) {
				expect(
					emulator.selectionAutoscrollTick({
						x: 0,
						y: 0,
						surfaceX: 5,
						surfaceY: -5,
						timeMs: 200 + index * 50,
						rectangle: false,
					}),
				).toBe(true);
			}

			expect(emulator.selectionText().length).toBeGreaterThan(before.length);
			expect(emulator.selectionText()).toContain("line-1");
			emulator.selectionRelease({ x: 0, y: 0 });
		} finally {
			emulator.dispose();
		}
	});
});
