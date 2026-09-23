export const ALGORITHMS = {
	"cross-6": "Crosshatch 6 × 6",
	grain: "Organic grain",
	"floyd-steinberg": "Floyd–Steinberg",
	"bayer-2": "Bayer 2 × 2",
	"bayer-4": "Bayer 4 × 4",
	"bayer-8": "Bayer 8 × 8",
	"bayer-16": "Bayer 16 × 16",
	halftone: "Halftone",
	horizontal: "Horizontal lines",
	vertical: "Vertical lines",
} as const;
type RGB = readonly [number, number, number];
export const PALETTES = {
	mono: {
		label: "Mono · 2 colors",
		colors: [
			[12, 14, 13],
			[244, 245, 239],
		],
	},
	gray: {
		label: "Grey · 4 colors",
		colors: [
			[12, 14, 13],
			[85, 87, 85],
			[170, 172, 168],
			[244, 245, 239],
		],
	},
	gameboy: {
		label: "Game Boy",
		colors: [
			[15, 56, 15],
			[48, 98, 48],
			[139, 172, 15],
			[155, 188, 15],
		],
	},
	violet: {
		label: "Violet dusk",
		colors: [
			[15, 13, 24],
			[61, 47, 91],
			[124, 99, 169],
			[217, 201, 239],
		],
	},
	amber: {
		label: "Warm paper",
		colors: [
			[26, 22, 19],
			[97, 70, 48],
			[176, 139, 93],
			[238, 220, 181],
		],
	},
	cga: {
		label: "CGA",
		colors: [
			[0, 0, 0],
			[85, 255, 255],
			[255, 85, 255],
			[255, 255, 255],
		],
	},
	color: { label: "Original color · RGB", colors: [] },
} as const satisfies Record<string, { label: string; colors: readonly RGB[] }>;
export type DitherOptions = {
	algorithm: keyof typeof ALGORITHMS;
	palette: keyof typeof PALETTES;
	pixelSize: number;
	strength: number;
	contrast: number;
	brightness: number;
	blur: number;
};
export const DEFAULT_OPTIONS: DitherOptions = {
	algorithm: "cross-6",
	palette: "violet",
	pixelSize: 2,
	strength: 100,
	contrast: 100,
	brightness: 0,
	blur: 0,
};

const clamp = (n: number) => Math.max(0, Math.min(255, n));
function bayer(x: number, y: number, size: number): number {
	let value = 0;
	for (let bit = 1; bit < size; bit *= 2) {
		value =
			value * 4 +
			(((x & bit) !== 0 ? 1 : 0) ^ ((y & bit) !== 0 ? 1 : 0)) * 2 +
			((y & bit) !== 0 ? 1 : 0);
	}
	return (value + 0.5) / (size * size) - 0.5;
}
// Coordinate hashing keeps the texture stable across renders and exports.
function grainNoise(x: number, y: number): number {
	let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
	hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
	return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

function organicGrain(x: number, y: number): number {
	// A loose, smoothly varying density field breaks up the fine speckles into
	// irregular patches without introducing tile boundaries or a repeating grid.
	const cellX = Math.floor(x / 6);
	const cellY = Math.floor(y / 6);
	const dx = x / 6 - cellX;
	const dy = y / 6 - cellY;
	const u = dx * dx * (3 - 2 * dx);
	const v = dy * dy * (3 - 2 * dy);
	const top =
		grainNoise(cellX, cellY) * (1 - u) + grainNoise(cellX + 1, cellY) * u;
	const bottom =
		grainNoise(cellX, cellY + 1) * (1 - u) +
		grainNoise(cellX + 1, cellY + 1) * u;
	const density = top * (1 - v) + bottom * v;
	return Math.max(
		-0.5,
		Math.min(
			0.5,
			(grainNoise(x + 193, y + 719) * 0.7 + density * 0.3 - 0.5) * 1.3,
		),
	);
}

// The highest thresholds trace both diagonals of each 6×6 cell. Lower
// thresholds fill around those strokes as the image gets brighter.
const CROSS_6 = [
	24, 0, 12, 13, 1, 25, 2, 28, 14, 15, 29, 3, 16, 4, 32, 33, 5, 17, 18, 6, 34,
	35, 7, 19, 8, 30, 20, 21, 31, 9, 26, 10, 22, 23, 11, 27,
];

function threshold(
	x: number,
	y: number,
	algorithm: DitherOptions["algorithm"],
): number {
	if (algorithm === "cross-6") {
		const rank = CROSS_6[(y % 6) * 6 + (x % 6)] ?? 0;
		// Vary whole marks gently, never scatter the individual cross pixels.
		const variation =
			(grainNoise(Math.floor(x / 6), Math.floor(y / 6)) - 0.5) * 0.07;
		return (rank + 0.5) / 36 - 0.5 + variation;
	}
	if (algorithm === "grain") return organicGrain(x, y);
	if (algorithm.startsWith("bayer-"))
		return bayer(x, y, Number(algorithm.slice(6)));
	if (algorithm === "horizontal") return ((y % 4) + 0.5) / 4 - 0.5;
	if (algorithm === "vertical") return ((x % 4) + 0.5) / 4 - 0.5;
	return Math.hypot((x % 6) - 2.5, (y % 6) - 2.5) / 4.25 - 0.5;
}

/** Pure pixel processing, run off the main thread by the editor. Alpha is retained. */
export function ditherPixels(
	source: Uint8ClampedArray,
	width: number,
	height: number,
	options: DitherOptions,
): Uint8ClampedArray {
	const output = new Uint8ClampedArray(source.length);
	const errors = new Float32Array(width * 6);
	const original = new Float32Array(3);
	const value = new Float32Array(3);
	const quantized = new Float32Array(3);
	const colors: readonly RGB[] = PALETTES[options.palette].colors;
	const strength = options.strength / 100;
	for (let y = 0; y < height; y++) {
		const row = (y % 2) * width;
		const nextRow = ((y + 1) % 2) * width;
		errors.fill(0, nextRow * 3, (nextRow + width) * 3);
		for (let x = 0; x < width; x++) {
			const index = y * width + x;
			const offset = index * 4;
			if (source[offset + 3] === 0) continue;
			const ordered =
				options.algorithm === "floyd-steinberg"
					? 0
					: threshold(x, y, options.algorithm) * 128;
			for (let channel = 0; channel < 3; channel++) {
				original[channel] = clamp(
					(((source[offset + channel] ?? 0) - 128) * options.contrast) / 100 +
						128 +
						options.brightness * 2.55,
				);
				value[channel] =
					(original[channel] ?? 0) +
					(options.algorithm === "floyd-steinberg"
						? (errors[(row + x) * 3 + channel] ?? 0)
						: options.algorithm === "grain" || options.algorithm === "cross-6"
							? // Keep deep blacks and bright highlights clean; share the same
								// texture across channels so neutral images stay neutral.
								ordered *
								Math.min(
									1,
									(original[channel] ?? 0) / 48,
									(255 - (original[channel] ?? 0)) / 48,
								)
							: ordered);
				quantized[channel] = Math.round(clamp(value[channel] ?? 0) / 85) * 85;
			}
			let color: ArrayLike<number> = quantized;
			if (colors.length) {
				let distance = Infinity;
				for (const candidate of colors) {
					const d = candidate.reduce(
						(sum, v, c) => sum + (v - (value[c] ?? 0)) ** 2,
						0,
					);
					if (d < distance) {
						distance = d;
						color = candidate;
					}
				}
			}
			for (let c = 0; c < 3; c++) {
				output[offset + c] =
					(original[c] ?? 0) * (1 - strength) + (color[c] ?? 0) * strength;
				if (options.algorithm === "floyd-steinberg") {
					const error = (value[c] ?? 0) - (color[c] ?? 0);
					if (x + 1 < width)
						errors[(row + x + 1) * 3 + c] =
							(errors[(row + x + 1) * 3 + c] ?? 0) + (error * 7) / 16;
					if (y + 1 < height) {
						if (x > 0)
							errors[(nextRow + x - 1) * 3 + c] =
								(errors[(nextRow + x - 1) * 3 + c] ?? 0) + (error * 3) / 16;
						errors[(nextRow + x) * 3 + c] =
							(errors[(nextRow + x) * 3 + c] ?? 0) + (error * 5) / 16;
						if (x + 1 < width)
							errors[(nextRow + x + 1) * 3 + c] =
								(errors[(nextRow + x + 1) * 3 + c] ?? 0) + error / 16;
					}
				}
			}
			output[offset + 3] = source[offset + 3] ?? 0;
		}
	}
	return output;
}
