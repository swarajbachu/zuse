import { describe, expect, it } from "vitest";
import { ALGORITHMS, DEFAULT_OPTIONS, ditherPixels, PALETTES } from "./dither";

const gradient = (width: number, height: number) =>
	new Uint8ClampedArray(
		Array.from({ length: width * height }, (_, i) => {
			const value = Math.round((255 * i) / (width * height - 1));
			return [value, value, value, 255];
		}).flat(),
	);

describe("dither image processing", () => {
	for (const algorithm of Object.keys(
		ALGORITHMS,
	) as (keyof typeof ALGORITHMS)[]) {
		it(`${algorithm} preserves dimensions, alpha, and the selected palette`, () => {
			const input = gradient(16, 16);
			input[3] = 0;
			input[7] = 128;
			const copy = input.slice();
			const result = ditherPixels(input, 16, 16, {
				...DEFAULT_OPTIONS,
				algorithm,
			});
			expect(result.length).toBe(input.length);
			expect(input).toEqual(copy);
			for (let i = 0; i < result.length; i += 4) {
				expect(result[i + 3]).toBe(input[i + 3]);
				if (result[i + 3])
					expect(PALETTES.violet.colors.map((color) => color.join())).toContain(
						[...result.slice(i, i + 3)].join(),
					);
			}
			expect(new Set(result).size).toBeGreaterThan(4);
		});
	}
	it("zero strength retains original pixels at neutral contrast and brightness", () => {
		const input = gradient(8, 8);
		expect(
			ditherPixels(input, 8, 8, { ...DEFAULT_OPTIONS, strength: 0 }),
		).toEqual(input);
	});
	it("ordered dithering repeats its selected matrix without seams", () => {
		const input = new Uint8ClampedArray(16 * 16 * 4).fill(128);
		for (let i = 3; i < input.length; i += 4) input[i] = 255;
		const output = ditherPixels(input, 16, 16, {
			...DEFAULT_OPTIONS,
			algorithm: "bayer-4",
			palette: "mono",
		});
		for (let y = 0; y < 12; y++)
			for (let x = 0; x < 12; x++) {
				expect(output[(y * 16 + x) * 4]).toBe(
					output[((y + 4) * 16 + x + 4) * 4],
				);
			}
	});
	it("6×6 crosshatch keeps recognizable diagonal marks", () => {
		const width = 24;
		const input = new Uint8ClampedArray(width * width * 4);
		for (let i = 0; i < input.length; i += 4)
			input.set([110, 110, 110, 255], i);
		const options = {
			...DEFAULT_OPTIONS,
			algorithm: "cross-6",
			palette: "mono",
		} as const;
		const output = ditherPixels(input, width, width, options);
		expect(ditherPixels(input, width, width, options)).toEqual(output);
		let extraStrokePixels = 0;
		for (let y = 0; y < width; y++) {
			for (let x = 0; x < width; x++) {
				const onCross = x % 6 === y % 6 || (x % 6) + (y % 6) === 5;
				if (onCross) expect(output[(y * width + x) * 4]).toBe(244);
				else if (output[(y * width + x) * 4] === 244) extraStrokePixels++;
			}
		}
		expect(extraStrokePixels).toBeLessThan(32);
	});
	it("organic grain is stable, nonperiodic, and preserves neutral endpoints", () => {
		const width = 64;
		const input = new Uint8ClampedArray(width * width * 4);
		for (let i = 0; i < input.length; i += 4)
			input.set([128, 128, 128, 255], i);
		input.set([0, 0, 0, 255], 0);
		input.set([255, 255, 255, 255], 4);
		const options = {
			...DEFAULT_OPTIONS,
			algorithm: "grain",
			palette: "color",
		} as const;
		const output = ditherPixels(input, width, width, options);
		expect(ditherPixels(input, width, width, options)).toEqual(output);
		expect([...output.slice(0, 8)]).toEqual([...input.slice(0, 8)]);
		let differences = 0;
		let total = 0;
		for (let y = 0; y < width - 8; y++) {
			for (let x = 0; x < width - 8; x++) {
				const offset = (y * width + x) * 4;
				const red = output[offset] ?? 0;
				expect(output[offset + 1]).toBe(red);
				expect(output[offset + 2]).toBe(red);
				if (red !== output[((y + 8) * width + x + 8) * 4]) differences++;
				total += red;
			}
		}
		expect(differences).toBeGreaterThan(800);
		expect(total / (56 * 56)).toBeGreaterThan(120);
		expect(total / (56 * 56)).toBeLessThan(136);
	});
	it("diffusion handles single-column images and transparent pixels", () => {
		const input = new Uint8ClampedArray([
			128, 128, 128, 255, 255, 0, 0, 0, 128, 128, 128, 255,
		]);
		const output = ditherPixels(input, 1, 3, {
			...DEFAULT_OPTIONS,
			algorithm: "floyd-steinberg",
			palette: "mono",
		});
		expect([...output.slice(4, 8)]).toEqual([0, 0, 0, 0]);
		expect(output[0]).toBe(output[8]);
	});
});
