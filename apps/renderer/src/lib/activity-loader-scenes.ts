/**
 * Canvas scenes for activity loaders. Every scene draws in a square space
 * spanning -1..1 on both axes and inherits one colour, so callers control tone
 * with CSS `color` exactly like an icon.
 */
export const ACTIVITY_LOADER_SCENES = [
	"dither",
	"helix",
	"donut",
	"vortex",
	"wave",
	"mobius",
] as const;

export type ActivityLoaderScene = (typeof ACTIVITY_LOADER_SCENES)[number];

export type ActivityLoaderContext = Pick<
	CanvasRenderingContext2D,
	| "arc"
	| "beginPath"
	| "clearRect"
	| "fill"
	| "fillStyle"
	| "fillText"
	| "font"
	| "globalAlpha"
	| "lineCap"
	| "lineTo"
	| "lineWidth"
	| "moveTo"
	| "setTransform"
	| "stroke"
	| "strokeStyle"
	| "textAlign"
	| "textBaseline"
>;

export type ActivityLoaderFrame = {
	/** Animation clock in milliseconds. */
	readonly time: number;
	/** Rendered CSS size in pixels; scenes simplify their geometry when small. */
	readonly size: number;
	/** Backing-store pixels per CSS pixel. */
	readonly pixelRatio: number;
	readonly color: string;
};

/** Representative frame shown when motion is reduced. */
export const ACTIVITY_LOADER_STILL_TIME = 1_200;

/** Below this size the donut swaps ASCII glyphs for a lit point cloud. */
const ASCII_DONUT_MIN_SIZE = 48;
/** Below this size the Möbius band uses fewer, larger dots. */
const DENSE_MOBIUS_MIN_SIZE = 32;

const TAU = Math.PI * 2;
const ASCII_RAMP = ".,-~:;=!*#$@";

type Point = { readonly x: number; readonly y: number; readonly z: number };
type Projected = Point & { readonly k: number };

const rotateX = (p: Point, a: number): Point => {
	const c = Math.cos(a);
	const s = Math.sin(a);
	return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c };
};

const rotateY = (p: Point, a: number): Point => {
	const c = Math.cos(a);
	const s = Math.sin(a);
	return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
};

const rotateZ = (p: Point, a: number): Point => {
	const c = Math.cos(a);
	const s = Math.sin(a);
	return { x: p.x * c - p.y * s, y: p.x * s + p.y * c, z: p.z };
};

const project = (p: Point, focal = 3.2): Projected => {
	const k = focal / (focal - p.z);
	return { x: p.x * k, y: p.y * k, z: p.z, k };
};

const smoothstep = (from: number, to: number, value: number): number => {
	const t = Math.max(0, Math.min(1, (value - from) / (to - from)));
	return t * t * (3 - 2 * t);
};

/** Stable pseudo-random value in [0, 1) for a pair of integers. */
const hash = (a: number, b: number): number => {
	const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
	return v - Math.floor(v);
};

const byDepth = <T extends { readonly z: number }>(a: T, b: T): number =>
	a.z - b.z;

function dot(
	ctx: ActivityLoaderContext,
	x: number,
	y: number,
	radius: number,
	alpha: number,
): void {
	if (alpha <= 0.01) return;
	ctx.globalAlpha = Math.min(1, alpha);
	ctx.beginPath();
	ctx.arc(x, y, radius, 0, TAU);
	ctx.fill();
}

type SceneDraw = (
	ctx: ActivityLoaderContext,
	time: number,
	/** One CSS pixel in scene units, for minimum mark sizes. */
	px: number,
	size: number,
) => void;

/** 4×4 ordered-dither (Bayer) thresholds, normalised to 0..1. */
const BAYER_4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(
	(rank) => (rank + 0.5) / 16,
);

/**
 * 4×4 dot grid that fills and empties in ordered-dither order. Dots grow and
 * shrink rather than fade, a slow ripple keeps neighbours out of step, and a
 * rare flicker makes it feel alive at inline sizes.
 */
const drawDither: SceneDraw = (ctx, time, px) => {
	// Pulled-in pitch and fine dots so the grid reads as one compact cluster.
	const pitch = 0.4;
	const radius = 0.09;
	const cycle = (time / 1_300) % 2;
	const sweep = cycle < 1 ? cycle : 2 - cycle;
	const level = 0.06 + 0.88 * sweep * sweep * (3 - 2 * sweep);
	const flickerFrame = Math.floor(time / 140);
	BAYER_4.forEach((threshold, index) => {
		const x = index % 4;
		const y = Math.floor(index / 4);
		const ripple = 0.12 * Math.sin(time * 0.0045 + x * 1.4 - y * 0.9);
		let scale = smoothstep(threshold - 0.14, threshold + 0.14, level + ripple);
		if (hash(index, flickerFrame) > 0.94) scale *= 0.45;
		if (scale < 0.08) return;
		dot(
			ctx,
			(x - 1.5) * pitch,
			(y - 1.5) * pitch,
			Math.max(px * 0.45, radius) * scale,
			0.35 + 0.65 * scale,
		);
	});
};

/** Double helix of particles with rungs, turning in depth. */
const drawHelix: SceneDraw = (ctx, time, px) => {
	const points: Array<Projected & { readonly rung: boolean }> = [];
	for (let strand = 0; strand < 2; strand += 1) {
		for (let i = 0; i < 15; i += 1) {
			const y = -0.82 + (1.64 * i) / 14;
			const a = y * 3.1 + time * 0.0034 + strand * Math.PI;
			points.push({
				...project(
					rotateZ({ x: Math.cos(a) * 0.48, y, z: Math.sin(a) * 0.48 }, 0.55),
				),
				rung: false,
			});
			if (strand !== 0 || i % 2 !== 0) continue;
			for (const f of [-0.5, 0, 0.5]) {
				points.push({
					...project(
						rotateZ(
							{ x: Math.cos(a) * 0.48 * f, y, z: Math.sin(a) * 0.48 * f },
							0.55,
						),
					),
					rung: true,
				});
			}
		}
	}
	for (const p of points.sort(byDepth)) {
		const depth = p.z + 0.5;
		const scale = p.rung ? 0.5 : 1;
		dot(
			ctx,
			p.x,
			p.y,
			Math.max(px * 0.6, (0.05 + 0.035 * depth) * scale),
			(0.2 + 0.8 * depth) * (p.rung ? 0.45 : 1),
		);
	}
};

/** donut.c: an ASCII-lit torus, rasterised on a character grid. */
function drawAsciiDonut(ctx: ActivityLoaderContext, time: number): void {
	const grid = 20;
	const a = 0.95 + 0.55 * Math.sin(time * 0.0007);
	const b = time * 0.0012;
	const cA = Math.cos(a);
	const sA = Math.sin(a);
	const cB = Math.cos(b);
	const sB = Math.sin(b);
	const tube = 0.45;
	const ring = 1;
	const distance = 5;
	const focal = (grid * distance * 3) / (8 * (tube + ring));
	const depth = new Float32Array(grid * grid);
	const light = new Float32Array(grid * grid).fill(-1);
	for (let th = 0; th < TAU; th += 0.07) {
		const ct = Math.cos(th);
		const st = Math.sin(th);
		for (let ph = 0; ph < TAU; ph += 0.025) {
			const cp = Math.cos(ph);
			const sp = Math.sin(ph);
			const cx = ring + tube * ct;
			const cy = tube * st;
			const x = cx * (cB * cp + sA * sB * sp) - cy * cA * sB;
			const y = cx * (sB * cp - sA * cB * sp) + cy * cA * cB;
			const ooz = 1 / (distance + cA * cx * sp + cy * sA);
			const column = Math.floor(grid / 2 + focal * ooz * x);
			const row = Math.floor(grid / 2 - focal * ooz * y);
			if (column < 0 || row < 0 || column >= grid || row >= grid) continue;
			const index = row * grid + column;
			if (ooz <= (depth[index] ?? 0)) continue;
			depth[index] = ooz;
			light[index] = Math.max(
				0,
				cp * ct * sB - cA * ct * sp - sA * st + cB * (cA * st - ct * sA * sp),
			);
		}
	}
	const cell = 2 / grid;
	ctx.font = `700 ${cell * 1.45}px "Geist Mono Variable", "Geist Mono", ui-monospace, monospace`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	light.forEach((value, index) => {
		if (value < 0) return;
		const level = value / Math.SQRT2;
		ctx.globalAlpha = 0.35 + 0.65 * level;
		ctx.fillText(
			ASCII_RAMP[Math.min(ASCII_RAMP.length - 1, Math.floor(level * 12))] ??
				".",
			-1 + (index % grid) * cell + cell / 2,
			-1 + Math.floor(index / grid) * cell + cell / 2,
		);
	});
}

/** Lit point-cloud torus: the tube rolls while the ring turns and tilts. */
function drawPointDonut(
	ctx: ActivityLoaderContext,
	time: number,
	px: number,
	size: number,
): void {
	const tiny = size < 22;
	const around = tiny ? 20 : 26;
	const across = tiny ? 7 : 9;
	const ring = 0.64;
	const tube = 0.23;
	const tilt = 0.72 + 0.16 * Math.sin(time * 0.0009);
	const spin = time * 0.0006;
	const roll = time * 0.0035;
	const points: Array<Projected & { readonly lit: number }> = [];
	for (let i = 0; i < around; i += 1) {
		for (let j = 0; j < across; j += 1) {
			const ph = (i / around) * TAU;
			const th = ((j + (i % 2) * 0.5) / across) * TAU + roll;
			const cp = Math.cos(ph);
			const sp = Math.sin(ph);
			const ct = Math.cos(th);
			const st = Math.sin(th);
			const normal = rotateZ(
				rotateX({ x: ct * cp, y: ct * sp, z: st }, tilt),
				spin,
			);
			if (normal.z <= -0.15) continue;
			const position = rotateZ(
				rotateX(
					{
						x: (ring + tube * ct) * cp,
						y: (ring + tube * ct) * sp,
						z: tube * st,
					},
					tilt,
				),
				spin,
			);
			const lit = Math.max(
				0,
				normal.x * -0.35 + normal.y * -0.55 + normal.z * 0.76,
			);
			points.push({ ...project(position), lit });
		}
	}
	const base = tiny ? 0.068 : 0.054;
	for (const p of points.sort(byDepth)) {
		dot(
			ctx,
			p.x * 0.9,
			p.y * 0.9,
			Math.max(px * 0.75, base * (0.8 + 0.3 * ((p.z + 0.4) / 0.8))),
			0.16 + 0.84 * p.lit ** 1.1,
		);
	}
}

const drawDonut: SceneDraw = (ctx, time, px, size) => {
	if (size >= ASCII_DONUT_MIN_SIZE) drawAsciiDonut(ctx, time);
	else drawPointDonut(ctx, time, px, size);
};

const VORTEX_PARTICLES = Array.from({ length: 46 }, (_, index) => ({
	angle: hash(index, 3) * TAU,
	phase: hash(index, 7),
}));

/** Particles spiralling into a bright core, accelerating as they fall in. */
const drawVortex: SceneDraw = (ctx, time, px) => {
	const at = (angle: number, progress: number) => {
		const radius = 0.92 * (1 - progress) ** 0.85 + 0.04;
		const theta = angle + progress * 5.5 + time * 0.0005;
		return {
			x: Math.cos(theta) * radius,
			y: Math.sin(theta) * radius * 0.92,
			radius,
		};
	};
	ctx.lineCap = "round";
	for (const particle of VORTEX_PARTICLES) {
		const progress = (time * 0.00042 + particle.phase) % 1;
		const tail = at(particle.angle, Math.max(0, progress - 0.035));
		const head = at(particle.angle, progress);
		ctx.globalAlpha = Math.sin(Math.PI * progress) * 0.9;
		ctx.lineWidth = Math.max(px * 0.9, 0.025 + head.radius * 0.03);
		ctx.beginPath();
		ctx.moveTo(tail.x, tail.y);
		ctx.lineTo(head.x, head.y);
		ctx.stroke();
	}
	dot(ctx, 0, 0, Math.max(px * 1.2, 0.09 + 0.02 * Math.sin(time * 0.008)), 1);
};

/** 9×9 dot plane in perspective with ripples spreading from the centre. */
const drawWave: SceneDraw = (ctx, time, px) => {
	const points: Array<Projected & { readonly height: number }> = [];
	for (let j = 0; j < 9; j += 1) {
		for (let i = 0; i < 9; i += 1) {
			const x = -1 + i / 4;
			const z = -1 + j / 4;
			const distance = Math.hypot(x, z);
			const height =
				0.2 * Math.sin(distance * 5 - time * 0.006) * (1 - distance * 0.35);
			const position = rotateX(
				rotateY({ x: x * 0.72, y: height, z: z * 0.72 }, time * 0.00035 + 0.6),
				-0.95,
			);
			points.push({ ...project(position), height });
		}
	}
	for (const p of points.sort(byDepth)) {
		const lift = (p.height + 0.2) / 0.4;
		const depth = (p.z + 0.8) / 1.6;
		dot(
			ctx,
			p.x,
			p.y,
			Math.max(px * 0.7, 0.035 + 0.03 * depth),
			0.15 + 0.85 * lift * (0.5 + 0.5 * depth),
		);
	}
};

/** Dotted Möbius band rolling through space. */
const drawMobius: SceneDraw = (ctx, time, px, size) => {
	const sparse = size < DENSE_MOBIUS_MIN_SIZE;
	const around = sparse ? 24 : 44;
	const across = sparse ? 3 : 5;
	const points: Projected[] = [];
	for (let i = 0; i < around; i += 1) {
		for (let j = 0; j < across; j += 1) {
			const u = (i / around) * TAU;
			const v = -0.42 + (j / (across - 1)) * 0.84;
			const radius = 0.62 + v * 0.5 * Math.cos(u / 2);
			let p: Point = {
				x: radius * Math.cos(u),
				y: radius * Math.sin(u),
				z: v * 0.5 * Math.sin(u / 2),
			};
			p = rotateZ(p, time * 0.0011);
			p = rotateX(
				p,
				(sparse ? 0.5 : 0.62) + (sparse ? 0.18 : 0.3) * Math.sin(time * 0.0007),
			);
			p = rotateY(p, 0.35 * Math.sin(time * 0.0005));
			points.push(project(p));
		}
	}
	for (const p of points.sort(byDepth)) {
		const depth = (p.z + 0.7) / 1.4;
		if (sparse) {
			dot(
				ctx,
				p.x * 0.92,
				p.y * 0.92,
				Math.max(px * 0.85, 0.05 + 0.035 * depth),
				0.14 + 0.86 * depth ** 1.6,
			);
		} else {
			dot(
				ctx,
				p.x,
				p.y,
				Math.max(px * 0.55, 0.026 + 0.026 * depth),
				0.1 + 0.9 * depth * depth,
			);
		}
	}
};

const SCENES: Record<ActivityLoaderScene, SceneDraw> = {
	dither: drawDither,
	helix: drawHelix,
	donut: drawDonut,
	vortex: drawVortex,
	wave: drawWave,
	mobius: drawMobius,
};

/** Clears the backing store and draws one frame of `scene`. */
export function drawActivityLoaderScene(
	ctx: ActivityLoaderContext,
	scene: ActivityLoaderScene,
	frame: ActivityLoaderFrame,
): void {
	const backing = frame.size * frame.pixelRatio;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, backing, backing);
	const half = backing / 2;
	ctx.setTransform(half, 0, 0, half, half, half);
	ctx.globalAlpha = 1;
	ctx.fillStyle = frame.color;
	ctx.strokeStyle = frame.color;
	SCENES[scene](ctx, frame.time, 2 / frame.size, frame.size);
}
